import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { TextDecoder } from 'node:util';
import { extractUsage } from './usage.js';

export const HARNESS_EVENT_TYPE = Object.freeze({
  SESSION_STARTED: 'SESSION_STARTED',
  SESSION_RESUMED: 'SESSION_RESUMED',
  TURN_STARTED: 'TURN_STARTED',
  TOOL_STARTED: 'TOOL_STARTED',
  TOOL_COMPLETED: 'TOOL_COMPLETED',
  VERIFICATION_DETECTED: 'VERIFICATION_DETECTED',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  APPROVAL_DECIDED: 'APPROVAL_DECIDED',
  INTERRUPT_REQUESTED: 'INTERRUPT_REQUESTED',
  HARNESS_COMPLETED: 'HARNESS_COMPLETED',
  HARNESS_INTERRUPTED: 'HARNESS_INTERRUPTED',
  HARNESS_TIMED_OUT: 'HARNESS_TIMED_OUT',
  HARNESS_FAILED: 'HARNESS_FAILED',
  HARNESS_EVENT: 'HARNESS_EVENT',
  HARNESS_OUTPUT: 'HARNESS_OUTPUT',
});

export const APPROVAL_DECISION = Object.freeze({
  ACCEPT: 'accept',
  ACCEPT_FOR_SESSION: 'acceptForSession',
  DECLINE: 'decline',
  CANCEL: 'cancel',
});

export const TURN_STATUS = Object.freeze({
  COMPLETED: 'completed',
  FAILED: 'failed',
  INTERRUPTED: 'interrupted',
  IN_PROGRESS: 'inProgress',
});

const APPROVAL_DECISIONS = Object.freeze(Object.values(APPROVAL_DECISION));

function hasInterruptableTurn(interruptRequested, threadId, turnId, settled) {
  return interruptRequested && Boolean(threadId) && Boolean(turnId) && !settled;
}

function isInterruptedTurn(status, interruptRequested) {
  return status === TURN_STATUS.INTERRUPTED || interruptRequested;
}

function isFailedTurn(status) {
  return status === TURN_STATUS.FAILED;
}

function getTurnId(params, currentTurnId) {
  return params.turnId || currentTurnId;
}

function isApprovalRequest(message, method) {
  return message.id !== undefined && method.endsWith('/requestApproval');
}

function isApprovalNotification(method) {
  const normalizedMethod = method.toLowerCase();

  return normalizedMethod.includes('approval') || method.includes('permission');
}

function parseAgentMessageOutput(message) {
  if (!message) return null;
  const trimmedMessage = message.trim();
  const jsonText = trimmedMessage.startsWith('```')
    ? trimmedMessage.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : trimmedMessage;

  try {
    return JSON.parse(jsonText);
  } catch {
    return message;
  }
}

export class HarnessInterruptedError extends Error {
  constructor(harnessName) {
    super(`${harnessName} execution was interrupted`);
    this.name = 'HarnessInterruptedError';
    this.code = 'HARNESS_INTERRUPTED';
  }
}

export class HarnessTimeoutError extends Error {
  constructor(harnessName) {
    super(`${harnessName} execution timed out`);
    this.name = 'HarnessTimeoutError';
    this.code = 'HARNESS_TIMED_OUT';
  }
}

function waitForDelay(delayMs, signal, harnessName) {
  if (!delayMs) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const complete = () => {
      signal?.removeEventListener('abort', interrupt);
      resolve();
    };
    const interrupt = () => {
      clearTimeout(timer);
      reject(new HarnessInterruptedError(harnessName));
    };
    const timer = setTimeout(complete, delayMs);

    signal?.addEventListener('abort', interrupt, { once: true });
  });
}

export class FakeHarness {
  constructor({
    delayMs = 0,
    events = [],
    failures = [],
    approval = null,
    verification = null,
    skippedChecks = [],
    usage = null,
  } = {}) {
    this.delayMs = delayMs;
    this.events = events;
    this.failures = failures;
    this.approval = approval;
    this.verification = verification;
    this.skippedChecks = skippedChecks;
    this.usage = usage;
    this.runCount = 0;
  }

  async run({
    task,
    stageId,
    cwd,
    onEvent,
    signal,
    resumeSessionId = null,
    onApproval = () => APPROVAL_DECISION.DECLINE,
  }) {
    this.runCount += 1;
    const sessionId = resumeSessionId ?? `fake-${task.id}-${stageId}-${this.runCount}`;

    if (signal?.aborted) throw new HarnessInterruptedError('Fake harness');
    onEvent({
      type: resumeSessionId
        ? HARNESS_EVENT_TYPE.SESSION_RESUMED
        : HARNESS_EVENT_TYPE.SESSION_STARTED,
      sessionId,
      stageId,
    });
    onEvent({ type: HARNESS_EVENT_TYPE.TURN_STARTED, sessionId });
    try {
      await waitForDelay(this.delayMs, signal, 'Fake harness');
    } catch (error) {
      onEvent({ type: HARNESS_EVENT_TYPE.HARNESS_INTERRUPTED, sessionId });
      throw error;
    }
    if (this.approval) {
      onEvent({
        type: HARNESS_EVENT_TYPE.APPROVAL_REQUIRED,
        sessionId,
        approvalId: this.approval.id,
        method: this.approval.method,
        params: this.approval.params ?? {},
      });
      const decision = await onApproval(this.approval);

      onEvent({
        type: HARNESS_EVENT_TYPE.APPROVAL_DECIDED,
        sessionId,
        approvalId: this.approval.id,
        decision,
      });
      if (![APPROVAL_DECISION.ACCEPT, APPROVAL_DECISION.ACCEPT_FOR_SESSION].includes(decision))
        throw new Error('Fake harness approval was declined');
    }
    for (const event of this.events) onEvent({ ...event, sessionId });
    const scriptedFailure = this.failures[this.runCount - 1];

    if (scriptedFailure) {
      onEvent({
        type: HARNESS_EVENT_TYPE.HARNESS_FAILED,
        sessionId,
        error: scriptedFailure.message,
      });
      throw scriptedFailure;
    }
    const evidenceDir = join(cwd, '.clew-runs');

    mkdirSync(evidenceDir, { recursive: true });
    appendFileSync(join(evidenceDir, `${stageId}.log`), `${task.id}/${stageId}\n`);
    onEvent({
      type: HARNESS_EVENT_TYPE.TOOL_COMPLETED,
      sessionId,
      tool: 'fixture-write',
      exitCode: 0,
    });
    onEvent({
      type: HARNESS_EVENT_TYPE.VERIFICATION_DETECTED,
      sessionId,
      command: 'clew fixture verification',
      result: 'passed',
    });
    onEvent({ type: HARNESS_EVENT_TYPE.HARNESS_COMPLETED, sessionId });

    const verification = this.verification ?? [
      { type: 'targeted', result: 'passed', command: 'clew fixture verification' },
    ];

    return {
      sessionId,
      verification,
      rationale: 'Deterministic fake harness completed its scripted verification',
      skippedChecks: this.skippedChecks,
      usage: this.usage,
    };
  }
}

export class ExternalHarnessUnavailable {
  constructor(name) {
    this.name = name;
  }
  async run() {
    const error = new Error(
      `${this.name} adapter is not configured yet; run with --harness fake or configure the native ${this.name} server`,
    );

    error.code = 'EXTERNAL_HARNESS_UNAVAILABLE';
    throw error;
  }
}

/** Minimal machine-facing Codex app-server adapter. The protocol is deliberately
 * kept here; the domain only receives normalized events. */
export class CodexHarness {
  constructor({
    command = process.env.CLEW_CODEX_BIN || 'codex',
    args = ['app-server'],
    timeoutMs = 30 * 60_000,
    interruptTimeoutMs = 5_000,
    model = null,
  } = {}) {
    this.command = command;
    this.args = args;
    this.timeoutMs = timeoutMs;
    this.interruptTimeoutMs = interruptTimeoutMs;
    this.model = model;
  }

  async run({
    task,
    cwd,
    onEvent,
    model = this.model,
    outputSchema,
    readOnly = false,
    signal,
    onApproval = () => APPROVAL_DECISION.DECLINE,
    resumeSessionId = null,
  }) {
    if (signal?.aborted) throw new HarnessInterruptedError('Codex');
    const child = spawn(this.command, this.args, { cwd, stdio: ['pipe', 'pipe', 'inherit'] });
    const correlationId = `codex-${randomUUID()}`;
    let nextRequestId = 1;
    const pendingRequests = new Map();
    let stdoutBuffer = '';
    let settled = false;
    let timeoutTimer;
    let interruptTimer;
    let threadId;
    let turnId;
    let interruptRequested = false;
    const verification = [];
    let finalAgentMessage = null;
    let requestInterrupt = () => {};
    const getSessionId = () => threadId || correlationId;
    const settleRequest = (resolve, reject, error, result, terminalEvent) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(interruptTimer);
      signal?.removeEventListener('abort', requestInterrupt);
      if (terminalEvent)
        onEvent({ type: terminalEvent, sessionId: getSessionId(), turnId, error: error?.message });
      child.kill();
      error ? reject(error) : resolve(result);
    };
    const result = await new Promise((resolve, reject) => {
      child.stdin.on('error', (error) => {
        if (settled && ['EPIPE', 'ERR_STREAM_DESTROYED'].includes(error.code)) return;
        settleRequest(resolve, reject, error, null, HARNESS_EVENT_TYPE.HARNESS_FAILED);
      });
      timeoutTimer = setTimeout(
        () =>
          settleRequest(
            resolve,
            reject,
            new HarnessTimeoutError('Codex'),
            null,
            HARNESS_EVENT_TYPE.HARNESS_TIMED_OUT,
          ),
        this.timeoutMs,
      );
      const sendRpcRequest = (method, params) => {
        const id = nextRequestId++;

        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);

        return id;
      };
      const sendRpcNotification = (method, params) =>
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
      const sendInterrupt = () => {
        if (!hasInterruptableTurn(interruptRequested, threadId, turnId, settled)) return;
        onEvent({
          type: HARNESS_EVENT_TYPE.INTERRUPT_REQUESTED,
          sessionId: getSessionId(),
          turnId,
        });
        const requestId = sendRpcRequest('turn/interrupt', { threadId, turnId });

        pendingRequests.set(requestId, () => {});
      };

      requestInterrupt = () => {
        if (interruptRequested || settled) return;
        interruptRequested = true;
        sendInterrupt();
        interruptTimer = setTimeout(
          () =>
            settleRequest(
              resolve,
              reject,
              new HarnessInterruptedError('Codex'),
              null,
              HARNESS_EVENT_TYPE.HARNESS_INTERRUPTED,
            ),
          this.interruptTimeoutMs,
        );
      };
      signal?.addEventListener('abort', requestInterrupt, { once: true });
      const handleServerMessage = (message) => {
        const method = message.method || '';
        const params = message.params || message.result || {};

        if (message.id !== undefined && !method) {
          const resolver = pendingRequests.get(message.id);

          pendingRequests.delete(message.id);
          if (message.error)
            return settleRequest(
              resolve,
              reject,
              new Error(`Codex request failed: ${message.error.message || message.error.code}`),
              null,
              HARNESS_EVENT_TYPE.HARNESS_FAILED,
            );
          resolver?.(message.result ?? {});

          return;
        }
        if (method === 'turn/completed') {
          const status = params.turn?.status || params.status;

          if (isInterruptedTurn(status, interruptRequested))
            return settleRequest(
              resolve,
              reject,
              new HarnessInterruptedError('Codex'),
              null,
              HARNESS_EVENT_TYPE.HARNESS_INTERRUPTED,
            );
          if (isFailedTurn(status)) {
            const failureMessage =
              params.turn?.error?.message ?? params.error?.message ?? 'Codex turn failed';

            return settleRequest(
              resolve,
              reject,
              new Error(failureMessage),
              null,
              HARNESS_EVENT_TYPE.HARNESS_FAILED,
            );
          }

          return settleRequest(
            resolve,
            reject,
            null,
            {
              sessionId: getSessionId(),
              turnId,
              verification,
              output:
                params.output ??
                params.turn?.output ??
                parseAgentMessageOutput(finalAgentMessage) ??
                params,
              usage: extractUsage(params.turn ?? params),
            },
            HARNESS_EVENT_TYPE.HARNESS_COMPLETED,
          );
        }
        if (isApprovalRequest(message, method)) {
          onEvent({
            type: HARNESS_EVENT_TYPE.APPROVAL_REQUIRED,
            sessionId: getSessionId(),
            turnId: getTurnId(params, turnId),
            approvalId: message.id,
            method,
            params,
          });
          Promise.resolve(onApproval({ id: message.id, method, params }))
            .then((decision) => {
              if (!APPROVAL_DECISIONS.includes(decision))
                throw new Error(`unsupported Codex approval decision: ${decision}`);
              if (settled) return;
              child.stdin.write(`${JSON.stringify({ id: message.id, result: { decision } })}\n`);
              onEvent({
                type: HARNESS_EVENT_TYPE.APPROVAL_DECIDED,
                sessionId: getSessionId(),
                turnId: getTurnId(params, turnId),
                approvalId: message.id,
                decision,
              });
            })
            .catch((error) =>
              settleRequest(
                resolve,
                reject,
                error,
                null,
                error.code === 'HARNESS_INTERRUPTED'
                  ? HARNESS_EVENT_TYPE.HARNESS_INTERRUPTED
                  : HARNESS_EVENT_TYPE.HARNESS_FAILED,
              ),
            );
        } else if (isApprovalNotification(method))
          onEvent({
            type: HARNESS_EVENT_TYPE.APPROVAL_REQUIRED,
            sessionId: getSessionId(),
            raw: message,
          });
        else if (method.includes('item/started') || method.includes('tool/started'))
          onEvent({
            type: HARNESS_EVENT_TYPE.TOOL_STARTED,
            sessionId: getSessionId(),
            raw: message,
          });
        else if (method === 'item/completed') {
          const item = params.item ?? {};

          if (item.type === 'agentMessage') finalAgentMessage = item.text;
          else if (item.type === 'commandExecution') {
            const evidence = {
              type: 'command',
              command: item.command,
              result: item.exitCode === 0 ? 'passed' : 'failed',
              exitCode: item.exitCode,
              output: item.aggregatedOutput,
            };

            verification.push(evidence);
            onEvent({
              type: HARNESS_EVENT_TYPE.VERIFICATION_DETECTED,
              sessionId: getSessionId(),
              turnId,
              ...evidence,
            });
          }
          onEvent({
            type: HARNESS_EVENT_TYPE.TOOL_COMPLETED,
            sessionId: getSessionId(),
            raw: message,
          });
        } else if (method.includes('tool/completed'))
          onEvent({
            type: HARNESS_EVENT_TYPE.TOOL_COMPLETED,
            sessionId: getSessionId(),
            raw: message,
          });
        else if (method)
          onEvent({
            type: HARNESS_EVENT_TYPE.HARNESS_EVENT,
            sessionId: getSessionId(),
            method,
            params,
          });
      };

      child.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk.toString();
        let index;

        while ((index = stdoutBuffer.indexOf('\n')) >= 0) {
          const line = stdoutBuffer.slice(0, index).trim();

          stdoutBuffer = stdoutBuffer.slice(index + 1);
          if (!line) continue;
          try {
            handleServerMessage(JSON.parse(line));
          } catch {
            onEvent({ type: HARNESS_EVENT_TYPE.HARNESS_OUTPUT, sessionId: getSessionId(), line });
          }
        }
      });
      child.on('error', (error) =>
        settleRequest(
          resolve,
          reject,
          new Error(`failed to start Codex app-server: ${error.message}`),
          null,
          HARNESS_EVENT_TYPE.HARNESS_FAILED,
        ),
      );
      child.on('exit', (code) => {
        if (!settled)
          settleRequest(
            resolve,
            reject,
            new Error(`Codex app-server exited with code ${code}`),
            null,
            HARNESS_EVENT_TYPE.HARNESS_FAILED,
          );
      });
      const buildTurnStartParams = (threadId) => ({
        threadId,
        model,
        outputSchema,
        cwd,
        input: [
          {
            type: 'text',
            text: `${task.title}\n\nGoal: ${task.goal}\n\nAcceptance:\n${task.acceptance.map((criterion) => `- ${criterion.id}: ${criterion.criterion}`).join('\n')}\n\nBefore completing, run at least one command that verifies the acceptance criteria.`,
          },
        ],
      });
      const initializeId = sendRpcRequest('initialize', {
        clientInfo: { name: 'clew', title: 'Clew', version: '0.1.0' },
      });

      pendingRequests.set(initializeId, () => {
        sendRpcNotification('initialized', {});
        const threadMethod = resumeSessionId ? 'thread/resume' : 'thread/start';
        const threadParams = resumeSessionId
          ? { threadId: resumeSessionId }
          : { cwd, model, sandbox: readOnly ? 'read-only' : undefined };
        const threadRequestId = sendRpcRequest(threadMethod, threadParams);

        pendingRequests.set(threadRequestId, (threadResult) => {
          threadId = threadResult.thread?.id;

          if (!threadId)
            return settleRequest(
              resolve,
              reject,
              new Error('Codex thread/start returned no thread id'),
              null,
              HARNESS_EVENT_TYPE.HARNESS_FAILED,
            );
          onEvent({
            type: resumeSessionId
              ? HARNESS_EVENT_TYPE.SESSION_RESUMED
              : HARNESS_EVENT_TYPE.SESSION_STARTED,
            sessionId: threadId,
          });
          const turnRequestId = sendRpcRequest('turn/start', buildTurnStartParams(threadId));

          pendingRequests.set(turnRequestId, (turnResult) => {
            turnId = turnResult.turn?.id;
            if (!turnId)
              return settleRequest(
                resolve,
                reject,
                new Error('Codex turn/start returned no turn id'),
                null,
                HARNESS_EVENT_TYPE.HARNESS_FAILED,
              );
            onEvent({ type: HARNESS_EVENT_TYPE.TURN_STARTED, sessionId: threadId, turnId });
            sendInterrupt();
          });
        });
      });
    });

    return result;
  }
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
    cwd,
    onEvent,
    signal,
    model = null,
    readOnly = false,
    resumeSessionId = null,
    onApproval = () => APPROVAL_DECISION.DECLINE,
  }) {
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
          task,
          cwd,
          sessionId,
          eventResponse,
          controller,
          onEvent,
          onApproval,
          model,
          readOnly,
        });
      const response = await this.fetch(
        `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/message`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            parts: [{ type: 'text', text: this.buildPrompt(task, readOnly) }],
            ...(model ? { model } : {}),
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
    task,
    sessionId,
    eventResponse,
    controller,
    onEvent,
    onApproval,
    model = null,
    readOnly = false,
  }) {
    const promptResponse = await this.fetch(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/prompt_async`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          parts: [{ type: 'text', text: this.buildPrompt(task, readOnly) }],
          ...(model ? { model } : {}),
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
  buildPrompt(task, readOnly = false) {
    const policy = readOnly
      ? '\n\nREAD-ONLY POLICY: inspect and report only. Do not create, edit, delete, or commit files. Do not run commands that mutate state.'
      : '';

    return `${task.title}\n\nGoal: ${task.goal}\n\nAcceptance:\n${task.acceptance.map((criterion) => `- ${criterion.id}: ${criterion.criterion}`).join('\n')}\n\nBefore completing, run at least one command that verifies the acceptance criteria.${policy}`;
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
