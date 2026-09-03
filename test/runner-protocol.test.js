import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEASE_STATE,
  FakeControllerProtocolPeer,
  FakeRunnerProtocolPeer,
  RUNNER_DIRECTION,
  RUNNER_MESSAGE_KIND,
  assertLeaseTransition,
  assertSecureRunnerEndpoint,
  createRunnerEnvelope,
  negotiateRunnerCompatibility,
  runnerIdempotencyIdentity,
  validateRunnerEnvelope,
} from '../src/runner-protocol.js';

function registration(overrides = {}) {
  return {
    kind: RUNNER_MESSAGE_KIND.REGISTER,
    messageId: 'message-1',
    idempotencyKey: 'register-1',
    correlationId: 'connection-1',
    sentAt: '2026-09-02T00:00:00.000Z',
    payload: {
      runnerId: 'runner-1',
      productVersion: '0.6.0',
      protocolVersions: [1],
      capabilities: ['execute', 'runner_local_terminal'],
      workspaces: [{ id: 'clew', capabilities: ['fake'] }],
    },
    ...overrides,
  };
}

test('validates every bounded protocol envelope and ignores future fields', () => {
  const value = createRunnerEnvelope({ ...registration(), futureEnvelopeField: true });

  assert.equal(value.kind, RUNNER_MESSAGE_KIND.REGISTER);
  assert.equal(value.direction, RUNNER_DIRECTION.TO_CONTROLLER);
  assert.equal(value.payload.runnerId, 'runner-1');
  assert.equal('futureEnvelopeField' in value, false);

  assert.throws(
    () => validateRunnerEnvelope({ ...value, kind: 'runner.future' }),
    /unknown Runner protocol message/,
  );
  assert.throws(
    () => validateRunnerEnvelope({ ...value, payloadVersion: 2 }),
    /unsupported Runner payload version/,
  );
  assert.throws(
    () => validateRunnerEnvelope({ ...value, direction: RUNNER_DIRECTION.TO_RUNNER }),
    /invalid direction/,
  );
  assert.throws(() => validateRunnerEnvelope(value, { maxBytes: 10 }), /exceeds 10 bytes/);
});

test('uses deterministic at-least-once idempotency identities', () => {
  const first = createRunnerEnvelope(registration());
  const replay = { ...first, messageId: 'message-2', sentAt: '2026-09-02T00:01:00.000Z' };

  assert.equal(runnerIdempotencyIdentity(first), runnerIdempotencyIdentity(replay));
});

test('fences invalid lease transitions and keeps terminal leases immutable', () => {
  const offered = {
    leaseId: 'lease-1',
    runnerId: 'runner-1',
    epoch: 1,
    state: LEASE_STATE.OFFERED,
  };
  const accepted = assertLeaseTransition(offered, { ...offered, state: LEASE_STATE.ACCEPTED });
  const running = assertLeaseTransition(accepted, { ...accepted, state: LEASE_STATE.RUNNING });
  const completed = assertLeaseTransition(running, { ...running, state: LEASE_STATE.COMPLETED });

  assert.equal(completed.state, LEASE_STATE.COMPLETED);
  assert.throws(
    () => assertLeaseTransition(offered, { ...offered, epoch: 2, state: LEASE_STATE.ACCEPTED }),
    /stale lease epoch/,
  );
  assert.throws(
    () =>
      assertLeaseTransition(offered, {
        ...offered,
        runnerId: 'runner-2',
        state: LEASE_STATE.ACCEPTED,
      }),
    /Runner identity mismatch/,
  );
  assert.throws(
    () => assertLeaseTransition(offered, { ...offered, state: LEASE_STATE.COMPLETED }),
    /invalid lease transition/,
  );
  assert.throws(
    () => assertLeaseTransition(completed, { ...completed, state: LEASE_STATE.FAILED }),
    /terminal lease cannot mutate/,
  );
});

test('rejects incompatible registration before execution negotiation', () => {
  assert.deepEqual(
    negotiateRunnerCompatibility({
      controller: {
        protocolVersions: [1],
        productVersion: '0.6.1',
        requiredCapabilities: ['execute'],
      },
      runner: {
        protocolVersions: [1],
        productVersion: '0.6.0',
        capabilities: ['runner_local_terminal', 'execute'],
      },
    }),
    {
      protocolVersion: 1,
      productVersion: '0.6.0',
      capabilities: ['execute', 'runner_local_terminal'],
    },
  );
  assert.throws(
    () =>
      negotiateRunnerCompatibility({
        controller: { protocolVersions: [1] },
        runner: { protocolVersions: [2], capabilities: [] },
      }),
    /incompatible Runner protocol versions/,
  );
  assert.throws(
    () =>
      negotiateRunnerCompatibility({
        controller: { protocolVersions: [1], requiredCapabilities: ['execute'] },
        runner: { protocolVersions: [1], capabilities: [] },
      }),
    /missing capabilities/,
  );
  assert.throws(
    () =>
      negotiateRunnerCompatibility({
        controller: { protocolVersions: [1], productVersion: '0.6.0' },
        runner: { protocolVersions: [1], productVersion: '0.7.0', capabilities: [] },
      }),
    /incompatible product versions/,
  );
  assert.throws(
    () =>
      negotiateRunnerCompatibility({
        controller: { protocolVersions: [1], productVersion: '0.6.0' },
        runner: { protocolVersions: [1], productVersion: 'development', capabilities: [] },
      }),
    /semantic versioning/,
  );
});

test('allows plaintext only on loopback and never URL credentials', () => {
  assert.equal(assertSecureRunnerEndpoint('ws://127.0.0.1:4319').protocol, 'ws:');
  assert.equal(assertSecureRunnerEndpoint('ws://[::1]:4319').protocol, 'ws:');
  assert.equal(assertSecureRunnerEndpoint('wss://controller.example.test').protocol, 'wss:');
  assert.throws(() => assertSecureRunnerEndpoint('ws://controller.example.test'), /requires TLS/);
  assert.throws(
    () => assertSecureRunnerEndpoint('wss://token@example.test'),
    /must not be embedded/,
  );
});

test('forbids credentials, host data, prompts, reasoning, and PTY bytes', () => {
  for (const forbidden of [
    { accessToken: 'secret' },
    { environmentValues: { A: 'B' } },
    { fileContents: 'source' },
    { prompt: 'private' },
    { hiddenReasoning: 'private' },
    { ptyBytes: 'raw' },
  ]) {
    assert.throws(
      () =>
        createRunnerEnvelope({
          ...registration(),
          payload: { ...registration().payload, ...forbidden },
        }),
      /forbidden transport data/,
    );
  }
});

test('fake Controller and Runner peers share conformance and duplicate semantics', () => {
  const runner = new FakeRunnerProtocolPeer();
  const controller = new FakeControllerProtocolPeer();
  const register = runner.produce(registration());
  const first = controller.consume(register, () => ({ status: 'registered' }));
  const duplicate = controller.consume({ ...register, messageId: 'message-replayed' }, () => {
    throw new Error('duplicate must not repeat the action');
  });
  const offer = controller.produce({
    kind: RUNNER_MESSAGE_KIND.LEASE_OFFER,
    messageId: 'offer-message-1',
    idempotencyKey: 'offer-1',
    correlationId: 'lease-1',
    payload: {
      runnerId: 'runner-1',
      leaseId: 'lease-1',
      epoch: 1,
      taskId: 'task-1',
      stageId: 'worker',
      runId: 'run-1',
      attempt: 1,
      workspaceId: 'clew',
    },
  });

  assert.deepEqual(first, { duplicate: false, outcome: { status: 'registered' } });
  assert.deepEqual(duplicate, { duplicate: true, outcome: { status: 'registered' } });
  assert.equal(runner.consume(offer).duplicate, false);
  assert.equal(controller.actions.length, 1);
  assert.equal(runner.actions.length, 1);
  assert.throws(() => runner.produce({ ...offer }), /fake peer cannot produce/);
});
