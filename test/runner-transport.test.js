import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers';
import { RUNNER_MESSAGE_KIND, createRunnerEnvelope } from '../src/runner-protocol.js';
import { RunnerStore } from '../src/runner-store.js';
import { RunnerTransport } from '../src/runner-transport.js';

class FakeSocket extends EventEmitter {
  readyState = 0;
  sent = [];

  open() {
    this.readyState = 1;
    this.emit('open');
  }

  receive(envelope) {
    this.emit('message', JSON.stringify(envelope));
  }

  send(value) {
    this.sent.push(JSON.parse(value));
  }

  close() {
    const wasClosed = this.readyState === 3;

    this.readyState = 3;
    if (!wasClosed) setImmediate(() => this.emit('close'));
  }
}

function setup(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'clew-runner-transport-'));
  const store = new RunnerStore(join(directory, 'runner.sqlite'));
  const runnerId = store.getOrCreateIdentity().runnerId;
  const sockets = [];
  const calls = [];
  const transport = new RunnerTransport({
    endpoint: 'ws://127.0.0.1:43177/runner/v1',
    credential: 'super-secret-token',
    runnerId,
    productVersion: '0.6.0',
    capabilities: ['fake'],
    workspaces: ['project'],
    store,
    reconnect: { initialMs: 5, maximumMs: 10, factor: 2 },
    random: () => 1,
    webSocketFactory(url, socketOptions) {
      calls.push({ url, socketOptions });
      const socket = new FakeSocket();

      sockets.push(socket);

      return socket;
    },
    ...options,
  });

  return { directory, store, runnerId, sockets, calls, transport };
}

function registered(runnerId, correlationId = 'registration-1') {
  return createRunnerEnvelope({
    kind: RUNNER_MESSAGE_KIND.REGISTERED,
    messageId: 'registered-message',
    idempotencyKey: 'registered-key',
    correlationId,
    payload: {
      runnerId,
      protocolVersion: 1,
      controllerId: 'controller-1',
      connectionId: 'connection-1',
      heartbeatIntervalMs: 60_000,
    },
  });
}

test('RunnerTransport authenticates, registers and replays only persisted messages', () => {
  const context = setup();
  const durable = createRunnerEnvelope({
    kind: RUNNER_MESSAGE_KIND.LEASE_ACCEPTED,
    messageId: 'accepted-message',
    idempotencyKey: 'accepted-key',
    correlationId: 'offer-message',
    payload: { runnerId: context.runnerId, leaseId: 'lease-1', epoch: 1 },
  });

  context.store.enqueue(durable);
  context.transport.start();
  context.sockets[0].open();
  assert.equal(context.sockets[0].sent[0].kind, RUNNER_MESSAGE_KIND.REGISTER);
  assert.equal(context.calls[0].socketOptions.headers.Authorization, 'Bearer super-secret-token');
  assert.throws(
    () =>
      context.transport.send(
        createRunnerEnvelope({
          kind: RUNNER_MESSAGE_KIND.LEASE_ACCEPTED,
          messageId: 'not-persisted',
          idempotencyKey: 'not-persisted-key',
          correlationId: 'offer-2',
          payload: { runnerId: context.runnerId, leaseId: 'lease-2', epoch: 1 },
        }),
      ),
    /persisted outbox/,
  );
  context.sockets[0].receive(registered(context.runnerId));
  assert.equal(context.sockets[0].sent[1].messageId, durable.messageId);
  assert.equal(context.store.pendingOutbox()[0].attempts, 1);
  assert.equal(JSON.stringify(context.transport.status()).includes('secret'), false);
  assert.equal(JSON.stringify(context.transport.status()).includes('/runner/v1'), false);
  context.transport.close();
  context.store.close();
  rmSync(context.directory, { recursive: true, force: true });
});

test('RunnerTransport deletes durable messages only after a matching Controller ACK', () => {
  const context = setup();
  const durable = createRunnerEnvelope({
    kind: RUNNER_MESSAGE_KIND.RESULT,
    messageId: 'result-message',
    idempotencyKey: 'result-key',
    correlationId: 'lease-1',
    payload: {
      runnerId: context.runnerId,
      leaseId: 'lease-1',
      epoch: 1,
      resultId: 'result-1',
      status: 'completed',
    },
  });

  context.store.enqueue(durable, { reserveClass: 'terminal' });
  context.transport.start();
  context.sockets[0].open();
  context.sockets[0].receive(registered(context.runnerId));
  context.sockets[0].receive(
    createRunnerEnvelope({
      kind: RUNNER_MESSAGE_KIND.ACK,
      messageId: 'ack-wrong',
      idempotencyKey: 'ack-wrong-key',
      correlationId: durable.messageId,
      payload: { runnerId: context.runnerId, ackedMessageId: 'other-message' },
    }),
  );
  assert.equal(context.store.pendingOutbox().length, 1);
  context.sockets[0].receive(
    createRunnerEnvelope({
      kind: RUNNER_MESSAGE_KIND.ACK,
      messageId: 'ack-result',
      idempotencyKey: 'ack-result-key',
      correlationId: durable.messageId,
      payload: { runnerId: context.runnerId, ackedMessageId: durable.messageId },
    }),
  );
  assert.equal(context.store.pendingOutbox().length, 0);
  context.transport.close();
  context.store.close();
  rmSync(context.directory, { recursive: true, force: true });
});

test('RunnerTransport reconnects with bounded exponential delay and one live socket', async () => {
  const context = setup();
  const reconnects = [];

  context.transport.on('reconnecting', (event) => reconnects.push(event));
  context.transport.start();
  context.sockets[0].open();
  context.sockets[0].close();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(context.sockets.length, 2);
  assert.deepEqual(reconnects[0], { attempt: 1, delayMs: 5 });
  assert.equal(context.transport.status().registered, false);
  context.transport.close();
  context.store.close();
  rmSync(context.directory, { recursive: true, force: true });
});

test('dropped acknowledgments replay the same durable messages in order after reconnect', async () => {
  const context = setup();
  const messages = [
    createRunnerEnvelope({
      kind: RUNNER_MESSAGE_KIND.LEASE_ACCEPTED,
      messageId: 'replay-accepted',
      idempotencyKey: 'replay-accepted-key',
      correlationId: 'replay-offer',
      payload: { runnerId: context.runnerId, leaseId: 'replay-lease', epoch: 1 },
    }),
    createRunnerEnvelope({
      kind: RUNNER_MESSAGE_KIND.RESULT,
      messageId: 'replay-result',
      idempotencyKey: 'replay-result-key',
      correlationId: 'replay-lease',
      payload: {
        runnerId: context.runnerId,
        leaseId: 'replay-lease',
        epoch: 1,
        resultId: 'replay-result-id',
        status: 'completed',
      },
    }),
  ];

  context.store.enqueue(messages[0]);
  context.store.enqueue(messages[1], { reserveClass: 'terminal' });
  context.transport.start();
  context.sockets[0].open();
  context.sockets[0].receive(registered(context.runnerId));
  assert.deepEqual(
    context.sockets[0].sent.slice(1).map((item) => item.messageId),
    messages.map((item) => item.messageId),
  );
  context.sockets[0].close();
  await new Promise((resolve) => setTimeout(resolve, 15));
  context.sockets[1].open();
  context.sockets[1].receive(registered(context.runnerId, 'registration-2'));
  assert.deepEqual(
    context.sockets[1].sent.slice(1).map((item) => item.messageId),
    messages.map((item) => item.messageId),
  );
  assert.equal(context.store.pendingOutbox().length, 2);
  assert.deepEqual(
    context.store.pendingOutbox().map((item) => item.attempts),
    [2, 2],
  );
  context.transport.close();
  context.store.close();
  rmSync(context.directory, { recursive: true, force: true });
});

test('RunnerTransport rejects insecure non-loopback endpoints before opening a socket', () => {
  const context = setup();

  assert.throws(
    () =>
      new RunnerTransport({
        endpoint: 'ws://controller.example/runner/v1',
        credential: 'secret',
        runnerId: context.runnerId,
        productVersion: '0.6.0',
        store: context.store,
      }),
    /requires TLS/,
  );
  context.store.close();
  rmSync(context.directory, { recursive: true, force: true });
});
