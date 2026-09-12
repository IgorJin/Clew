import { TextDecoder } from 'node:util';
import {
  APPROVAL_DECISION,
  HARNESS_EVENT_TYPE,
  HarnessInterruptedError,
  HarnessTimeoutError,
} from '../../harness-events.js';
import { extractUsage } from '../../usage.js';
import { compileHarnessPrompt, ensureExecutionBrief } from '../../execution-brief.js';

/** OpenCode HTTP/SSE adapter (moved verbatim from `src/harness.js` in
 * CLEW-129). Endpoint details stay isolated from Clew; consumers resolve
 * this module through the plugin registry, never by importing harness
 * internals. `src/harness.js` re-exports `OpenCodeHarness` as a
 * compatibility facade until CLEW-133. */

function openCodeModel(value) {
  if (typeof value !== 'string' || !value.includes('/')) return undefined;
  const [providerID, ...modelParts] = value.split('/');
  const modelID = modelParts.join('/');

  return providerID && modelID ? { providerID, modelID } : undefined;
}

/** OpenCode HTTP/SSE adapter. Endpoint details stay isolated from Clew. */
export class OpenCodeHarness {
  constructor({
    baseUrl = process.env.CLEW_OPENCODE_URL || 'http://127.0.0.1:4096',
    timeoutMs = 30 * 60_000,
    fetchImpl = fetch,
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }
  async run({
    task,
    executionBrief = null,
    stageId = 'worker',
    runId = null,
    cwd,
    onEvent,
    signal,
    model = null,
    readOnly = false,
    resumeSessionId = null,
    onApproval = () => APPROVAL_DECISION.DECLINE,
  }) {
    const brief = ensureExecutionBrief({ executionBrief, task, stageId, runId, readOnly });

    task = brief.task;
    if (signal?.aborted) throw new HarnessInterruptedError('OpenCode');
    const sessionResponse = resumeSessionId
      ? null
      : await this.requestJson(`/session?directory=${encodeURIComponent(cwd)}`, {
          method: 'POST',
          body: { title: task.title },
        });
    const sessionId = resumeSessionId || sessionResponse.id || sessionResponse.data?.id;

    if (!sessionId) throw new Error('OpenCode did not return a session id');
    const controller = new AbortController();
    let timedOut = false;
    const interrupt = () => {
      void this.fetch(`${this.baseUrl}/session/${encodeURIComponent(sessionId)}/abort`, {
        method: 'POST',
      }).catch(() => {});
      controller.abort();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    signal?.addEventListener('abort', interrupt, { once: true });
    onEvent({
      type: resumeSessionId
        ? HARNESS_EVENT_TYPE.SESSION_RESUMED
        : HARNESS_EVENT_TYPE.SESSION_STARTED,
      sessionId,
    });
    onEvent({ type: HARNESS_EVENT_TYPE.TURN_STARTED, sessionId });
    if (signal?.aborted) controller.abort();
    try {
      const eventResponse = await this.fetch(
        `${this.baseUrl}/event?directory=${encodeURIComponent(cwd)}`,
        {
          headers: { accept: 'text/event-stream' },
          signal: controller.signal,
        },
      );

      if (eventResponse.ok && eventResponse.body?.getReader)
        return await this.runStreamingTurn({
          executionBrief: brief,
          cwd,
          sessionId,
          eventResponse,
          controller,
          onEvent,
          onApproval,
          model,
        });
      const response = await this.fetch(
        `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/message`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            parts: [{ type: 'text', text: this.buildPrompt(brief) }],
            ...(openCodeModel(model) ? { model: openCodeModel(model) } : {}),
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) throw new Error(`OpenCode message failed: HTTP ${response.status}`);
      const responseBody = await response.json().catch(() => ({}));
      const turnId = responseBody.id || responseBody.data?.id || responseBody.message?.id;

      onEvent({ type: HARNESS_EVENT_TYPE.HARNESS_COMPLETED, sessionId });

      return {
        sessionId,
        turnId,
        verification: this.extractVerification(responseBody),
        usage: extractUsage(responseBody),
        output: responseBody,
      };
    } catch (error) {
      if (timedOut) {
        const timeoutError = new HarnessTimeoutError('OpenCode');

        onEvent({
          type: HARNESS_EVENT_TYPE.HARNESS_TIMED_OUT,
          sessionId,
          error: timeoutError.message,
        });
        throw timeoutError;
      }
      if (signal?.aborted) {
        const interruptedError = new HarnessInterruptedError('OpenCode');

        onEvent({ type: HARNESS_EVENT_TYPE.HARNESS_INTERRUPTED, sessionId });
        throw interruptedError;
      }
      onEvent({ type: HARNESS_EVENT_TYPE.HARNESS_FAILED, sessionId, error: error.message });
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', interrupt);
    }
  }
  async runStreamingTurn({
    executionBrief,
    sessionId,
    eventResponse,
    controller,
    onEvent,
    onApproval,
    model = null,
  }) {
    const promptResponse = await this.fetch(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/prompt_async`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          parts: [{ type: 'text', text: this.buildPrompt(executionBrief) }],
          ...(openCodeModel(model) ? { model: openCodeModel(model) } : {}),
        }),
        signal: controller.signal,
      },
    );

    if (!promptResponse.ok)
      throw new Error(`OpenCode prompt failed: HTTP ${promptResponse.status}`);
    const reader = eventResponse.body.getReader();
    const decoder = new TextDecoder();
    const output = [];
    const verification = [];
    let buffer = '';
    let turnId = null;
    let lastStatusMessage = null;
    let turnObserved = false;

    while (true) {
      const { done, value } = await reader.read();

      if (done) throw new Error('OpenCode event stream ended before session completion');
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);

      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');

        if (!data) continue;
        const event = JSON.parse(data);

        if (!this.isSessionEvent(event, sessionId)) continue;
        const properties = event.properties ?? {};

        if (event.type.startsWith('message.')) {
          turnObserved = true;
          turnId ??=
            properties.messageID ?? properties.info?.id ?? properties.part?.messageID ?? null;
        }
        if (event.type === 'message.part.updated') {
          const part = properties.part ?? {};

          turnObserved = true;

          if (part.type === 'tool') {
            const terminalToolStates = ['completed', 'error'];
            const eventType = terminalToolStates.includes(part.state?.status)
              ? HARNESS_EVENT_TYPE.TOOL_COMPLETED
              : HARNESS_EVENT_TYPE.TOOL_STARTED;

            onEvent({ type: eventType, sessionId, turnId, tool: part.tool, raw: event });
            if (eventType === HARNESS_EVENT_TYPE.TOOL_COMPLETED) {
              const evidence = {
                type: 'command',
                command: part.state?.input?.command ?? part.state?.title ?? part.tool,
                result: part.state?.status === 'completed' ? 'passed' : 'failed',
                output: part.state?.output,
              };

              verification.push(evidence);
              onEvent({
                type: HARNESS_EVENT_TYPE.VERIFICATION_DETECTED,
                sessionId,
                turnId,
                ...evidence,
              });
            }
          } else if (part.type === 'text' && part.text) output.push(part.text);
        } else if (event.type.includes('permission')) {
          const approvalId = properties.id ?? properties.permissionID;

          onEvent({
            type: HARNESS_EVENT_TYPE.APPROVAL_REQUIRED,
            sessionId,
            turnId,
            approvalId,
            raw: event,
          });
          if (approvalId) {
            const decision = await onApproval({
              id: approvalId,
              method: event.type,
              params: properties,
            });
            const response =
              decision === APPROVAL_DECISION.ACCEPT
                ? 'once'
                : decision === APPROVAL_DECISION.ACCEPT_FOR_SESSION
                  ? 'always'
                  : 'reject';

            await this.requestJson(
              `/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(approvalId)}`,
              { method: 'POST', body: { response } },
            );
            onEvent({
              type: HARNESS_EVENT_TYPE.APPROVAL_DECIDED,
              sessionId,
              turnId,
              approvalId,
              decision,
            });
          }
        } else if (event.type === 'session.status') {
          lastStatusMessage = properties.status?.message ?? lastStatusMessage;
          if (['busy', 'retry'].includes(properties.status?.type)) turnObserved = true;
          if (properties.status?.type === 'idle' && turnObserved) {
            onEvent({ type: HARNESS_EVENT_TYPE.HARNESS_COMPLETED, sessionId, turnId });
            controller.abort();

            return {
              sessionId,
              turnId,
              verification,
              usage: extractUsage(properties),
              output: output.join(''),
            };
          }
          onEvent({
            type: HARNESS_EVENT_TYPE.HARNESS_EVENT,
            sessionId,
            turnId,
            method: event.type,
            params: properties,
          });
        } else if (event.type === 'session.error') {
          const message =
            properties.error?.data?.message ??
            properties.error?.message ??
            properties.message ??
            lastStatusMessage ??
            'OpenCode session failed';
          const error = new Error(message);

          if (/connect|provider|api/i.test(message)) error.code = 'EXTERNAL_HARNESS_UNAVAILABLE';
          throw error;
        } else if (event.type === 'session.idle') {
          if (!turnObserved) continue;
          onEvent({ type: HARNESS_EVENT_TYPE.HARNESS_COMPLETED, sessionId, turnId });
          controller.abort();

          return {
            sessionId,
            turnId,
            verification,
            usage: extractUsage(properties),
            output: output.join(''),
          };
        } else if (event.type !== 'server.connected') {
          onEvent({
            type: HARNESS_EVENT_TYPE.HARNESS_EVENT,
            sessionId,
            turnId,
            method: event.type,
            params: properties,
          });
        }
      }
    }
  }
  isSessionEvent(event, sessionId) {
    if (event.type === 'server.connected') return false;
    const properties = event.properties ?? {};
    const eventSessionId =
      properties.sessionID ?? properties.info?.sessionID ?? properties.part?.sessionID;

    return eventSessionId === sessionId;
  }
  extractVerification(responseBody) {
    return (responseBody.parts ?? responseBody.data?.parts ?? [])
      .filter((part) => part.type === 'tool' && ['completed', 'error'].includes(part.state?.status))
      .map((part) => ({
        type: 'command',
        command: part.state?.input?.command ?? part.state?.title ?? part.tool,
        result: part.state.status === 'completed' ? 'passed' : 'failed',
        output: part.state?.output,
      }));
  }
  buildPrompt(executionBrief) {
    return compileHarnessPrompt(executionBrief, { harness: 'opencode' });
  }
  async requestJson(path, { method = 'GET', body } = {}) {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) throw new Error(`OpenCode request failed: HTTP ${response.status}`);

    return response.json();
  }
}
