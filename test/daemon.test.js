import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonRequest, LocalDaemon } from '../src/daemon.js';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { URL } from 'node:url';

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

test('local daemon authenticates API requests and serializes CLI commands', async (t) => {
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
    assert.throws(() => new LocalDaemon({ cwd }).start(), /already owned/);

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

    const events = await (
      await fetch(`${metadata.endpoint}/api/v1/events?after=0`, {
        headers: {
          authorization: `Bearer ${await import('node:fs').then(({ readFileSync }) => readFileSync(metadata.tokenFile, 'utf8').trim())}`,
        },
      })
    ).json();

    assert.equal(events.events[0].type, 'TASK_CREATED');
  } finally {
    await daemon.stop();
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
        name: 'cli.execute',
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

test('daemon contains invalid CLI output instead of crashing', async (t) => {
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
    await assert.rejects(() => daemonRequest(cwd, ['--help']), /invalid JSON/);
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
