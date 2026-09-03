import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { validateOpenSessionRequest, validateOpenSessionResult } from './control-plane.js';
import { createCodexLiveEndpoint } from './runtime.js';

export const SESSION_SURFACE_CAPABILITIES = Object.freeze([
  'open',
  'resume',
  'interrupt',
  'inspect',
  'send_message',
]);

function unavailable(request, reason, code = 'SESSION_SURFACE_UNAVAILABLE') {
  return validateOpenSessionResult({
    version: 1,
    taskId: request.taskId,
    stageId: request.stageId ?? null,
    runId: request.runId ?? null,
    role: request.role,
    harness: request.harness,
    sessionId: request.sessionId ?? 'unavailable',
    turnId: request.turnId ?? null,
    state: 'unavailable',
    capabilities: [],
    reason,
    code,
  });
}

export function assertWorkspace(workspace) {
  if (typeof workspace !== 'string' || !isAbsolute(workspace))
    throw new Error('session.workspace must be an absolute path');
  if (!existsSync(workspace) || !statSync(workspace).isDirectory())
    throw new Error(`session workspace does not exist: ${workspace}`);

  return resolve(workspace);
}

export function buildCodexResumeArgs({ sessionId, model = null } = {}) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{1,127}$/.test(sessionId))
    throw new Error('sessionId contains unsafe characters');
  const args = ['resume', sessionId];

  if (model !== null) {
    if (typeof model !== 'string' || !model.trim() || /[\0\r\n]/.test(model))
      throw new Error('session model is invalid');
    args.push('--model', model);
  }

  return args;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\\"'\\\"'")}'`;
}

export function openMacTerminal({ codexBin, args, workspace, spawnImpl = spawn }) {
  const command = [codexBin, ...args].map(shellQuote).join(' ');
  const script = `tell application "Terminal" to do script ${JSON.stringify(
    `cd ${shellQuote(workspace)} && ${command}`,
  )}`;
  const child = spawnImpl('osascript', ['-e', script], {
    stdio: 'ignore',
    detached: true,
  });

  child.unref();

  return child;
}

export function openWorkspaceInEditor({ editorBin = 'code', workspace, launcher = null } = {}) {
  let resolved;

  try {
    resolved = assertWorkspace(workspace);
  } catch (error) {
    return { state: 'unavailable', reason: error.message, code: 'WORKSPACE_INVALID' };
  }
  if (typeof editorBin !== 'string' || !editorBin.trim() || /[\0\r\n]/.test(editorBin))
    return { state: 'unavailable', reason: 'editor binary is invalid', code: 'EDITOR_INVALID' };

  const command = editorBin.trim();
  const args = [resolved];

  try {
    const child =
      launcher?.(command, args, {
        cwd: resolved,
        shell: false,
        stdio: 'ignore',
        detached: true,
      }) ?? spawn(command, args, { cwd: resolved, stdio: 'ignore', detached: true });

    if (!child)
      return {
        state: 'unavailable',
        reason: 'no editor launcher is available',
        code: 'EDITOR_UNAVAILABLE',
      };
    child.on?.('error', () => {});
    child.unref?.();

    return {
      state: 'opened',
      workspace: resolved,
      command: [command, ...args],
      pid: child.pid ?? null,
    };
  } catch (error) {
    return {
      state: 'unavailable',
      reason: error instanceof Error ? error.message : 'editor failed to start',
      code: 'EDITOR_UNAVAILABLE',
    };
  }
}

export class LiveThreadTerminalSurface {
  constructor({ codexBin = 'codex', launcher = null } = {}) {
    this.codexBin = codexBin;
    this.launcher = launcher;
  }

  capabilities() {
    return ['open', 'inspect'];
  }

  open(request) {
    const normalized = validateOpenSessionRequest(request);

    if (normalized.harness !== 'codex')
      return Promise.resolve(
        unavailable(
          normalized,
          'live terminal attach is only supported for Codex workers',
          'UNSUPPORTED_HARNESS',
        ),
      );
    if (!normalized.sessionId)
      return Promise.resolve(
        unavailable(normalized, 'Codex is still starting the worker thread', 'SESSION_ID_MISSING'),
      );
    if (!normalized.liveEndpoint)
      return Promise.resolve(
        unavailable(normalized, 'live Codex endpoint is unavailable', 'LIVE_ENDPOINT_MISSING'),
      );
    let workspace;

    try {
      workspace = assertWorkspace(normalized.workspace);
    } catch (error) {
      return Promise.resolve(unavailable(normalized, error.message, 'WORKSPACE_INVALID'));
    }
    const args = ['resume', '--remote', normalized.liveEndpoint, normalized.sessionId];
    const child =
      this.launcher?.(this.codexBin, args, {
        cwd: workspace,
        shell: false,
        stdio: 'inherit',
        detached: false,
      }) ??
      (process.platform === 'darwin'
        ? openMacTerminal({ codexBin: this.codexBin, args, workspace })
        : null);

    if (!child)
      return unavailable(normalized, 'live Codex TUI is only supported with a terminal launcher');

    return Promise.resolve(
      validateOpenSessionResult({
        version: 1,
        taskId: normalized.taskId,
        stageId: normalized.stageId ?? null,
        runId: normalized.runId ?? null,
        role: normalized.role,
        harness: normalized.harness,
        sessionId: normalized.sessionId,
        turnId: normalized.turnId ?? null,
        state: 'opened',
        capabilities: this.capabilities(),
        pid: child.pid ?? null,
        command: [this.codexBin, ...args],
        workspace,
        endpoint: normalized.liveEndpoint,
      }),
    );
  }
}

export class NoneSurface {
  capabilities() {
    return [];
  }

  async open(request) {
    return unavailable(request, 'no compatible terminal surface is configured');
  }
}

export class PlainTerminalSurface {
  constructor({ codexBin = 'codex', launcher = null } = {}) {
    this.codexBin = codexBin;
    this.launcher = launcher;
  }

  capabilities(harness = 'codex') {
    return harness === 'codex' ? ['open', 'resume', 'inspect'] : [];
  }

  open(request) {
    const normalized = validateOpenSessionRequest(request);

    if (normalized.harness !== 'codex')
      return Promise.resolve(
        unavailable(
          normalized,
          'plain terminal attach is not supported for this harness',
          'UNSUPPORTED_HARNESS',
        ),
      );
    if (!normalized.sessionId)
      return Promise.resolve(
        unavailable(normalized, 'native session id is missing', 'SESSION_ID_MISSING'),
      );
    let workspace;

    try {
      workspace = assertWorkspace(normalized.workspace);
    } catch (error) {
      return Promise.resolve(unavailable(normalized, error.message, 'WORKSPACE_INVALID'));
    }
    let args;

    try {
      args = buildCodexResumeArgs({
        sessionId: normalized.sessionId,
        model: normalized.model ?? null,
      });
    } catch (error) {
      return Promise.resolve(unavailable(normalized, error.message, 'SESSION_ID_INVALID'));
    }
    const child =
      this.launcher?.(this.codexBin, args, {
        cwd: workspace,
        shell: false,
        stdio: 'inherit',
        detached: false,
      }) ??
      (process.platform === 'darwin'
        ? openMacTerminal({ codexBin: this.codexBin, args, workspace })
        : this.launcher?.(this.codexBin, args, {
            cwd: workspace,
            shell: false,
            stdio: 'inherit',
            detached: false,
          }));

    if (!child) return unavailable(normalized, 'no terminal launcher is available');

    return Promise.resolve(
      validateOpenSessionResult({
        version: 1,
        taskId: normalized.taskId,
        stageId: normalized.stageId ?? null,
        runId: normalized.runId ?? null,
        role: normalized.role,
        harness: normalized.harness,
        sessionId: normalized.sessionId,
        turnId: normalized.turnId ?? null,
        state: normalized.mode === 'resume' ? 'resumed' : 'opened',
        capabilities: this.capabilities(normalized.harness),
        pid: child.pid ?? null,
        command: [this.codexBin, ...args],
        workspace,
      }),
    );
  }
}

export function createSessionSurface({ kind = 'plain', codexBin } = {}) {
  if (kind === 'none') return new NoneSurface();
  if (kind === 'plain') return new PlainTerminalSurface({ codexBin });
  if (kind === 'live') return new LiveThreadTerminalSurface({ codexBin });
  throw new Error(`unsupported session surface: ${kind}`);
}

export async function openSessionForRun(store, request, surface = new NoneSurface()) {
  const task = store.getTask(request.taskId);

  if (!task) return unavailable(request, `task not found: ${request.taskId}`, 'TASK_NOT_FOUND');

  // For architect/reviewer roles, look up stored agent sessions instead of runs
  if (request.role === 'architect' || request.role === 'reviewer') {
    const agentSession = store.getAgentSession(request.taskId, request.role);

    if (!agentSession)
      return unavailable(
        request,
        `no stored ${request.role} session found`,
        'AGENT_SESSION_NOT_FOUND',
      );

    return surface.open({
      ...request,
      runId: null,
      sessionId: agentSession.session_id,
      turnId: null,
      workspace: agentSession.workspace ?? task.contract.workspace ?? process.cwd(),
      model: request.model ?? task.contract.models?.[request.role] ?? null,
    });
  }

  const runs = store.listRuns(request.taskId, { stageId: request.stageId ?? null });
  const run = request.runId
    ? runs.find((candidate) => candidate.id === request.runId)
    : runs.at(-1);

  if (!run)
    return unavailable(request, 'no persisted run matches the requested session', 'RUN_NOT_FOUND');
  if (request.mode === 'live')
    return surface.open({
      ...request,
      runId: run.id,
      sessionId: run.session_id,
      turnId: run.turn_id,
      workspace: run.workspace,
      liveEndpoint: run.runtimeNamespace ? createCodexLiveEndpoint(run.runtimeNamespace) : null,
      model: request.model ?? task.contract.models?.[request.role] ?? null,
    });
  if (!run.session_id)
    return unavailable(
      { ...request, runId: run.id },
      'run has no native session id',
      'SESSION_ID_MISSING',
    );
  if (run.status === 'RUNNING' && request.mode !== 'live')
    return unavailable(
      { ...request, runId: run.id, sessionId: run.session_id },
      'native session is busy; wait for the active turn to finish before resuming it',
      'SESSION_ACTIVE',
    );
  if (request.sessionId && request.sessionId !== run.session_id)
    return unavailable(
      { ...request, runId: run.id },
      'requested session id does not match the persisted run',
      'SESSION_ID_MISMATCH',
    );

  return surface.open({
    ...request,
    runId: run.id,
    sessionId: run.session_id,
    turnId: run.turn_id,
    workspace: run.workspace,
    model: request.model ?? task.contract.models?.[request.role] ?? null,
  });
}
