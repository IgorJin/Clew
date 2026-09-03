import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LEASE_STATE, RUNNER_MESSAGE_KIND, createRunnerEnvelope } from '../src/runner-protocol.js';
import { RunnerStore } from '../src/runner-store.js';

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'clew-runner-store-'));

  return { directory, file: join(directory, 'runner.sqlite') };
}

function envelope(kind, payload, id = randomUUID()) {
  return createRunnerEnvelope({
    kind,
    messageId: id,
    idempotencyKey: `key:${id}`,
    correlationId: `correlation:${id}`,
    payload,
  });
}

test('RunnerStore keeps a stable identity and durable ordered outbox across restart', () => {
  const location = temporaryDatabase();
  let store = new RunnerStore(location.file);
  const identity = store.getOrCreateIdentity();
  const first = envelope(RUNNER_MESSAGE_KIND.LEASE_ACCEPTED, {
    runnerId: identity.runnerId,
    leaseId: 'lease-1',
    epoch: 1,
  });
  const second = envelope(RUNNER_MESSAGE_KIND.RESULT, {
    runnerId: identity.runnerId,
    leaseId: 'lease-1',
    epoch: 1,
    resultId: 'result-1',
    status: 'completed',
  });

  store.enqueue(first);
  store.enqueue(second, { reserveClass: 'terminal' });
  store.markAttempt(first.messageId);
  store.close();

  store = new RunnerStore(location.file);
  assert.deepEqual(store.getOrCreateIdentity(), identity);
  assert.deepEqual(
    store.pendingOutbox().map(({ envelope: item, attempts }) => [item.messageId, attempts]),
    [
      [first.messageId, 1],
      [second.messageId, 0],
    ],
  );
  assert.equal(store.acknowledge({ messageId: 'unknown' }), false);
  assert.equal(store.acknowledge({ messageId: first.messageId, idempotencyKey: 'wrong' }), false);
  assert.equal(
    store.acknowledge({ messageId: first.messageId, idempotencyKey: first.idempotencyKey }),
    true,
  );
  assert.deepEqual(
    store.pendingOutbox().map(({ envelope: item }) => item.messageId),
    [second.messageId],
  );
  store.close();
  rmSync(location.directory, { recursive: true, force: true });
});

test('RunnerStore pins configured identity across restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clew-runner-identity-'));
  const file = join(directory, 'runner.sqlite');

  try {
    let store = new RunnerStore(file, { configuredRunnerId: 'runner-configured' });

    assert.equal(store.getOrCreateIdentity().runnerId, 'runner-configured');
    store.close();
    store = new RunnerStore(file, { configuredRunnerId: 'runner-configured' });
    assert.equal(store.getOrCreateIdentity().runnerId, 'runner-configured');
    store.close();
    store = new RunnerStore(file, { configuredRunnerId: 'runner-other' });
    assert.throws(() => store.getOrCreateIdentity(), /does not match durable Runner identity/);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('RunnerStore reserves capacity for terminal delivery and never silently drops messages', () => {
  const location = temporaryDatabase();
  const store = new RunnerStore(location.file, {
    maxOutboxEntries: 3,
    maxOutboxBytes: 16_000,
    reservedTerminalEntries: 1,
    reservedTerminalBytes: 2_000,
  });
  const runnerId = store.getOrCreateIdentity().runnerId;
  const accepted = (leaseId) =>
    envelope(RUNNER_MESSAGE_KIND.LEASE_ACCEPTED, { runnerId, leaseId, epoch: 1 });

  store.enqueue(accepted('lease-a'));
  store.enqueue(accepted('lease-b'));
  assert.throws(() => store.enqueue(accepted('lease-c')), { code: 'OUTBOX_CAPACITY' });
  store.enqueue(
    envelope(RUNNER_MESSAGE_KIND.RESULT, {
      runnerId,
      leaseId: 'lease-a',
      epoch: 1,
      resultId: 'result-a',
      status: 'failed',
    }),
    { reserveClass: 'terminal' },
  );
  assert.equal(store.status().outbox.entries, 3);
  assert.throws(
    () =>
      store.enqueue(
        envelope(RUNNER_MESSAGE_KIND.RESULT, {
          runnerId,
          leaseId: 'lease-b',
          epoch: 1,
          resultId: 'result-b',
          status: 'failed',
        }),
        { reserveClass: 'terminal' },
      ),
    { code: 'OUTBOX_CAPACITY' },
  );
  store.close();
  rmSync(location.directory, { recursive: true, force: true });
});

test('recordInbound atomically persists execution, response and duplicate replay', () => {
  const location = temporaryDatabase();
  let store = new RunnerStore(location.file);
  const runnerId = store.getOrCreateIdentity().runnerId;
  const offer = envelope(RUNNER_MESSAGE_KIND.LEASE_OFFER, {
    runnerId,
    leaseId: 'lease-atomic',
    epoch: 1,
    taskId: 'task-1',
    stageId: 'stage-1',
    runId: 'run-1',
    attempt: 1,
    workspaceId: 'workspace-1',
  });
  let operations = 0;
  const record = () =>
    store.recordInbound(offer, () => {
      operations += 1;
      store.createExecution({
        leaseId: offer.payload.leaseId,
        epoch: offer.payload.epoch,
        runId: offer.payload.runId,
        state: LEASE_STATE.ACCEPTED,
        workspaceId: offer.payload.workspaceId,
      });

      return {
        response: envelope(RUNNER_MESSAGE_KIND.LEASE_ACCEPTED, {
          runnerId,
          leaseId: offer.payload.leaseId,
          epoch: offer.payload.epoch,
        }),
      };
    });
  const first = record();

  assert.equal(store.acknowledge({ messageId: first.response.messageId }), true);
  assert.equal(store.pendingOutbox().length, 0);
  store.close();
  store = new RunnerStore(location.file);
  const duplicate = record();

  assert.equal(operations, 1);
  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(duplicate.response, first.response);
  assert.deepEqual(
    store.pendingOutbox().map(({ envelope: item }) => item),
    [first.response],
  );
  assert.equal(store.getExecution('lease-atomic', 1).state, LEASE_STATE.ACCEPTED);
  store.close();
  rmSync(location.directory, { recursive: true, force: true });
});

test('RunnerStore fences execution transitions and recovers active leases after restart', () => {
  const location = temporaryDatabase();
  const store = new RunnerStore(location.file);

  store.createExecution({
    leaseId: 'lease-fenced',
    epoch: 4,
    runId: 'run-4',
    state: LEASE_STATE.ACCEPTED,
    workspaceId: 'workspace-1',
  });
  assert.throws(
    () => store.transitionExecution('lease-fenced', 3, LEASE_STATE.ACCEPTED, LEASE_STATE.RUNNING),
    /transition rejected/,
  );
  assert.equal(store.markActiveExecutionsRecovering(), 1);
  assert.equal(store.getExecution('lease-fenced', 4).state, LEASE_STATE.RECOVERING);
  assert.deepEqual(Object.keys(store.status()).sort(), ['activeExecutions', 'outbox']);
  store.close();
  rmSync(location.directory, { recursive: true, force: true });
});
