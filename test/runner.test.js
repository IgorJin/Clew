import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers';
import { RUNNER_MESSAGE_KIND, createRunnerEnvelope } from '../src/runner-protocol.js';
import { RunnerService } from '../src/runner.js';
import { RunnerStore } from '../src/runner-store.js';

class FakeTransport extends EventEmitter {
  sent = [];
  started = false;

  start() {
    this.started = true;
  }

  send(envelope) {
    this.sent.push(envelope);
  }

  close() {
    this.started = false;
  }

  status() {
    return {
      started: this.started,
      connected: this.started,
      registered: this.started,
      reconnectAttempt: 0,
      lastErrorCode: null,
    };
  }
}

function setup(executionPort, { closeStore = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'clew-runner-service-'));
  const store = new RunnerStore(join(directory, 'runner.sqlite'));
  const transport = new FakeTransport();
  const service = new RunnerService({ store, transport, executionPort, closeStore });

  service.start();

  return {
    directory,
    executionPort,
    service,
    store,
    transport,
    runnerId: service.status().runnerId,
  };
}

function offer(runnerId, id = 'offer-message') {
  return createRunnerEnvelope({
    kind: RUNNER_MESSAGE_KIND.LEASE_OFFER,
    messageId: id,
    idempotencyKey: `key:${id}`,
    correlationId: `correlation:${id}`,
    payload: {
      runnerId,
      leaseId: 'lease-service',
      epoch: 1,
      taskId: 'task-service',
      stageId: 'stage-service',
      runId: 'run-service',
      attempt: 1,
      workspaceId: 'workspace-service',
      harness: 'fake',
    },
  });
}

function cancel(runnerId, id = 'cancel-message') {
  return createRunnerEnvelope({
    kind: RUNNER_MESSAGE_KIND.CANCEL,
    messageId: id,
    idempotencyKey: `key:${id}`,
    correlationId: `correlation:${id}`,
    payload: {
      runnerId,
      leaseId: 'lease-service',
      epoch: 1,
      reason: 'operator_request',
    },
  });
}

test('RunnerService accepts an offer once, persists lifecycle messages and redacts execution output', async () => {
  let accepts = 0;
  const context = setup({
    async accept(_offer, { onEvent }) {
      accepts += 1;
      onEvent({ type: 'step', progress: 0.5, summary: 'raw model output' });

      return {
        status: 'completed',
        revision: 'abc123',
        output: 'raw output must never cross the transport',
        prompt: 'secret prompt',
      };
    },
    async cancel() {},
    async shutdown() {},
  });
  const message = offer(context.runnerId);

  context.transport.emit('envelope', message);
  context.transport.emit('envelope', message);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(accepts, 1);
  assert.equal(context.store.getExecution('lease-service', 1).state, 'completed');
  assert.equal(
    context.transport.sent.filter(({ kind }) => kind === RUNNER_MESSAGE_KIND.LEASE_ACCEPTED).length,
    2,
  );
  assert.equal(
    context.transport.sent.some(({ kind }) => kind === RUNNER_MESSAGE_KIND.LEASE_STARTED),
    true,
  );
  assert.equal(
    context.transport.sent.some(({ kind }) => kind === RUNNER_MESSAGE_KIND.RESULT),
    true,
  );
  const persisted = JSON.stringify(context.store.pendingOutbox());

  assert.equal(persisted.includes('raw model output'), false);
  assert.equal(persisted.includes('raw output'), false);
  assert.equal(persisted.includes('secret prompt'), false);
  assert.equal(JSON.stringify(context.service.status()).includes(context.directory), false);
  await context.service.stop();
  context.store.close();
  rmSync(context.directory, { recursive: true, force: true });
});

test('RunnerService invokes cancellation once and replays the saved ACK for duplicates', async () => {
  let cancellations = 0;
  let resolveExecution;
  const executionFinished = new Promise((resolve) => {
    resolveExecution = resolve;
  });
  const context = setup({
    accept() {
      return executionFinished;
    },
    async cancel() {
      cancellations += 1;
      resolveExecution({ status: 'cancelled' });
    },
    async shutdown() {},
  });

  context.transport.emit('envelope', offer(context.runnerId));
  await new Promise((resolve) => setImmediate(resolve));
  const request = cancel(context.runnerId);

  context.transport.emit('envelope', request);
  context.transport.emit('envelope', request);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancellations, 1);
  assert.equal(context.store.getExecution('lease-service', 1).state, 'cancelled');
  const acknowledgements = context.transport.sent.filter(
    ({ kind }) => kind === RUNNER_MESSAGE_KIND.CANCEL_ACK,
  );

  assert.equal(acknowledgements.length, 2);
  assert.deepEqual(acknowledgements[0], acknowledgements[1]);
  await context.service.stop();
  context.store.close();
  rmSync(context.directory, { recursive: true, force: true });
});

test('RunnerService marks interrupted active executions as recovering and shuts down gracefully', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'clew-runner-recovery-'));
  const file = join(directory, 'runner.sqlite');
  let store = new RunnerStore(file);

  store.createExecution({
    leaseId: 'lease-recovery',
    epoch: 2,
    runId: 'run-recovery',
    state: 'running',
    workspaceId: 'workspace-recovery',
  });
  store.close();
  store = new RunnerStore(file);
  let shutdowns = 0;
  const transport = new FakeTransport();
  const service = new RunnerService({
    store,
    transport,
    closeStore: false,
    executionPort: {
      async accept() {},
      async cancel() {},
      async shutdown() {
        shutdowns += 1;
      },
    },
  });

  service.start();
  assert.equal(store.getExecution('lease-recovery', 2).state, 'recovering');
  assert.equal(service.status().persistence.activeExecutions, 1);
  await service.stop({ deadlineMs: 100 });
  assert.equal(shutdowns, 1);
  assert.equal(transport.started, false);
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
