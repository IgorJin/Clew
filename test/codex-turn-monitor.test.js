import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  CodexTurnMonitor,
  completedTurnStatus,
  stripWorkerStatusMarker,
  WORKER_STATUS_MARKER,
} from '../src/codex-turn-monitor.js';

function fakeCodexProcess(thread) {
  const child = new EventEmitter();

  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stdin.on('data', (chunk) => {
    const request = JSON.parse(String(chunk).trim());
    const result =
      request.method === 'thread/read'
        ? { thread }
        : request.method === 'thread/list'
          ? { data: [thread] }
          : {};

    setTimeout(
      () => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`),
      0,
    );
  });
  child.kill = () => {
    child.exitCode = 0;
    child.emit('exit', 0);
  };

  return child;
}

function waitFor(predicate, timeoutMs = 250) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        reject(new Error('condition was not met'));
      }
    }, 2);
  });
}

test('read-only monitor reports a completed turn once and never writes turn methods', async () => {
  const calls = [];
  const thread = {
    id: 'thread-monitor',
    cwd: '/tmp/monitor-worker',
    turns: [
      {
        id: 'turn-monitor',
        status: 'completed',
        items: [{ type: 'agentMessage', id: 'message-monitor', text: 'Готово, жду вас.' }],
      },
    ],
  };
  const child = fakeCodexProcess(thread);

  child.stdin.on('data', (chunk) => {
    const request = JSON.parse(String(chunk).trim());

    if (request.id !== undefined) calls.push(request.method);
  });
  const updates = [];
  const monitor = new CodexTurnMonitor({
    cwd: thread.cwd,
    threadId: thread.id,
    spawnImpl: () => child,
    pollIntervalMs: 5,
    requestTimeoutMs: 100,
    onUpdate: (update) => updates.push(update),
  });

  monitor.start();
  await new Promise((resolve) => setTimeout(resolve, 25));
  monitor.stop();

  assert.equal(updates.filter((update) => update.status === 'completed').length, 1);
  assert.equal(updates.at(-1).output, 'Готово, жду вас.');
  assert.ok(calls.includes('thread/read'));
  assert.ok(calls.every((method) => ['initialize', 'thread/read'].includes(method)));
});

test('completed turns wait only for the explicit needs-input marker', () => {
  assert.equal(completedTurnStatus('Implemented and verified.'), 'completed');
  assert.equal(
    completedTurnStatus(`Which target should I use?\n${WORKER_STATUS_MARKER.NEEDS_INPUT}`),
    'waiting_for_operator',
  );
  assert.equal(
    stripWorkerStatusMarker(`Implemented and verified.\n${WORKER_STATUS_MARKER.COMPLETE}`),
    'Implemented and verified.',
  );
});

test('interactive monitor ignores the previous completed turn when resuming a thread', async () => {
  const thread = {
    id: 'thread-resumed',
    cwd: '/tmp/monitor-resumed',
    turns: [
      {
        id: 'turn-previous',
        status: 'completed',
        items: [{ type: 'agentMessage', id: 'message-previous', text: 'Previous result.' }],
      },
    ],
  };
  const child = fakeCodexProcess(thread);
  const updates = [];
  const monitor = new CodexTurnMonitor({
    cwd: thread.cwd,
    threadId: thread.id,
    ignoreInitialCompleted: true,
    spawnImpl: () => child,
    pollIntervalMs: 5,
    requestTimeoutMs: 100,
    onUpdate: (update) => updates.push(update),
  });

  monitor.start();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(updates.some((update) => update.status === 'completed'), false);

  thread.turns.push({ id: 'turn-current', status: 'inProgress', items: [] });
  await waitFor(() => updates.some((update) => update.status === 'running'));
  thread.turns.at(-1).status = 'completed';
  thread.turns.at(-1).items.push({ type: 'agentMessage', id: 'message-current', text: 'Current result.' });
  await waitFor(() => updates.some((update) => update.status === 'completed'));
  monitor.stop();

  assert.deepEqual(
    updates.map((update) => update.status),
    ['running', 'completed'],
  );
  assert.equal(updates.at(-1).output, 'Current result.');
});

test('read-only monitor retries discovery until the TUI creates its native thread', async () => {
  const calls = [];
  let listCalls = 0;
  const thread = {
    id: 'thread-after-startup',
    cwd: '/tmp/monitor-startup-race',
    turns: [{ id: 'turn-1', status: 'inProgress', items: [] }],
  };
  const child = new EventEmitter();

  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stdin.on('data', (chunk) => {
    const request = JSON.parse(String(chunk).trim());

    if (request.id === undefined) return;
    calls.push(request.method);
    let result = {};

    if (request.method === 'thread/list') {
      listCalls += 1;
      result = { data: listCalls === 1 ? [] : [thread] };
    } else if (request.method === 'thread/read') result = { thread };
    setTimeout(
      () => child.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`),
      0,
    );
  });
  child.kill = () => child.emit('exit', 0);
  const updates = [];
  const monitor = new CodexTurnMonitor({
    cwd: thread.cwd,
    spawnImpl: () => child,
    pollIntervalMs: 5,
    requestTimeoutMs: 100,
    onUpdate: (update) => updates.push(update),
  });

  monitor.start();
  await waitFor(() => updates.some((update) => update.status === 'running'));
  monitor.stop();

  assert.ok(calls.filter((method) => method === 'thread/list').length >= 2);
  assert.equal(updates.find((update) => update.status === 'running').sessionId, thread.id);
});

test('read-only monitor treats provisional interrupted snapshots as one running transition', async () => {
  const thread = {
    id: 'thread-external-writer',
    cwd: '/tmp/monitor-external-writer',
    turns: [
      {
        id: 'turn-external-writer',
        status: 'interrupted',
        items: [{ type: 'agentMessage', id: 'commentary-1', text: 'Still working.' }],
      },
    ],
  };
  const child = fakeCodexProcess(thread);
  const updates = [];
  const monitor = new CodexTurnMonitor({
    cwd: thread.cwd,
    threadId: thread.id,
    spawnImpl: () => child,
    pollIntervalMs: 5,
    requestTimeoutMs: 100,
    onUpdate: (update) => updates.push(update),
  });

  monitor.start();
  await waitFor(() => updates.some((update) => update.status === 'running'));
  thread.turns[0].items.push({
    type: 'agentMessage',
    id: 'commentary-2',
    text: 'Still working, second update.',
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  thread.turns[0].status = 'completed';
  thread.turns[0].items.push({
    type: 'agentMessage',
    id: 'final-1',
    text: 'Done.',
  });
  await waitFor(() => updates.some((update) => update.status === 'completed'));
  monitor.stop();

  assert.deepEqual(
    updates.map((update) => update.status),
    ['running', 'completed'],
  );
  assert.equal(updates.at(-1).output, 'Done.');
});
