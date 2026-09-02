import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import pty from 'node-pty';
import WebSocket from 'ws';

const MAX_REPLAY_BYTES = 1_000_000;

function frame(type, id, extra = {}) {
  return JSON.stringify({ ch: 'terminal', type, id, ...extra });
}

function safeKill(process) {
  try {
    process?.kill?.();
  } catch {
    // The process may already have exited.
  }
}

function waitForExit(process, timeoutMs = 3_000) {
  if (!process?.once || process.exitCode !== null) return Promise.resolve();

  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };

    process.once('exit', done);
    process.once('error', done);
  });
}

export class TerminalSessionManager {
  constructor({
    spawnPty = pty.spawn,
    spawnProcess = spawn,
    maxReplayBytes = MAX_REPLAY_BYTES,
  } = {}) {
    this.spawnPty = spawnPty;
    this.spawnProcess = spawnProcess;
    this.maxReplayBytes = maxReplayBytes;
    this.sessions = new Map();
    this.pending = new Map();
  }

  begin({ id, taskId, sessionId, cwd, endpoint, serverChild, proxyChild, socketPath }) {
    if (this.sessions.has(id)) return this.describe(id);
    const session = {
      id,
      taskId,
      sessionId,
      cwd,
      endpoint,
      terminal: null,
      mode: 'observing',
      clients: new Set(),
      replay: [],
      replayBytes: 0,
      alive: true,
      released: false,
      exitCode: null,
      interactionStatus: 'starting',
      interactionTurnId: null,
      lastAgentMessage: null,
      interactionUpdatedAt: null,
      finishWaiters: new Set(),
      serverChild,
      proxyChild,
      socketPath,
    };

    this.sessions.set(id, session);
    this.onData(
      session,
      '\r\n\x1b[90m[Clew] Codex worker is running. Interactive input unlocks after the orchestrated turn.\x1b[0m\r\n\r\n',
    );

    return this.describe(id);
  }

  start(options) {
    const session = this.sessions.get(options.id) ?? this.createSession(options);

    session.serverChild = options.serverChild ?? session.serverChild;
    session.proxyChild = options.proxyChild ?? session.proxyChild;
    session.socketPath = options.socketPath ?? session.socketPath;
    session.endpoint = options.endpoint ?? session.endpoint;
    this.startPty(session, options.command, options.args);

    return this.describe(options.id);
  }

  createSession(options) {
    const session = {
      id: options.id,
      taskId: options.taskId,
      sessionId: options.sessionId,
      cwd: options.cwd,
      endpoint: options.endpoint,
      terminal: null,
      mode: 'connecting',
      clients: new Set(),
      replay: [],
      replayBytes: 0,
      alive: true,
      released: false,
      exitCode: null,
      interactionStatus: 'starting',
      interactionTurnId: null,
      lastAgentMessage: null,
      interactionUpdatedAt: null,
      finishWaiters: new Set(),
      serverChild: options.serverChild ?? null,
      proxyChild: options.proxyChild ?? null,
      socketPath: options.socketPath ?? null,
    };

    this.sessions.set(options.id, session);

    return session;
  }

  startPty(session, command, args) {
    if (session.terminal) return;
    const terminal = this.spawnPty(command, args, {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: session.cwd,
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    session.terminal = terminal;
    session.mode = 'interactive';
    session.alive = true;
    session.exitCode = null;
    terminal.onData((data) => this.onData(session, data));
    terminal.onExit(({ exitCode }) => this.onExit(session, exitCode));
    this.broadcast(session, frame('mode', session.id, { mode: session.mode }));
  }

  async startPersisted({ startupTimeoutMs = 10_000, ...options }) {
    if (this.sessions.has(options.id)) return this.describe(options.id);
    if (this.pending.has(options.id)) return this.pending.get(options.id);
    const pending = this.launchPersisted(options, startupTimeoutMs).finally(() =>
      this.pending.delete(options.id),
    );

    this.pending.set(options.id, pending);

    return pending;
  }

  async launchPersisted(options, startupTimeoutMs) {
    const serverChild = await this.launchServer(options, startupTimeoutMs);

    try {
      const result = this.start({ ...options, serverChild, proxyChild: null });

      this.release(options.id);

      return result;
    } catch (error) {
      safeKill(serverChild);
      rmSync(options.socketPath, { force: true });
      throw error;
    }
  }

  async handoff(id, { startupTimeoutMs = 10_000, ...options }) {
    if (this.pending.has(id)) return this.pending.get(id);
    const pending = this.performHandoff(id, options, startupTimeoutMs).finally(() =>
      this.pending.delete(id),
    );

    this.pending.set(id, pending);

    return pending;
  }

  async performHandoff(id, options, startupTimeoutMs) {
    const session = this.sessions.get(id);

    if (!session) return this.launchPersisted({ id, ...options }, startupTimeoutMs);
    session.mode = 'handoff';
    this.broadcast(session, frame('mode', id, { mode: session.mode }));
    this.onData(
      session,
      '\r\n\x1b[90m[Clew] Orchestrated turn finished. Handing the same thread to interactive Codex…\x1b[0m\r\n',
    );
    safeKill(session.proxyChild);
    safeKill(session.serverChild);
    await Promise.all([waitForExit(session.proxyChild), waitForExit(session.serverChild)]);
    rmSync(session.socketPath, { force: true });
    session.proxyChild = null;
    session.serverChild = null;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const serverChild = await this.launchServer(options, startupTimeoutMs);

    session.serverChild = serverChild;
    session.socketPath = options.socketPath;
    session.endpoint = options.endpoint;
    this.startPty(session, options.command, options.args);
    this.release(id);

    return this.describe(id);
  }

  async launchServer(options, startupTimeoutMs) {
    rmSync(options.socketPath, { force: true });
    const serverChild = this.spawnProcess(
      options.command,
      ['app-server', '--listen', options.endpoint],
      {
        cwd: options.cwd,
        stdio: ['ignore', 'ignore', 'inherit'],
      },
    );

    try {
      await new Promise((resolve, reject) => {
        const startedAt = Date.now();
        let settled = false;
        const finish = (error = null) => {
          if (settled) return;
          settled = true;
          clearInterval(timer);
          error ? reject(error) : resolve();
        };
        const timer = setInterval(() => {
          if (existsSync(options.socketPath)) finish();
          else if (Date.now() - startedAt >= startupTimeoutMs)
            finish(new Error('Codex app-server did not create its live terminal socket'));
        }, 20);

        serverChild.once('error', finish);
        serverChild.once('exit', (code) => {
          if (!existsSync(options.socketPath))
            finish(new Error(`Codex app-server exited before terminal startup (${code})`));
        });
      });

      return serverChild;
    } catch (error) {
      safeKill(serverChild);
      rmSync(options.socketPath, { force: true });
      throw error;
    }
  }

  describe(id) {
    const session = this.sessions.get(id);

    if (!session) return null;

    return {
      id: session.id,
      taskId: session.taskId,
      sessionId: session.sessionId,
      cwd: session.cwd,
      endpoint: session.endpoint,
      mode: session.mode,
      alive: session.alive,
      exitCode: session.exitCode,
      interactionStatus: session.interactionStatus,
      interactionTurnId: session.interactionTurnId,
      lastAgentMessage: session.lastAgentMessage,
      interactionUpdatedAt: session.interactionUpdatedAt,
    };
  }

  has(id) {
    return this.sessions.has(id);
  }

  updateInteraction(id, update = {}) {
    const session = this.sessions.get(id);

    if (!session) return false;
    session.interactionStatus = update.status ?? session.interactionStatus;
    session.interactionTurnId = update.turnId ?? session.interactionTurnId;
    if (typeof update.output === 'string' && update.output)
      session.lastAgentMessage = update.output;
    session.interactionUpdatedAt = new Date().toISOString();
    this.broadcast(
      session,
      frame('interaction', id, {
        status: session.interactionStatus,
        turnId: session.interactionTurnId,
        output: session.lastAgentMessage,
        updatedAt: session.interactionUpdatedAt,
      }),
    );

    return true;
  }

  release(id) {
    const session = this.sessions.get(id);

    if (!session) return false;
    session.released = true;
    if (!session.alive) this.cleanup(session);

    return true;
  }

  waitForFinish(id, signal) {
    const session = this.sessions.get(id);

    if (!session) return Promise.reject(new Error('terminal session is unavailable'));
    if (!session.alive) return Promise.resolve({ exitCode: session.exitCode });

    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      const abort = () => {
        session.finishWaiters.delete(waiter);
        reject(new Error('interactive worker was interrupted'));
      };

      waiter.abort = abort;
      waiter.signal = signal;
      session.finishWaiters.add(waiter);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  finish(id) {
    const session = this.sessions.get(id);

    if (!session) return false;
    this.onData(
      session,
      '\r\n\x1b[90m[Clew] Finishing interactive worker and starting verification…\x1b[0m\r\n',
    );
    safeKill(session.terminal);

    return true;
  }

  setSessionIdentity(id, sessionId) {
    const session = this.sessions.get(id);

    if (!session) return false;
    session.sessionId = sessionId;

    return true;
  }

  write(id, data) {
    const session = this.sessions.get(id);

    if (!session || typeof data !== 'string' || !data) return false;
    this.onData(session, data);

    return true;
  }

  attach(client, id) {
    const session = this.sessions.get(id);

    if (!session) {
      client.send(frame('error', id, { error: 'terminal session is unavailable' }));
      client.close(1008, 'terminal unavailable');

      return;
    }
    session.clients.add(client);
    client.send(
      frame('opened', id, {
        cols: session.terminal?.cols ?? 100,
        rows: session.terminal?.rows ?? 30,
        cwd: session.cwd,
        sessionId: session.sessionId,
        mode: session.mode,
      }),
    );
    for (const data of session.replay)
      client.send(frame('data', id, { data: Buffer.from(data).toString('base64') }));
    if (!session.alive) client.send(frame('exited', id, { exitCode: session.exitCode }));
    client.on('message', (value) => this.handleClientMessage(session, client, value));
    client.on('close', () => session.clients.delete(client));
    client.on('error', () => session.clients.delete(client));
  }

  handleClientMessage(session, client, value) {
    let message;

    try {
      message = JSON.parse(String(value));
    } catch {
      client.send(frame('error', session.id, { error: 'invalid terminal frame' }));

      return;
    }
    if (message.ch !== 'terminal' || message.id !== session.id) return;
    if (
      message.type === 'data' &&
      session.mode === 'interactive' &&
      session.alive &&
      session.terminal &&
      typeof message.data === 'string'
    )
      session.terminal.write(Buffer.from(message.data, 'base64').toString());
    else if (message.type === 'resize' && session.alive && session.terminal) {
      const cols = Number(message.cols);
      const rows = Number(message.rows);

      if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0)
        session.terminal.resize(Math.min(cols, 500), Math.min(rows, 200));
    } else if (message.type === 'close') this.close(session.id);
  }

  onData(session, data) {
    session.replay.push(data);
    session.replayBytes += Buffer.byteLength(data);
    while (session.replayBytes > this.maxReplayBytes && session.replay.length > 1) {
      const removed = session.replay.shift();

      session.replayBytes -= Buffer.byteLength(removed);
    }
    this.broadcast(
      session,
      frame('data', session.id, { data: Buffer.from(data).toString('base64') }),
    );
  }

  onExit(session, exitCode) {
    session.alive = false;
    session.mode = 'exited';
    session.exitCode = exitCode;
    this.broadcast(session, frame('exited', session.id, { exitCode }));
    for (const waiter of session.finishWaiters) {
      waiter.signal?.removeEventListener('abort', waiter.abort);
      waiter.resolve({ exitCode });
    }
    session.finishWaiters.clear();
    if (session.released) this.cleanup(session);
  }

  broadcast(session, message) {
    for (const client of session.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  }

  close(id) {
    const session = this.sessions.get(id);

    if (!session) return false;
    session.released = true;
    this.cleanup(session);

    return true;
  }

  cleanup(session) {
    if (!this.sessions.has(session.id)) return;
    safeKill(session.terminal);
    safeKill(session.proxyChild);
    safeKill(session.serverChild);
    if (session.socketPath) rmSync(session.socketPath, { force: true });
    for (const client of session.clients) client.close(1000, 'terminal closed');
    session.clients.clear();
    for (const waiter of session.finishWaiters) {
      waiter.signal?.removeEventListener('abort', waiter.abort);
      waiter.reject(new Error('terminal session was closed'));
    }
    session.finishWaiters.clear();
    this.sessions.delete(session.id);
  }

  closeAll() {
    for (const session of [...this.sessions.values()]) this.cleanup(session);
    this.pending.clear();
  }
}
