import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { LEASE_STATE, RUNNER_MESSAGE_KIND, createRunnerEnvelope } from '../src/runner-protocol.js';

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), 'clew-runner-lease-'));
  const store = new Store(join(directory, 'state.sqlite'));

  store.createTask({
    id: 'TASK-1',
    title: 'Runner lease',
    goal: 'Execute remotely',
    profile: 'quick',
    acceptance: [{ id: 'AC-1', criterion: 'durable' }],
  });
  store.addStage('TASK-1', 'worker');
  store.setTaskState('TASK-1', 'EXECUTING');
  store.registerRunner({
    runnerId: 'runner-1',
    productVersion: '0.6.0',
    capabilities: ['execute'],
    workspaces: [{ id: 'clew' }],
  });

  return {
    store,
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function envelope(kind, payload, overrides = {}) {
  return createRunnerEnvelope({
    kind,
    messageId: overrides.messageId ?? `${kind}-message`,
    idempotencyKey: overrides.idempotencyKey ?? `${kind}-key`,
    correlationId: 'lease-1',
    sentAt: '2026-09-02T00:00:00.000Z',
    payload: { runnerId: 'runner-1', leaseId: 'lease-1', epoch: 1, ...payload },
  });
}

function allocate(store) {
  const offer = envelope(RUNNER_MESSAGE_KIND.LEASE_OFFER, {
    taskId: 'TASK-1',
    stageId: 'worker',
    runId: 'run-1',
    attempt: 1,
    workspaceId: 'clew',
  });

  store.allocateRunnerLease({
    run: {
      id: 'run-1',
      taskId: 'TASK-1',
      stageId: 'worker',
      attempt: 1,
      status: 'RUNNING',
      harness: 'fake',
    },
    lease: {
      id: 'lease-1',
      runnerId: 'runner-1',
      epoch: 1,
      workspaceMappingId: 'clew',
      requirements: { capabilities: ['execute'] },
    },
    offer,
  });

  return offer;
}

test('allocates run, lease, and durable offer atomically without persisting a host path', () => {
  const fixture = createStore();

  try {
    allocate(fixture.store);
    const lease = fixture.store.getRunnerLease('lease-1');
    const run = fixture.store.getRun('run-1');
    const commands = fixture.store.listPendingRunnerCommands('runner-1');

    assert.equal(lease.state, LEASE_STATE.OFFERED);
    assert.equal(lease.workspaceMappingId, 'clew');
    assert.equal(run.execution_mode, 'paired');
    assert.equal(run.workspace, null);
    assert.equal(run.workspace_ref, 'runner-workspace:clew');
    assert.equal(commands.length, 1);
    assert.equal(commands[0].kind, RUNNER_MESSAGE_KIND.LEASE_OFFER);
    assert.equal(fixture.store.listStages('TASK-1')[0].status, 'RUNNING');
  } finally {
    fixture.close();
  }
});

test('deduplicates inbound transitions and rejects conflicting or stale fencing identities', () => {
  const fixture = createStore();

  try {
    allocate(fixture.store);
    const accepted = envelope(RUNNER_MESSAGE_KIND.LEASE_ACCEPTED, {});
    const firstAck = fixture.store.processRunnerEnvelope(accepted);
    const replayAck = fixture.store.processRunnerEnvelope({
      ...accepted,
      messageId: 'accepted-replayed-message',
    });

    assert.deepEqual(replayAck, firstAck);
    assert.equal(fixture.store.getRunnerLease('lease-1').state, LEASE_STATE.ACCEPTED);
    assert.equal(
      fixture.store.db
        .prepare("SELECT COUNT(*) AS count FROM runner_lease_transitions WHERE to_state='accepted'")
        .get().count,
      1,
    );
    assert.throws(
      () =>
        fixture.store.processRunnerEnvelope({
          ...accepted,
          messageId: 'accepted-conflict-message',
          payload: { ...accepted.payload, epoch: 2 },
        }),
      /idempotency conflict/,
    );
    const stale = envelope(
      RUNNER_MESSAGE_KIND.LEASE_STARTED,
      {},
      { messageId: 'stale-message', idempotencyKey: 'stale-key' },
    );

    assert.throws(
      () =>
        fixture.store.processRunnerEnvelope({ ...stale, payload: { ...stale.payload, epoch: 2 } }),
      /stale lease epoch/,
    );
  } finally {
    fixture.close();
  }
});

test('reordered, replayed, and delayed frames preserve one terminal history', () => {
  const fixture = createStore();

  try {
    allocate(fixture.store);
    const started = envelope(
      RUNNER_MESSAGE_KIND.LEASE_STARTED,
      {},
      { messageId: 'reordered-started', idempotencyKey: 'reordered-started-key' },
    );

    assert.throws(() => fixture.store.processRunnerEnvelope(started), /invalid lease transition/);
    assert.equal(fixture.store.getRunnerLease('lease-1').state, LEASE_STATE.OFFERED);
    fixture.store.processRunnerEnvelope(envelope(RUNNER_MESSAGE_KIND.LEASE_ACCEPTED, {}));
    fixture.store.processRunnerEnvelope(started);
    const result = envelope(
      RUNNER_MESSAGE_KIND.RESULT,
      { resultId: 'single-result', status: 'completed' },
      { messageId: 'single-result-message', idempotencyKey: 'single-result-key' },
    );
    const firstAck = fixture.store.processRunnerEnvelope(result);
    const replayAck = fixture.store.processRunnerEnvelope(result);

    assert.deepEqual(replayAck, firstAck);
    assert.equal(
      fixture.store.db.prepare('SELECT COUNT(*) AS count FROM runner_lease_results').get().count,
      1,
    );
    const delayedEvent = envelope(
      RUNNER_MESSAGE_KIND.EVENT,
      {
        eventId: 'delayed-event',
        type: 'progress',
        at: '2026-09-02T00:02:00.000Z',
      },
      { messageId: 'delayed-event-message', idempotencyKey: 'delayed-event-key' },
    );

    assert.throws(
      () => fixture.store.processRunnerEnvelope(delayedEvent),
      /invalid while lease is completed/,
    );
    assert.equal(
      fixture.store.db.prepare('SELECT COUNT(*) AS count FROM runner_lease_events').get().count,
      0,
    );
  } finally {
    fixture.close();
  }
});

test('persists normalized events/results and only acknowledges after the transaction commits', () => {
  const fixture = createStore();

  try {
    allocate(fixture.store);
    fixture.store.processRunnerEnvelope(envelope(RUNNER_MESSAGE_KIND.LEASE_ACCEPTED, {}));
    fixture.store.processRunnerEnvelope(
      envelope(
        RUNNER_MESSAGE_KIND.LEASE_STARTED,
        {},
        { messageId: 'started-message', idempotencyKey: 'started-key' },
      ),
    );
    fixture.store.processRunnerEnvelope(
      envelope(
        RUNNER_MESSAGE_KIND.EVENT,
        {
          eventId: 'event-1',
          type: 'progress',
          at: '2026-09-02T00:01:00.000Z',
          summary: 'halfway',
          progress: 0.5,
        },
        { messageId: 'event-message', idempotencyKey: 'event-key' },
      ),
    );
    const ack = fixture.store.processRunnerEnvelope(
      envelope(
        RUNNER_MESSAGE_KIND.RESULT,
        {
          resultId: 'result-1',
          status: 'completed',
          summary: 'done',
          revision: 'abc123',
          evidence: [{ type: 'command', result: 'passed' }],
          usage: { requests: 1 },
        },
        { messageId: 'result-message', idempotencyKey: 'result-key' },
      ),
    );

    assert.equal(ack.kind, RUNNER_MESSAGE_KIND.ACK);
    assert.equal(ack.payload.ackedMessageId, 'result-message');
    assert.equal(fixture.store.getRunnerLease('lease-1').state, LEASE_STATE.COMPLETED);
    assert.ok(fixture.store.getRunnerLease('lease-1').acknowledgedAt);
    assert.deepEqual(
      JSON.parse(fixture.store.db.prepare('SELECT result FROM runner_lease_results').get().result),
      {
        runnerId: 'runner-1',
        leaseId: 'lease-1',
        epoch: 1,
        resultId: 'result-1',
        status: 'completed',
        summary: 'done',
        revision: 'abc123',
        evidence: [{ type: 'command', result: 'passed' }],
        usage: { requests: 1 },
      },
    );
  } finally {
    fixture.close();
  }
});

test('late cancellation acknowledgment preserves an already uploaded result', () => {
  const fixture = createStore();

  try {
    allocate(fixture.store);
    fixture.store.processRunnerEnvelope(envelope(RUNNER_MESSAGE_KIND.LEASE_ACCEPTED, {}));
    fixture.store.processRunnerEnvelope(
      envelope(
        RUNNER_MESSAGE_KIND.LEASE_STARTED,
        {},
        { messageId: 'started-before-cancel', idempotencyKey: 'started-before-cancel-key' },
      ),
    );
    const cancelCommand = envelope(
      RUNNER_MESSAGE_KIND.CANCEL,
      { reason: 'operator_request' },
      { messageId: 'cancel-command', idempotencyKey: 'cancel-command-key' },
    );

    fixture.store.requestRunnerLeaseCancellation({
      leaseId: 'lease-1',
      reason: 'operator_request',
      envelope: cancelCommand,
    });
    fixture.store.processRunnerEnvelope(
      envelope(
        RUNNER_MESSAGE_KIND.RESULT,
        { resultId: 'result-before-cancel-ack', status: 'completed' },
        { messageId: 'result-before-cancel', idempotencyKey: 'result-before-cancel-key' },
      ),
    );
    fixture.store.processRunnerEnvelope(
      envelope(
        RUNNER_MESSAGE_KIND.CANCEL_ACK,
        { status: 'already_terminal' },
        { messageId: 'late-cancel-ack', idempotencyKey: 'late-cancel-ack-key' },
      ),
    );
    const lease = fixture.store.getRunnerLease('lease-1');

    assert.equal(lease.state, LEASE_STATE.COMPLETED);
    assert.equal(lease.cancellationState, 'acknowledged');
    assert.ok(lease.cancelAcknowledgedAt);
  } finally {
    fixture.close();
  }
});

test('disconnect and restart preserve ownership and require explicit recovery', () => {
  const fixture = createStore();

  try {
    allocate(fixture.store);
    fixture.store.processRunnerEnvelope(envelope(RUNNER_MESSAGE_KIND.LEASE_ACCEPTED, {}));
    const generation = fixture.store.getRunnerProjection('runner-1').connectionGeneration;

    fixture.store.markRunnerDisconnected({
      runnerId: 'runner-1',
      connectionGeneration: generation,
      reason: 'network_loss',
    });
    const lease = fixture.store.getRunnerLease('lease-1');

    assert.equal(lease.state, LEASE_STATE.RECOVERING);
    assert.equal(lease.recoveryClassification, 'ambiguous_runner_loss');
    assert.equal(fixture.store.listStages('TASK-1')[0].status, 'RUNNING');
    assert.equal(fixture.store.getRun('run-1').status, 'RUNNING');
    assert.equal(fixture.store.getTask('TASK-1').state, 'RECOVERING');
    assert.equal(fixture.store.listPendingRunnerCommands('runner-1').length, 0);
    assert.equal(
      fixture.store.db.prepare('SELECT COUNT(*) AS count FROM runner_commands').get().count,
      1,
    );
    const reconciled = fixture.store.reconcileRunnerLeasesOnRestart();

    assert.equal(reconciled.recovering.length, 1);
  } finally {
    fixture.close();
  }
});

test('Controller restart classifies every durable lease boundary without duplicate allocation', () => {
  for (const boundary of ['offered', 'accepted', 'running', 'completed']) {
    const fixture = createStore();

    try {
      allocate(fixture.store);
      if (boundary !== 'offered')
        fixture.store.processRunnerEnvelope(envelope(RUNNER_MESSAGE_KIND.LEASE_ACCEPTED, {}));
      if (['running', 'completed'].includes(boundary))
        fixture.store.processRunnerEnvelope(
          envelope(
            RUNNER_MESSAGE_KIND.LEASE_STARTED,
            {},
            { messageId: `started-${boundary}`, idempotencyKey: `started-${boundary}-key` },
          ),
        );
      if (boundary === 'completed')
        fixture.store.processRunnerEnvelope(
          envelope(
            RUNNER_MESSAGE_KIND.RESULT,
            { resultId: 'boundary-result', status: 'completed' },
            { messageId: 'boundary-result-message', idempotencyKey: 'boundary-result-key' },
          ),
        );

      fixture.store.reconcileRunnerLeasesOnRestart(`restart_at_${boundary}`);
      const lease = fixture.store.getRunnerLease('lease-1');

      assert.equal(
        lease.state,
        ['accepted', 'running'].includes(boundary) ? LEASE_STATE.RECOVERING : boundary,
      );
      assert.equal(fixture.store.listRuns('TASK-1').length, 1);
      assert.equal(
        fixture.store.db.prepare('SELECT COUNT(*) AS count FROM runner_leases').get().count,
        1,
      );
    } finally {
      fixture.close();
    }
  }
});

test('Store observers see lease events only after commit and never after rollback', () => {
  const fixture = createStore();
  const observed = [];

  try {
    fixture.store.setEventObserver((event) => observed.push(event));
    assert.throws(
      () =>
        fixture.store.runInTransaction(() => {
          fixture.store.appendEvent('TASK-1', 'SHOULD_ROLL_BACK', { safe: true });
          throw new Error('rollback');
        }),
      /rollback/,
    );
    assert.equal(observed.length, 0);
    assert.equal(
      fixture.store.listEvents('TASK-1').some((event) => event.type === 'SHOULD_ROLL_BACK'),
      false,
    );
  } finally {
    fixture.close();
  }
});
