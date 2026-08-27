import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

export class FakeHarness {
  async run({ task, stageId, cwd, onEvent }) {
    const sessionId = `fake-${randomUUID()}`;
    onEvent({ type: 'SESSION_STARTED', sessionId, stageId });
    onEvent({ type: 'TURN_STARTED', sessionId });
    const evidenceDir = join(cwd, '.clew-runs');
    mkdirSync(evidenceDir, { recursive: true });
    appendFileSync(join(evidenceDir, `${stageId}.log`), `${task.id}/${stageId}\n`);
    onEvent({ type: 'TOOL_COMPLETED', sessionId, tool: 'fixture-write', exitCode: 0 });
    onEvent({
      type: 'VERIFICATION_DETECTED',
      sessionId,
      command: 'clew fixture verification',
      result: 'passed',
    });
    onEvent({ type: 'HARNESS_COMPLETED', sessionId });
    return {
      sessionId,
      verification: [{ type: 'targeted', result: 'passed', command: 'clew fixture verification' }],
    };
  }
}

export class ExternalHarnessUnavailable {
  constructor(name) {
    this.name = name;
  }
  async run() {
    throw new Error(
      `${this.name} adapter is not configured yet; run with --harness fake or configure the native ${this.name} server`,
    );
  }
}

/** Minimal machine-facing Codex app-server adapter. The protocol is deliberately
 * kept here; the domain only receives normalized events. */
export class CodexHarness {
  constructor({
    command = process.env.CLEW_CODEX_BIN || 'codex',
    args = ['app-server'],
    timeoutMs = 30 * 60_000,
  } = {}) {
    this.command = command;
    this.args = args;
    this.timeoutMs = timeoutMs;
  }
  async run({ task, cwd, onEvent, model, outputSchema, readOnly = false }) {
    const child = spawn(this.command, this.args, { cwd, stdio: ['pipe', 'pipe', 'inherit'] });
    const sessionId = `codex-${randomUUID()}`;
    let nextId = 1;
    const pending = new Map();
    let buffer = '';
    let settled = false;
    let timer;
    const finish = (resolve, reject, error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      error ? reject(error) : resolve(value);
    };
    const result = await new Promise((resolve, reject) => {
      timer = setTimeout(
        () => finish(resolve, reject, new Error('Codex app-server timed out')),
        this.timeoutMs,
      );
      const send = (method, params) => {
        const id = nextId++;
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
        return id;
      };
      const notify = (method, params) =>
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
      const handle = (message) => {
        const method = message.method || '';
        const params = message.params || message.result || {};
        if (message.id !== undefined && !method) {
          const resolver = pending.get(message.id);
          pending.delete(message.id);
          if (message.error)
            return finish(
              resolve,
              reject,
              new Error(`Codex request failed: ${message.error.message || message.error.code}`),
            );
          resolver?.(message.result ?? {});
          return;
        }
        if (method === 'turn/completed') {
          onEvent({ type: 'HARNESS_COMPLETED', sessionId, raw: message });
          return finish(resolve, reject, null, {
            sessionId,
            verification: [],
            output: message.result ?? message.params,
          });
        }
        if (message.id !== undefined && method.includes('approval')) {
          child.stdin.write(
            `${JSON.stringify({ id: message.id, result: { decision: 'decline' } })}\n`,
          );
          onEvent({ type: 'APPROVAL_REQUIRED', sessionId, raw: message });
        } else if (method.includes('approval') || method.includes('permission'))
          onEvent({ type: 'APPROVAL_REQUIRED', sessionId, raw: message });
        else if (method.includes('item/started') || method.includes('tool/started'))
          onEvent({ type: 'TOOL_STARTED', sessionId, raw: message });
        else if (method.includes('item/completed') || method.includes('tool/completed'))
          onEvent({ type: 'TOOL_COMPLETED', sessionId, raw: message });
        else if (method) onEvent({ type: 'HARNESS_EVENT', sessionId, method, params });
      };
      child.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          try {
            handle(JSON.parse(line));
          } catch {
            onEvent({ type: 'HARNESS_OUTPUT', sessionId, line });
          }
        }
      });
      child.on('error', (error) =>
        finish(resolve, reject, new Error(`failed to start Codex app-server: ${error.message}`)),
      );
      child.on('exit', (code) => {
        if (!settled)
          finish(resolve, reject, new Error(`Codex app-server exited with code ${code}`));
      });
      const turnParams = (threadId) => ({
        threadId,
        model,
        outputSchema,
        cwd,
        input: [
          {
            type: 'text',
            text: `${task.title}\n\nGoal: ${task.goal}\n\nAcceptance:\n${task.acceptance.map((x) => `- ${x.id}: ${x.criterion}`).join('\n')}`,
          },
        ],
      });
      const initializeId = send('initialize', {
        clientInfo: { name: 'clew', title: 'Clew', version: '0.1.0' },
      });
      pending.set(initializeId, () => {
        notify('initialized', {});
        const threadId = send('thread/start', {
          cwd,
          model,
          sandbox: readOnly ? 'read-only' : undefined,
        });
        pending.set(threadId, (result) => {
          const id = result.thread?.id;
          if (!id)
            return finish(resolve, reject, new Error('Codex thread/start returned no thread id'));
          send('turn/start', turnParams(id));
        });
      });
      onEvent({ type: 'SESSION_STARTED', sessionId });
      onEvent({ type: 'TURN_STARTED', sessionId });
    });
    return result;
  }
}

/** OpenCode HTTP/SSE adapter. Endpoint details stay isolated from Clew. */
export class OpenCodeHarness {
  constructor({
    baseUrl = process.env.CLEW_OPENCODE_URL || 'http://127.0.0.1:4096',
    timeoutMs = 30 * 60_000,
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
  }
  async run({ task, cwd, onEvent }) {
    const session = await this.request('/session', {
      method: 'POST',
      body: { title: task.title, directory: cwd },
    });
    const sessionId = session.id || session.data?.id;
    if (!sessionId) throw new Error('OpenCode did not return a session id');
    onEvent({ type: 'SESSION_STARTED', sessionId });
    onEvent({ type: 'TURN_STARTED', sessionId });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(
        `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/message`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            parts: [{ type: 'text', text: `${task.title}\n\n${task.goal}` }],
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) throw new Error(`OpenCode message failed: HTTP ${response.status}`);
      onEvent({ type: 'HARNESS_COMPLETED', sessionId });
      return { sessionId, verification: [] };
    } finally {
      clearTimeout(timer);
    }
  }
  async request(path, { method = 'GET', body } = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(`OpenCode request failed: HTTP ${response.status}`);
    return response.json();
  }
}
