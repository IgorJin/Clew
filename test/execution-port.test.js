import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LocalExecutionPort,
  PairedExecutionPort,
  createExecutionPort,
} from '../src/execution-port.js';

test('local is the default execution seam and delegates without changing request semantics', async () => {
  const calls = [];
  const adapter = {
    describe: () => ({ harnesses: ['fake'] }),
    executeStage: async (request, hooks) => {
      calls.push({ request, hooks });

      return { runId: request.runId, revision: 'abc123' };
    },
    cancelStage: (execution) => ({ ...execution, cancelled: true }),
  };
  const port = createExecutionPort({ local: adapter });
  const hooks = { onEvent() {} };
  const result = await port.executeStage({ runId: 'run-1' }, hooks);

  assert.ok(port instanceof LocalExecutionPort);
  assert.deepEqual(port.describe(), { mode: 'local', available: true, harnesses: ['fake'] });
  assert.deepEqual(result, { runId: 'run-1', revision: 'abc123' });
  assert.deepEqual(calls, [{ request: { runId: 'run-1' }, hooks }]);
  assert.deepEqual(port.cancelStage({ runId: 'run-1' }), {
    runId: 'run-1',
    cancelled: true,
  });
});

test('paired execution persists before send and exposes only safe Runner projection', async () => {
  const sequence = [];
  const store = {
    getRunnerProjection: () => ({
      runnerId: 'runner-1',
      protocolVersion: 1,
      productVersion: '0.6.0',
      capabilities: ['execute'],
      workspaces: [{ id: 'clew' }],
      healthStatus: 'healthy',
      lastSeenAt: '2026-09-02T00:00:00.000Z',
      credential: 'must-not-leak',
    }),
    allocateRunnerLease(input) {
      sequence.push('persist');

      return { id: input.lease.id, state: 'offered' };
    },
    markRunnerCommandSent() {
      sequence.push('sent');
    },
  };
  const transport = {
    async send() {
      sequence.push('transport');
    },
  };
  const port = new PairedExecutionPort({ store, transport, runnerId: 'runner-1' });
  const request = {
    run: { id: 'run-1' },
    lease: { id: 'lease-1', workspaceMappingId: 'clew' },
    requirements: { capabilities: ['execute'] },
    offer: { messageId: 'offer-1' },
  };
  const result = await port.executeStage(request);

  assert.deepEqual(sequence, ['persist', 'transport', 'sent']);
  assert.equal(result.lease.id, 'lease-1');
  assert.equal('credential' in port.describe().runner, false);
  assert.deepEqual(port.matchStage({ capabilities: ['gpu'], workspaceMappingId: 'clew' }), {
    matched: false,
    reason: 'missing_capabilities',
    missingCapabilities: ['gpu'],
  });
});

test('rejects unknown execution modes and unavailable paired mappings', () => {
  assert.throws(() => createExecutionPort({ mode: 'future' }), /unsupported execution mode/);
  const port = new PairedExecutionPort({
    runnerId: 'runner-1',
    store: {
      allocateRunnerLease() {},
      getRunnerProjection: () => null,
    },
    transport: { send() {} },
  });

  assert.deepEqual(port.matchStage({ workspaceMappingId: 'missing' }), {
    matched: false,
    reason: 'runner_unavailable',
  });
});
