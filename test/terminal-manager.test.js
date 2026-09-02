import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { TerminalSessionManager } from '../src/terminal-manager.js';

class FakeTerminal {
  constructor() {
    this.cols = 100;
    this.rows = 30;
    this.writes = [];
    this.killed = false;
  }

  onData(callback) {
    this.onDataCallback = callback;
  }

  onExit(callback) {
    this.onExitCallback = callback;
  }

  write(value) {
    this.writes.push(value);
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
  }

  kill() {
    this.killed = true;
  }
}

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.readyState = WebSocket.OPEN;
    this.messages = [];
  }

  send(value) {
    this.messages.push(JSON.parse(value));
  }

  close() {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
}

test('managed terminal replays output, accepts input, and retains app-server until exit', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clew-terminal-manager-'));
  const socketPath = join(directory, 'codex.sock');
  const terminal = new FakeTerminal();
  const killed = [];
  const manager = new TerminalSessionManager({ spawnPty: () => terminal });

  writeFileSync(socketPath, 'fixture');
  manager.start({
    id: 'run-1',
    taskId: 'TASK-1',
    sessionId: 'thread-1',
    command: 'codex',
    args: ['resume', '--remote', `unix://${socketPath}`, 'thread-1'],
    cwd: directory,
    endpoint: `unix://${socketPath}`,
    socketPath,
    serverChild: { kill: () => killed.push('server') },
    proxyChild: { kill: () => killed.push('proxy') },
  });
  terminal.onDataCallback('\u001b[32mready\u001b[0m');
  const client = new FakeClient();

  manager.attach(client, 'run-1');
  assert.deepEqual(
    client.messages.map((message) => message.type),
    ['opened', 'data'],
  );
  client.emit(
    'message',
    JSON.stringify({
      ch: 'terminal',
      type: 'data',
      id: 'run-1',
      data: Buffer.from('continue\r').toString('base64'),
    }),
  );
  client.emit(
    'message',
    JSON.stringify({ ch: 'terminal', type: 'resize', id: 'run-1', cols: 132, rows: 44 }),
  );
  assert.deepEqual(terminal.writes, ['continue\r']);
  assert.equal(terminal.cols, 132);
  assert.equal(terminal.rows, 44);
  assert.equal(manager.release('run-1'), true);
  assert.equal(existsSync(socketPath), true);
  terminal.onExitCallback({ exitCode: 0 });
  assert.deepEqual(killed.sort(), ['proxy', 'server']);
  assert.equal(existsSync(socketPath), false);
  assert.equal(manager.has('run-1'), false);
  rmSync(directory, { recursive: true, force: true });
});

test('finish worker stops the TUI and releases the scheduler wait', async () => {
  const terminal = new FakeTerminal();
  const manager = new TerminalSessionManager({ spawnPty: () => terminal });

  manager.start({
    id: 'run-finish',
    taskId: 'TASK-1',
    sessionId: 'pending-thread',
    command: 'codex',
    args: ['--no-alt-screen', 'Do the task'],
    cwd: process.cwd(),
    endpoint: 'unix:///tmp/clew-finish-fixture.sock',
  });
  const finished = manager.waitForFinish('run-finish');

  assert.equal(manager.finish('run-finish'), true);
  assert.equal(terminal.killed, true);
  terminal.onExitCallback({ exitCode: 0 });
  assert.deepEqual(await finished, { exitCode: 0 });
  manager.close('run-finish');
});

test('active worker is observed before its sole writer is handed to the interactive TUI', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'clew-terminal-handoff-'));
  const socketPath = join(directory, 'codex.sock');
  const events = [];
  const terminal = new FakeTerminal();
  const process = (name) => {
    const child = new EventEmitter();

    child.exitCode = null;
    child.kill = () => {
      events.push(`kill:${name}`);
      child.exitCode = 0;
      child.emit('exit', 0);
    };

    return child;
  };
  const proxy = process('proxy');
  const originalServer = process('original-server');
  const replacementServer = process('replacement-server');
  const manager = new TerminalSessionManager({
    spawnPty: () => {
      events.push('spawn:pty');

      return terminal;
    },
    spawnProcess: () => {
      events.push('spawn:replacement-server');
      setTimeout(() => writeFileSync(socketPath, 'replacement'), 5);

      return replacementServer;
    },
  });

  writeFileSync(socketPath, 'original');
  manager.begin({
    id: 'run-handoff',
    taskId: 'TASK-1',
    sessionId: 'thread-handoff',
    cwd: directory,
    endpoint: `unix://${socketPath}`,
    socketPath,
    serverChild: originalServer,
    proxyChild: proxy,
  });
  const client = new FakeClient();

  manager.attach(client, 'run-handoff');
  client.emit(
    'message',
    JSON.stringify({
      ch: 'terminal',
      type: 'data',
      id: 'run-handoff',
      data: Buffer.from('too early').toString('base64'),
    }),
  );
  assert.deepEqual(terminal.writes, []);
  assert.equal(events.includes('spawn:pty'), false);

  await manager.handoff('run-handoff', {
    command: 'codex',
    args: ['resume', '--remote', `unix://${socketPath}`, 'thread-handoff'],
    cwd: directory,
    endpoint: `unix://${socketPath}`,
    socketPath,
  });

  assert.deepEqual(events.slice(0, 4), [
    'kill:proxy',
    'kill:original-server',
    'spawn:replacement-server',
    'spawn:pty',
  ]);
  assert.deepEqual(
    client.messages.filter(({ type }) => type === 'mode').map(({ mode }) => mode),
    ['handoff', 'interactive'],
  );
  client.emit(
    'message',
    JSON.stringify({
      ch: 'terminal',
      type: 'data',
      id: 'run-handoff',
      data: Buffer.from('continue\r').toString('base64'),
    }),
  );
  assert.deepEqual(terminal.writes, ['continue\r']);
  terminal.onExitCallback({ exitCode: 0 });
  assert.equal(manager.has('run-handoff'), false);
  rmSync(directory, { recursive: true, force: true });
});

test('persisted Codex sessions can be reopened after their worker run finishes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'clew-terminal-reopen-'));
  const socketPath = join(directory, 'codex.sock');
  const terminal = new FakeTerminal();
  const server = new EventEmitter();
  const spawned = [];

  server.kill = () => spawned.push('server-killed');
  const manager = new TerminalSessionManager({
    spawnPty: () => terminal,
    spawnProcess: (command, args) => {
      spawned.push([command, args]);
      setTimeout(() => writeFileSync(socketPath, 'fixture'), 5);

      return server;
    },
  });

  await manager.startPersisted({
    id: 'run-finished',
    taskId: 'TASK-1',
    sessionId: 'thread-finished',
    command: 'codex',
    args: ['resume', '--remote', `unix://${socketPath}`, 'thread-finished'],
    cwd: directory,
    endpoint: `unix://${socketPath}`,
    socketPath,
  });

  assert.equal(manager.has('run-finished'), true);
  assert.deepEqual(spawned[0], ['codex', ['app-server', '--listen', `unix://${socketPath}`]]);
  terminal.onDataCallback('reopened');
  const client = new FakeClient();

  manager.attach(client, 'run-finished');
  assert.equal(
    client.messages.some((message) => message.type === 'data'),
    true,
  );
  terminal.onExitCallback({ exitCode: 0 });
  assert.equal(manager.has('run-finished'), false);
  assert.equal(existsSync(socketPath), false);
  rmSync(directory, { recursive: true, force: true });
});
