import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { ControllerRunnerGateway } from '../src/controller-runner-gateway.js';
import { Store } from '../src/store.js';
import { RUNNER_MESSAGE_KIND, createRunnerEnvelope } from '../src/runner-protocol.js';

async function createFixture(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'clew-runner-gateway-'));
  const store = new Store(join(directory, 'state.sqlite'));
  const server = createServer();
  const gateway = new ControllerRunnerGateway({
    store,
    credential: 'correct-horse-battery-staple',
    runnerId: 'runner-1',
    requiredCapabilities: ['execute'],
    registrationTimeoutMs: 200,
    productVersion: '0.6.0',
    ...options,
  });

  gateway.attach(server);
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  } catch (error) {
    gateway.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  const address = server.address();

  return {
    store,
    gateway,
    url: `ws://127.0.0.1:${address.port}/runner/v1`,
    async close() {
      gateway.close();
      await new Promise((resolve) => server.close(resolve));
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function createFixtureOrSkip(t, options = {}) {
  try {
    return await createFixture(options);
  } catch (error) {
    if (error?.code === 'EPERM') {
      t.skip('sandbox disallows local loopback listeners');

      return null;
    }
    throw error;
  }
}

function registration(messageId = 'registration-message') {
  return createRunnerEnvelope({
    kind: RUNNER_MESSAGE_KIND.REGISTER,
    messageId,
    idempotencyKey: messageId,
    correlationId: messageId,
    payload: {
      runnerId: 'runner-1',
      productVersion: '0.6.0',
      protocolVersions: [1],
      capabilities: ['execute'],
      workspaces: [{ id: 'clew' }],
    },
  });
}

function connect(url, credential = 'correct-horse-battery-staple') {
  return new WebSocket(url, { headers: { Authorization: `Bearer ${credential}` } });
}

async function nextJson(webSocket) {
  const [data] = await once(webSocket, 'message');

  return JSON.parse(data.toString('utf8'));
}

test('authenticates upgrade and requires registration before operational frames', async (t) => {
  const fixture = await createFixtureOrSkip(t);

  if (!fixture) return;

  try {
    const unauthorized = connect(fixture.url, 'wrong');
    const [error] = await once(unauthorized, 'error');

    assert.match(error.message, /401/);
    const webSocket = connect(fixture.url);

    await once(webSocket, 'open');
    webSocket.send(
      JSON.stringify(
        createRunnerEnvelope({
          kind: RUNNER_MESSAGE_KIND.HEARTBEAT,
          messageId: 'heartbeat-message',
          idempotencyKey: 'heartbeat-key',
          correlationId: 'connection-before-registration',
          payload: { runnerId: 'runner-1', connectionId: 'not-registered' },
        }),
      ),
    );
    const [code] = await once(webSocket, 'close');

    assert.equal(code, 1008);
    assert.equal(fixture.store.getRunnerProjection(), null);
  } finally {
    await fixture.close();
  }
});

test('registers configured Runner and commits inbound frame before ACK', async (t) => {
  const fixture = await createFixtureOrSkip(t);

  if (!fixture) return;

  try {
    const webSocket = connect(fixture.url);

    await once(webSocket, 'open');
    webSocket.send(JSON.stringify(registration()));
    const registered = await nextJson(webSocket);

    assert.equal(registered.kind, RUNNER_MESSAGE_KIND.REGISTERED);
    assert.equal(registered.payload.runnerId, 'runner-1');
    const heartbeat = createRunnerEnvelope({
      kind: RUNNER_MESSAGE_KIND.HEARTBEAT,
      messageId: 'heartbeat-message',
      idempotencyKey: 'heartbeat-key',
      correlationId: registered.payload.connectionId,
      payload: {
        runnerId: 'runner-1',
        connectionId: registered.payload.connectionId,
      },
    });

    webSocket.send(JSON.stringify(heartbeat));
    const ack = await nextJson(webSocket);

    assert.equal(ack.kind, RUNNER_MESSAGE_KIND.ACK);
    assert.equal(ack.payload.ackedMessageId, 'heartbeat-message');
    assert.ok(
      fixture.store.db
        .prepare('SELECT message_id FROM runner_inbox WHERE message_id=?')
        .get('heartbeat-message'),
    );
    assert.equal(fixture.gateway.status().runner.healthStatus, 'healthy');
    assert.equal('credential' in fixture.gateway.status(), false);
    webSocket.close();
    await once(webSocket, 'close');
  } finally {
    await fixture.close();
  }
});

test('latest valid registration deterministically supersedes the previous socket', async (t) => {
  const fixture = await createFixtureOrSkip(t);

  if (!fixture) return;

  try {
    const first = connect(fixture.url);

    await once(first, 'open');
    first.send(JSON.stringify(registration('registration-one')));
    await nextJson(first);
    const firstClosed = once(first, 'close');
    const second = connect(fixture.url);

    await once(second, 'open');
    second.send(JSON.stringify(registration('registration-two')));
    await nextJson(second);
    const [code] = await firstClosed;

    assert.equal(code, 4001);
    assert.equal(fixture.gateway.status().connected, true);
    assert.equal(fixture.store.getRunnerProjection().connectionGeneration, 2);
    second.close();
    await once(second, 'close');
  } finally {
    await fixture.close();
  }
});

test('rejects product skew before registration mutates Controller state', async (t) => {
  const fixture = await createFixtureOrSkip(t);

  if (!fixture) return;

  try {
    const webSocket = connect(fixture.url);

    await once(webSocket, 'open');
    const incompatible = registration('incompatible-product');

    incompatible.payload.productVersion = '0.7.0';
    webSocket.send(JSON.stringify(incompatible));
    const [code] = await once(webSocket, 'close');

    assert.equal(code, 1008);
    assert.equal(fixture.store.getRunnerProjection(), null);
  } finally {
    await fixture.close();
  }
});

test('heartbeat timeout disconnects the Runner and preserves ambiguous lease ownership', async (t) => {
  const fixture = await createFixtureOrSkip(t, { heartbeatTimeoutMs: 50 });

  if (!fixture) return;

  try {
    const webSocket = connect(fixture.url);

    await once(webSocket, 'open');
    webSocket.send(JSON.stringify(registration('heartbeat-timeout')));
    await nextJson(webSocket);
    const closed = once(webSocket, 'close');

    assert.equal(fixture.gateway.checkHeartbeatHealth(Date.now() + 1_000), true);
    const [code] = await closed;

    assert.equal(code, 4002);
    assert.equal(fixture.store.getRunnerProjection().healthStatus, 'disconnected');
  } finally {
    await fixture.close();
  }
});
