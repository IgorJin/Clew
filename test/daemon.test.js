import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  daemonLogFile,
  daemonRequest,
  daemonStatus,
  LocalDaemon,
  stopDaemon,
} from '../src/daemon.js';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { URL } from 'node:url';
import WebSocket from 'ws';

function websocketHandshake(endpoint, token, origin) {
  const url = new URL(endpoint);

  return new Promise((resolve, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    let response = '';
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('websocket handshake timed out'));
    }, 1_000);
    const finish = () => {
      clearTimeout(timeout);
      resolve(response);
    };

    socket.once('connect', () => {
      socket.write(
        [
          'GET /?after=0 HTTP/1.1',
          `Host: ${url.host}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          `Authorization: Bearer ${token}`,
          `Origin: ${origin}`,
          '',
          '',
        ].join('\r\n'),
      );
    });
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
      if (response.includes('\r\n\r\n')) {
        socket.end();
        finish();
      }
    });
    socket.once('close', finish);
    socket.once('error', reject);
  });
}

function websocketEvents(metadata, token, untilType) {
  return new Promise((resolve, reject) => {
    const events = [];
    const socket = new WebSocket(`${metadata.endpoint.replace('http:', 'ws:')}/?after=0`, {
      headers: { authorization: `Bearer ${token}`, origin: metadata.endpoint },
      perMessageDeflate: false,
    });
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error(`websocket did not receive ${untilType}`));
    }, 2_000);

    socket.on('message', (body) => {
      const event = JSON.parse(body.toString());

      events.push(event);
      if (event.type === untilType) {
        clearTimeout(timeout);
        socket.close();
        resolve(events);
      }
    });
    socket.on('error', reject);
  });
}

test('live session inspection bypasses a running worker command', async () => {
  const daemon = new LocalDaemon();
  let releaseWorker;
  const worker = new Promise((resolve) => {
    releaseWorker = resolve;
  });

  daemon.control = {
    execute: async (args) => {
      if (args[0] === 'task') {
        await worker;

        return 'worker-finished';
      }

      return 'terminal-opened';
    },
  };
  const running = daemon.dispatch(['task', 'approve-step', 'LIVE-1']);
  const inspected = daemon.dispatch([
    'session',
    'open',
    'LIVE-1',
    '--surface',
    'live',
    '--mode',
    'live',
  ]);

  assert.equal(await inspected, 'terminal-opened');
  releaseWorker();
  assert.equal(await running, 'worker-finished');
});

test('public event filtering suppresses tool and protocol events', async () => {
  const { isPublicThreadEvent } = await import('../src/thread.js');

  assert.equal(isPublicThreadEvent({ type: 'HARNESS_TOOL_COMPLETED' }), false);
  assert.equal(isPublicThreadEvent({ type: 'HARNESS_HARNESS_EVENT' }), false);
  assert.equal(isPublicThreadEvent({ type: 'WORKER_OUTPUT_RECORDED' }), true);
  assert.equal(isPublicThreadEvent({ type: 'TASK_STATE_CHANGED' }), true);
});

test('local daemon authenticates API requests and serializes service commands', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'clew-daemon-'));
  const daemon = new LocalDaemon({ cwd });

  try {
    let metadata;

    try {
      metadata = await daemon.start();
    } catch (error) {
      if (error.code === 'EPERM') return t.skip('sandbox disallows local loopback listeners');
      throw error;
    }
    const unauthorized = await fetch(`${metadata.endpoint}/api/v1/health`);

    assert.equal(unauthorized.status, 401);
    await assert.rejects(() => new LocalDaemon({ cwd }).start(), /already owned/);

    const created = await daemonRequest(cwd, [
      'task',
      'create',
      '--id',
      'DAEMON-1',
      '--title',
      'Daemon',
      '--goal',
      'API',
      '--accept',
      'works',
      '--profile',
      'quick',
    ]);

    assert.equal(created.id, 'DAEMON-1');
    assert.equal((await daemonRequest(cwd, ['task', 'list']))[0].id, 'DAEMON-1');
    assert.equal((await daemonRequest(cwd, ['status', 'DAEMON-1'])).state, 'DRAFT');
    assert.equal((await daemonRequest(cwd, ['task', 'usage', 'DAEMON-1'])).taskId, 'DAEMON-1');
    assert.equal((await daemonRequest(cwd, ['events', 'DAEMON-1']))[0].type, 'TASK_CREATED');
    assert.equal((await daemonRequest(cwd, ['telemetry', 'status'])).state, 'disabled');
    assert.equal(metadata.logFile, daemonLogFile(cwd));
    const logEvents = readFileSync(daemonLogFile(cwd), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).event);

    assert.ok(logEvents.includes('daemon.started'));
    assert.ok(logEvents.includes('command.started'));
    assert.ok(logEvents.includes('command.completed'));
    assert.ok(logEvents.includes('http.request'));

    const token = readFileSync(metadata.tokenFile, 'utf8').trim();
    const legacyCommand = await fetch(`${metadata.endpoint}/api/v1/command`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        requestId: 'legacy-cli-execute',
        kind: 'command',
        name: 'cli.execute',
        payload: { args: ['task', 'list'] },
      }),
    });

    assert.equal(legacyCommand.status, 200);
    const snapshotResponse = await fetch(`${metadata.endpoint}/api/v1/snapshot`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const snapshot = await snapshotResponse.json();

    assert.equal(snapshotResponse.status, 200);
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.tasks.length, 1);
    assert.equal(snapshot.tasks[0].show.id, 'DAEMON-1');
    assert.equal(snapshot.tasks[0].thread.items[0].kind, 'task_created');
    daemon.store.appendEvent('DAEMON-1', 'LARGE_EVENT', { value: 'x'.repeat(70_000) });
    const replay = await websocketEvents(metadata, token, 'LARGE_EVENT');

    assert.equal(replay.at(-1).payload.value.length, 70_000);

    const events = await (
      await fetch(`${metadata.endpoint}/api/v1/events?after=0`, {
        headers: {
          authorization: `Bearer ${token}`,
        },
      })
    ).json();

    assert.equal(events.events[0].type, 'TASK_CREATED');
  } finally {
    await daemon.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('daemon status detects and cleans stale ownership metadata', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'clew-daemon-stale-'));
  const stateDirectory = join(cwd, '.clew');
  const tokenFile = join(stateDirectory, 'daemon.token');

  try {
    mkdirSync(stateDirectory, { recursive: true });
    writeFileSync(join(stateDirectory, 'daemon.lock'), '');
    writeFileSync(tokenFile, 'stale-token\n');
    writeFileSync(
      join(stateDirectory, 'daemon.json'),
      JSON.stringify({
        version: '0.4.0',
        daemonId: 'stale-daemon',
        stateDirectory,
        pid: 999999,
        startedAt: new Date().toISOString(),
        endpoint: 'http://127.0.0.1:1',
        tokenFile,
      }),
    );

    assert.equal((await daemonStatus(cwd)).status, 'stale');
    assert.equal((await stopDaemon(cwd)).status, 'stale-cleaned');
    assert.equal(existsSync(join(stateDirectory, 'daemon.lock')), false);
    assert.equal(existsSync(join(stateDirectory, 'daemon.json')), false);
    assert.equal(existsSync(tokenFile), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('daemon status never removes ownership for a live but unreachable process', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'clew-daemon-unreachable-'));
  const stateDirectory = join(cwd, '.clew');
  const tokenFile = join(stateDirectory, 'daemon.token');
  const lockFile = join(stateDirectory, 'daemon.lock');

  try {
    mkdirSync(stateDirectory, { recursive: true });
    writeFileSync(lockFile, '');
    writeFileSync(tokenFile, 'unreachable-token\n');
    writeFileSync(
      join(stateDirectory, 'daemon.json'),
      JSON.stringify({
        version: '0.4.0',
        daemonId: 'unreachable-daemon',
        stateDirectory,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        endpoint: 'http://127.0.0.1:1',
        tokenFile,
      }),
    );

    assert.equal((await daemonStatus(cwd)).status, 'unreachable');
    await assert.rejects(() => stopDaemon(cwd), /alive but its health endpoint is unreachable/);
    assert.equal(existsSync(lockFile), true);
    assert.equal(existsSync(tokenFile), true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('daemon replay cursor rejects expired cursors and survives restart metadata', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'clew-daemon-cursor-'));
  const daemon = new LocalDaemon({ cwd });

  try {
    let metadata;

    try {
      metadata = await daemon.start();
    } catch (error) {
      if (error.code === 'EPERM') return t.skip('sandbox disallows local loopback listeners');
      throw error;
    }
    const token = (await import('node:fs')).readFileSync(metadata.tokenFile, 'utf8').trim();
    const response = await fetch(`${metadata.endpoint}/api/v1/events?after=-1`, {
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, /cursor/);
  } finally {
    await daemon.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('daemon serves the packaged UI and restricts browser bootstrap to its origin', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'clew-daemon-ui-'));
  const daemon = new LocalDaemon({ cwd });

  try {
    let metadata;

    try {
      metadata = await daemon.start();
    } catch (error) {
      if (error.code === 'EPERM') return t.skip('sandbox disallows local loopback listeners');
      throw error;
    }
    const token = readFileSync(metadata.tokenFile, 'utf8').trim();
    const page = await fetch(`${metadata.endpoint}/`);

    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /<title>Clew \/ Task control plane<\/title>/i);

    const rejected = await fetch(`${metadata.endpoint}/api/v1/bootstrap`, {
      headers: { origin: 'http://malicious.invalid' },
    });

    assert.equal(rejected.status, 403);
    const accepted = await fetch(`${metadata.endpoint}/api/v1/bootstrap`, {
      headers: { origin: metadata.endpoint },
    });

    assert.equal(accepted.status, 204);
    assert.match(accepted.headers.get('set-cookie'), /clew_token=/);
    assert.equal(accepted.headers.get('access-control-allow-origin'), metadata.endpoint);
    assert.equal(token.length, 64);
    assert.equal((await fetch(`${metadata.endpoint}/api/v1/bootstrap`)).status, 403);
    await daemonRequest(cwd, [
      'task',
      'create',
      '--id',
      'DAEMON-UI',
      '--title',
      'Daemon UI',
      '--goal',
      'Load Task Thread',
      '--accept',
      'thread loads',
    ]);
    const cookie = accepted.headers.get('set-cookie').split(';')[0];
    const threadResponse = await fetch(`${metadata.endpoint}/api/v1/command`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        requestId: 'daemon-ui-thread',
        kind: 'command',
        name: 'service.execute',
        payload: { args: ['task', 'thread', 'DAEMON-UI'] },
      }),
    });

    assert.equal(threadResponse.status, 200);
    assert.equal((await threadResponse.json()).payload.version, 1);
    assert.match(
      await websocketHandshake(metadata.endpoint, token, metadata.endpoint),
      /101 Switching Protocols/,
    );
    assert.doesNotMatch(
      await websocketHandshake(metadata.endpoint, token, 'http://malicious.invalid'),
      /101 Switching Protocols/,
    );
  } finally {
    await daemon.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('daemon rejects commands outside the service boundary without crashing', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'clew-daemon-invalid-output-'));
  const daemon = new LocalDaemon({ cwd });

  try {
    let metadata;

    try {
      metadata = await daemon.start();
    } catch (error) {
      if (error.code === 'EPERM') return t.skip('sandbox disallows local loopback listeners');
      throw error;
    }
    await assert.rejects(() => daemonRequest(cwd, ['--help']), /unsupported service command/);
    const token = readFileSync(metadata.tokenFile, 'utf8').trim();
    const health = await fetch(`${metadata.endpoint}/api/v1/health`, {
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(health.status, 200);
  } finally {
    await daemon.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});
