import { spawn } from 'node:child_process';

const NATIVE_STATUS = Object.freeze({
  IN_PROGRESS: 'inProgress',
  COMPLETED: 'completed',
  FAILED: 'failed',
  INTERRUPTED: 'interrupted',
});

function messageText(item) {
  if (typeof item?.text === 'string') return item.text;
  if (!Array.isArray(item?.content)) return null;

  return item.content
    .map((part) => part?.text ?? part?.content ?? '')
    .filter(Boolean)
    .join('\n');
}

function latestAgentMessage(turn) {
  return [...(turn?.items ?? [])].reverse().find((item) => {
    const type = String(item?.type ?? '').toLowerCase();

    return type === 'agentmessage' || type === 'agent_message';
  });
}

function normalizedStatus(status) {
  if (status === NATIVE_STATUS.IN_PROGRESS) return 'running';
  if (status === NATIVE_STATUS.COMPLETED) return 'waiting_for_operator';
  if (status === NATIVE_STATUS.FAILED) return 'failed';
  if (status === NATIVE_STATUS.INTERRUPTED) return 'interrupted';

  return 'starting';
}

function observedTuiStatus(status) {
  // A second app-server process can report an externally-owned, currently
  // running TUI turn as interrupted until the writer persists completion.
  // While the TUI is alive those terminal statuses are provisional; PTY exit
  // remains the authoritative failure/interruption signal for the harness.
  if (status === NATIVE_STATUS.FAILED || status === NATIVE_STATUS.INTERRUPTED) return 'running';

  return normalizedStatus(status);
}

/**
 * Observes a TUI-owned Codex thread through a separate stdio app-server.
 * The reader is deliberately limited to list/read methods and never writes
 * to the native thread or the live Unix socket.
 */
export class CodexTurnMonitor {
  constructor({
    command = process.env.CLEW_CODEX_BIN || 'codex',
    cwd,
    threadId = null,
    spawnImpl = spawn,
    pollIntervalMs = 1_000,
    requestTimeoutMs = 5_000,
    onUpdate = () => {},
    onDiagnostic = () => {},
  } = {}) {
    this.command = command;
    this.cwd = cwd;
    this.threadId = threadId;
    this.spawn = spawnImpl;
    this.pollIntervalMs = pollIntervalMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.onUpdate = onUpdate;
    this.onDiagnostic = onDiagnostic;
    this.child = null;
    this.timer = null;
    this.buffer = '';
    this.nextRequestId = 1;
    this.pending = new Map();
    this.stopped = false;
    this.polling = false;
    this.lastKey = null;
  }

  start() {
    if (this.child || this.stopped) return false;
    this.child = this.spawn(this.command, ['app-server'], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.child.stdout?.on('data', (chunk) => this.onData(chunk));
    this.child.on?.('error', (error) => this.diagnose(error));
    this.child.on?.('exit', (code, signal) => {
      if (!this.stopped && code !== 0)
        this.diagnose(new Error(`Codex turn reader exited (${code ?? signal})`));
    });
    void this.bootstrap();

    return true;
  }

  async bootstrap() {
    try {
      await this.request('initialize', {
        clientInfo: { name: 'clew-turn-monitor', title: 'Clew turn monitor', version: '0.1.0' },
      });
      this.notify('initialized', {});
      this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
      this.timer.unref?.();
      await this.poll();
    } catch (error) {
      this.diagnose(error);
    }
  }

  onData(chunk) {
    this.buffer += chunk.toString();
    let newline;

    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();

      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;

      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id === undefined) continue;
      const pending = this.pending.get(message.id);

      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message ?? 'Codex request failed'));
      else pending.resolve(message.result ?? {});
    }
  }

  request(method, params) {
    if (!this.child || this.stopped)
      return Promise.reject(new Error('Codex turn reader is stopped'));
    const id = this.nextRequestId++;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex turn reader request timed out: ${method}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params) {
    try {
      this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    } catch (error) {
      this.diagnose(error);
    }
  }

  async discoverThread() {
    const listed = await this.request('thread/list', {
      cwd: this.cwd,
      limit: 20,
      sortKey: 'updated_at',
      sortDirection: 'desc',
    });
    const candidates = (listed.data ?? []).filter((thread) => thread?.cwd === this.cwd);

    this.threadId = candidates[0]?.id ?? null;
    if (!this.threadId) throw new Error(`Codex thread was not found for worker cwd: ${this.cwd}`);
    this.emit({ status: 'starting', sessionId: this.threadId, turnId: null });
  }

  async poll() {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      if (!this.threadId) await this.discoverThread();
      const response = await this.request('thread/read', {
        threadId: this.threadId,
        includeTurns: true,
      });
      const thread = response.thread ?? response;
      const turn = thread.turns?.at(-1) ?? null;
      const nativeStatus = turn?.status ?? null;
      const item = latestAgentMessage(turn);
      const output = item ? messageText(item) : null;
      const status = observedTuiStatus(nativeStatus);
      const itemKey = status === 'waiting_for_operator' ? (item?.id ?? '') : '';
      const key = `${thread.id ?? this.threadId}:${turn?.id ?? 'none'}:${status}:${itemKey}`;

      if (key !== this.lastKey) {
        this.lastKey = key;
        this.emit({
          status,
          sessionId: thread.id ?? this.threadId,
          turnId: turn?.id ?? null,
          output,
          itemId: item?.id ?? null,
          nativeStatus,
        });
      }
    } catch (error) {
      this.diagnose(error);
    } finally {
      this.polling = false;
    }
  }

  emit(update) {
    try {
      this.onUpdate(update);
    } catch (error) {
      this.diagnose(error);
    }
  }

  diagnose(error) {
    if (this.stopped) return;
    try {
      this.onDiagnostic(error);
    } catch {
      // Diagnostics must never affect the interactive worker.
    }
  }

  stop() {
    if (this.stopped) return false;
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Codex turn reader stopped'));
    }
    this.pending.clear();
    try {
      this.child?.kill?.();
    } catch {
      // Reader may already have exited.
    }
    this.child = null;

    return true;
  }
}

export { normalizedStatus };
