import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { validateOpenSessionRequest, validateOpenSessionResult } from './control-plane.js';

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

export class NoneSurface {
  capabilities() {
    return [];
  }

  async open(request) {
    return unavailable(request, 'no compatible terminal surface is configured');
  }
}

export class PlainTerminalSurface {
  constructor({ codexBin = 'codex', launcher = spawn } = {}) {
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
    const child = this.launcher(this.codexBin, args, {
      cwd: workspace,
      shell: false,
      stdio: 'inherit',
      detached: false,
    });

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
  throw new Error(`unsupported session surface: ${kind}`);
}

export async function openSessionForRun(store, request, surface = new NoneSurface()) {
  const task = store.getTask(request.taskId);

  if (!task) return unavailable(request, `task not found: ${request.taskId}`, 'TASK_NOT_FOUND');
  const runs = store.listRuns(request.taskId, { stageId: request.stageId ?? null });
  const run = request.runId
    ? runs.find((candidate) => candidate.id === request.runId)
    : runs.at(-1);

  if (!run)
    return unavailable(request, 'no persisted run matches the requested session', 'RUN_NOT_FOUND');
  if (!run.session_id)
    return unavailable(
      { ...request, runId: run.id },
      'run has no native session id',
      'SESSION_ID_MISSING',
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
