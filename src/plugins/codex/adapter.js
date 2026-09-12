/** Codex AgentRuntime adapter for CLEW-128.
 *
 * Translates the typed `AgentRuntime` port to the existing `CodexHarness`
 * (same class, same protocol behavior) and back. The adapter owns one
 * harness instance per connection: opening a terminal never creates a
 * second writer, it only borrows the single owned harness.
 */

import { execFileSync } from 'node:child_process';
import { PLUGIN_ERROR_CODE, PluginError } from '../errors.js';
import { normalizeUsage } from '../normalize-usage.js';
import { createRuntimeError, validateRuntimeResult } from '../runtime-contract.js';
import { HarnessInterruptedError } from '../../harness-events.js';
import { CodexHarness, codexLaunchError } from './harness.js';
import { CODEX_DEFAULT_CONNECTION_ID, CODEX_RUNTIME_PLUGIN_ID } from './manifest.js';

export const CODEX_CAPABILITIES = Object.freeze([
  'execution.headless',
  'execution.interactive',
  'session.resume',
  'interaction.approval',
  'output.structured',
  'surface.open',
  'usage.reported',
]);

function connectionBin(config) {
  return typeof config?.bin === 'string' && config.bin ? config.bin : 'codex';
}

function mapHarnessError(error, session, bin) {
  // Synchronous spawn throws bypass the harness `error`-event mapping, so
  // normalize here: the port reports one launch code either way.
  const normalized = codexLaunchError(error, bin);
  const code =
    typeof normalized?.code === 'string' && normalized.code
      ? normalized.code
      : 'CODEX_EXECUTION_FAILED';
  const message =
    typeof normalized?.message === 'string' && normalized.message
      ? normalized.message
      : String(normalized);

  if (error instanceof HarnessInterruptedError || code === 'HARNESS_INTERRUPTED')
    return {
      status: 'interrupted',
      session,
      error: createRuntimeError({ code, message, errorClass: 'execution-failure' }),
    };

  const errorClass =
    code === 'HARNESS_TIMED_OUT' || code === 'CODEX_APP_SERVER_TIMEOUT'
      ? 'timeout'
      : code === 'CODEX_EXECUTABLE_NOT_FOUND'
        ? 'configuration'
        : 'execution-failure';

  return {
    status: 'failed',
    session,
    error: createRuntimeError({ code, message, errorClass }),
  };
}

export class CodexAgentRuntime {
  constructor(connection = {}, hostServices = {}) {
    this.connectionId =
      typeof connection.id === 'string' && connection.id
        ? connection.id
        : CODEX_DEFAULT_CONNECTION_ID;
    this.config = { ...(connection.config ?? {}) };
    this.hostServices = { ...hostServices };
    this.harnesses = new Map();
    this.disposed = false;
  }

  describe() {
    return {
      plugin: CODEX_RUNTIME_PLUGIN_ID,
      apiVersion: '1',
      capabilities: [...CODEX_CAPABILITIES],
    };
  }

  async probe() {
    const bin = connectionBin(this.config);
    let version;

    try {
      const output = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();

      version = { ok: true, version: output.split('\n')[0] ?? output };
    } catch (error) {
      version = {
        ok: false,
        detail:
          error?.code === 'ENOENT'
            ? `Codex executable was not found (${bin})`
            : (error?.message ?? String(error)),
      };
    }

    let auth;

    if (version.ok) {
      try {
        const output = execFileSync(bin, ['login', 'status'], {
          encoding: 'utf8',
          timeout: 10_000,
        }).trim();

        auth = { ok: true, detail: output };
      } catch (error) {
        auth = { ok: false, detail: error?.message ?? String(error) };
      }
    } else auth = { ok: false, detail: 'Codex CLI unavailable' };

    return {
      status: version.ok && auth.ok ? 'ready' : 'unavailable',
      connection: this.connectionId,
      bin,
      version,
      auth,
    };
  }

  asLegacyHarness(overrides = {}) {
    if (this.disposed)
      throw new PluginError(
        PLUGIN_ERROR_CODE.INVALID_CONFIG,
        `codex connection "${this.connectionId}" is disposed and accepts no new runs`,
        { connectionId: this.connectionId, pluginId: CODEX_RUNTIME_PLUGIN_ID },
      );

    // One cached harness per model: role models (CLEW-130) get correct
    // defaults without sharing mutable executor state across roles.
    const model = overrides.model !== undefined ? overrides.model : (this.config.model ?? null);
    const key = model ?? '';

    let harness = this.harnesses.get(key);

    if (!harness) {
      const { timeoutMs, interruptTimeoutMs, startupTimeoutMs } = this.config;

      harness = new CodexHarness({
        command: connectionBin(this.config),
        args: this.config.args ?? ['app-server'],
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(interruptTimeoutMs !== undefined ? { interruptTimeoutMs } : {}),
        ...(startupTimeoutMs !== undefined ? { startupTimeoutMs } : {}),
        model,
        openDesktop: this.hostServices.openDesktop ?? false,
        terminalManager: this.hostServices.terminalManager ?? null,
        trustedWorkspaceRoot: this.hostServices.trustedWorkspaceRoot ?? null,
        ...(this.hostServices.spawnImpl ? { spawnImpl: this.hostServices.spawnImpl } : {}),
      });
      this.harnesses.set(key, harness);
    }

    return harness;
  }

  async run(request = {}, hooks = {}) {
    const runId = request.runId;

    if (typeof runId !== 'string' || !runId)
      throw new PluginError(
        PLUGIN_ERROR_CODE.INVALID_CONFIG,
        'codex runtime run requires request.runId',
        { connectionId: this.connectionId, pluginId: CODEX_RUNTIME_PLUGIN_ID },
      );

    const brief = request.brief ?? {};
    const task = brief.task ?? request.task ?? null;
    const executionBrief = brief.executionBrief ?? null;

    if (!task && !executionBrief)
      throw new PluginError(
        PLUGIN_ERROR_CODE.INVALID_CONFIG,
        'codex runtime run requires brief.task or brief.executionBrief',
        { connectionId: this.connectionId, pluginId: CODEX_RUNTIME_PLUGIN_ID },
      );

    const resumeRef = request.resumeSessionRef ?? null;

    if (resumeRef?.runtime && resumeRef.runtime !== 'codex')
      throw new PluginError(
        PLUGIN_ERROR_CODE.INVALID_CONFIG,
        `cannot resume a "${resumeRef.runtime}" session on the codex runtime: native sessions never move between runtimes`,
        { connectionId: this.connectionId, pluginId: CODEX_RUNTIME_PLUGIN_ID },
      );

    const sessionBase = {
      runtime: 'codex',
      connection: this.connectionId,
      host: this.hostServices.hostId ?? 'local',
    };
    const onEvent = (event) => {
      hooks.onEvent?.(event);

      if (event?.type === 'SESSION_STARTED' || event?.type === 'SESSION_RESUMED')
        hooks.onCheckpoint?.({
          runId,
          session: { ...sessionBase, nativeSessionId: event.sessionId ?? null },
        });
    };
    const onApproval = hooks.requestApproval
      ? (approval) =>
          hooks.requestApproval({
            id: approval.id,
            method: approval.method,
            params: approval.params ?? {},
          })
      : undefined;

    try {
      const result = await this.asLegacyHarness().run({
        task,
        executionBrief,
        stageId: brief.stageId ?? 'worker',
        runId,
        cwd: request.workspace?.cwd,
        onEvent,
        model: request.model ?? this.config.model ?? null,
        outputSchema: request.outputSchema,
        readOnly: request.policy?.readOnly === true,
        signal: hooks.signal,
        ...(onApproval ? { onApproval } : {}),
        resumeSessionId: resumeRef?.nativeSessionId ?? null,
        liveEndpoint:
          request.executionMode === 'interactive' ? (request.liveEndpoint ?? null) : null,
      });

      return validateRuntimeResult(
        {
          status: 'completed',
          session: {
            ...sessionBase,
            nativeSessionId: result.sessionId,
            ...(result.turnId ? { turnId: result.turnId } : {}),
          },
          output: {
            verification: result.verification ?? [],
            output: result.output ?? null,
          },
          evidence: [],
          usage: normalizeUsage(result.usage),
        },
        CODEX_RUNTIME_PLUGIN_ID,
      );
    } catch (error) {
      return validateRuntimeResult(
        mapHarnessError(
          error,
          { ...sessionBase, nativeSessionId: null },
          connectionBin(this.config),
        ),
        CODEX_RUNTIME_PLUGIN_ID,
      );
    }
  }

  prepareSurface({ sessionId = null, workspace = null, liveEndpoint = null } = {}) {
    const bin = connectionBin(this.config);

    if (sessionId && liveEndpoint)
      return {
        kind: 'codex-resume',
        bin,
        sessionId,
        workspace,
        liveEndpoint,
        args: ['resume', '--remote', liveEndpoint, sessionId],
      };

    return { kind: 'codex-open', bin, sessionId, workspace, liveEndpoint };
  }

  async dispose() {
    this.harnesses.clear();
    this.disposed = true;
  }
}

export function createCodexAgentRuntime(connection, hostServices = {}) {
  return new CodexAgentRuntime(connection, hostServices);
}
