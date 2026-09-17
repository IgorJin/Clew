/** OpenCode AgentRuntime adapter for CLEW-129.
 *
 * Translates the typed `AgentRuntime` port to the existing
 * `OpenCodeHarness` (same class, same server/SSE behavior) and back.
 *
 * Honest capability boundary: the OpenCode endpoint has no verified
 * structured-output mode, no model catalog, no reconcile/inspect, and no
 * terminal open flow. `outputSchema` is therefore refused explicitly
 * before execution instead of being faked; `prepareSurface` and
 * `listModels` are intentionally absent.
 */

import { URL } from 'node:url';
import { PLUGIN_ERROR_CODE, PluginError } from '../errors.js';
import { normalizeUsage } from '../normalize-usage.js';
import { createRuntimeError, validateRuntimeResult } from '../runtime-contract.js';
import { HarnessInterruptedError, HarnessTimeoutError } from '../../harness-events.js';
import { OpenCodeHarness } from './harness.js';
import { OPENCODE_DEFAULT_CONNECTION_ID, OPENCODE_RUNTIME_PLUGIN_ID } from './manifest.js';

export const OPENCODE_CAPABILITIES = Object.freeze([
  'execution.headless',
  'session.resume',
  'interaction.approval',
  'usage.reported',
]);

const AUTH_FAILURE_PATTERN = /auth|unauthorized|api[ -]?key|provider/i;

function connectionBaseUrl(config) {
  return typeof config?.baseUrl === 'string' && config.baseUrl
    ? config.baseUrl
    : 'http://127.0.0.1:4096';
}

function mapHarnessError(error, session) {
  const code =
    typeof error?.code === 'string' && error.code ? error.code : 'OPENCODE_EXECUTION_FAILED';
  const message =
    typeof error?.message === 'string' && error.message ? error.message : String(error);

  if (error instanceof HarnessInterruptedError || code === 'HARNESS_INTERRUPTED')
    return {
      status: 'interrupted',
      session,
      error: createRuntimeError({ code, message, errorClass: 'execution-failure' }),
    };

  let errorClass = 'execution-failure';

  if (error instanceof HarnessTimeoutError || code === 'HARNESS_TIMED_OUT') errorClass = 'timeout';
  else if (error instanceof SyntaxError) errorClass = 'protocol';
  else if (code === 'EXTERNAL_HARNESS_UNAVAILABLE' && AUTH_FAILURE_PATTERN.test(message))
    errorClass = 'authentication';

  return {
    status: 'failed',
    session,
    error: createRuntimeError({ code, message, errorClass }),
  };
}

export class OpenCodeAgentRuntime {
  constructor(connection = {}, hostServices = {}) {
    this.connectionId =
      typeof connection.id === 'string' && connection.id
        ? connection.id
        : OPENCODE_DEFAULT_CONNECTION_ID;
    this.config = { ...(connection.config ?? {}) };
    this.hostServices = { ...hostServices };
    this.harness = null;
    this.disposed = false;
  }

  describe() {
    return {
      plugin: OPENCODE_RUNTIME_PLUGIN_ID,
      apiVersion: '1',
      capabilities: [...OPENCODE_CAPABILITIES],
    };
  }

  async probe() {
    const baseUrl = connectionBaseUrl(this.config);
    let url;

    try {
      url = new URL(baseUrl);
    } catch {
      return {
        status: 'unavailable',
        connection: this.connectionId,
        baseUrl,
        health: { ok: false, detail: 'invalid URL' },
      };
    }

    if (!['http:', 'https:'].includes(url.protocol))
      return {
        status: 'unavailable',
        connection: this.connectionId,
        baseUrl,
        health: { ok: false, detail: 'invalid URL' },
      };

    const fetchImpl = this.hostServices.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    try {
      const response = await fetchImpl(new URL('/global/health', url), {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      const body = await response.json().catch(() => ({}));
      const healthy = response.ok === true && body.healthy === true;

      return {
        status: healthy ? 'ready' : 'unavailable',
        connection: this.connectionId,
        baseUrl,
        health: {
          ok: response.ok === true,
          healthy,
          ...(typeof body.version === 'string' ? { version: body.version } : {}),
        },
      };
    } catch (error) {
      return {
        status: 'unavailable',
        connection: this.connectionId,
        baseUrl,
        health: { ok: false, detail: error?.message ?? String(error) },
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  asLegacyHarness() {
    if (this.disposed)
      throw new PluginError(
        PLUGIN_ERROR_CODE.INVALID_CONFIG,
        `opencode connection "${this.connectionId}" is disposed and accepts no new runs`,
        { connectionId: this.connectionId, pluginId: OPENCODE_RUNTIME_PLUGIN_ID },
      );

    // OpenCode takes the model per run (see run() below), so one harness
    // instance serves every model on this connection.
    if (!this.harness) {
      this.harness = new OpenCodeHarness({
        baseUrl: connectionBaseUrl(this.config),
        ...(this.config.timeoutMs !== undefined ? { timeoutMs: this.config.timeoutMs } : {}),
        ...(this.hostServices.fetchImpl ? { fetchImpl: this.hostServices.fetchImpl } : {}),
      });
    }

    return this.harness;
  }

  async run(request = {}, hooks = {}) {
    const runId = request.runId;

    if (typeof runId !== 'string' || !runId)
      throw new PluginError(
        PLUGIN_ERROR_CODE.INVALID_CONFIG,
        'opencode runtime run requires request.runId',
        { connectionId: this.connectionId, pluginId: OPENCODE_RUNTIME_PLUGIN_ID },
      );

    if (request.outputSchema !== undefined && request.outputSchema !== null)
      throw new PluginError(
        PLUGIN_ERROR_CODE.UNSUPPORTED_CAPABILITY,
        `connection "${this.connectionId}" does not support structured output: the OpenCode endpoint has no verified schema-output mode and Clew will not fabricate one`,
        { connectionId: this.connectionId, pluginId: OPENCODE_RUNTIME_PLUGIN_ID },
      );

    const brief = request.brief ?? {};
    const task = brief.task ?? request.task ?? null;
    const executionBrief = brief.executionBrief ?? null;

    if (!task && !executionBrief)
      throw new PluginError(
        PLUGIN_ERROR_CODE.INVALID_CONFIG,
        'opencode runtime run requires brief.task or brief.executionBrief',
        { connectionId: this.connectionId, pluginId: OPENCODE_RUNTIME_PLUGIN_ID },
      );

    const resumeRef = request.resumeSessionRef ?? null;

    if (resumeRef?.runtime && resumeRef.runtime !== 'opencode')
      throw new PluginError(
        PLUGIN_ERROR_CODE.INVALID_CONFIG,
        `cannot resume a "${resumeRef.runtime}" session on the opencode runtime: native sessions never move between runtimes`,
        { connectionId: this.connectionId, pluginId: OPENCODE_RUNTIME_PLUGIN_ID },
      );

    const sessionBase = {
      runtime: 'opencode',
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
        readOnly: request.policy?.readOnly === true,
        signal: hooks.signal,
        ...(onApproval ? { onApproval } : {}),
        resumeSessionId: resumeRef?.nativeSessionId ?? null,
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
        OPENCODE_RUNTIME_PLUGIN_ID,
      );
    } catch (error) {
      return validateRuntimeResult(
        mapHarnessError(error, { ...sessionBase, nativeSessionId: null }),
        OPENCODE_RUNTIME_PLUGIN_ID,
      );
    }
  }

  async dispose() {
    this.harness = null;
    this.disposed = true;
  }
}

export function createOpenCodeAgentRuntime(connection, hostServices = {}) {
  return new OpenCodeAgentRuntime(connection, hostServices);
}
