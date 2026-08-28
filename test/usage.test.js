import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { aggregateUsage, calculateUsageCost } from '../src/usage.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'clew-usage-'));
  const store = new Store(join(dir, 'state.sqlite'));

  store.createTask({
    id: 'U-1',
    title: 'usage',
    goal: 'usage',
    profile: 'quick',
    acceptance: [{ id: 'AC-1', criterion: 'works' }],
  });
  store.createRun({
    id: 'run-1',
    taskId: 'U-1',
    stageId: 'worker',
    attempt: 1,
    status: 'COMPLETED',
    harness: 'fake',
  });

  return { dir, store };
}

test('usage is idempotent and lifecycle cost is exact', () => {
  const { dir, store } = fixture();

  store.recordPricingSnapshot({
    source: 'fixture',
    currency: 'USD',
    catalog: { 'gpt-test': { inputPerMillion: '2.5', outputPerMillion: '10' } },
  });
  const input = {
    taskId: 'U-1',
    runId: 'run-1',
    stageId: 'worker',
    attempt: 1,
    sessionId: 's',
    turnId: 't',
    harness: 'fake',
    model: 'gpt-test',
    inputTokens: 1000,
    outputTokens: 500,
  };
  const first = store.recordUsage(input);
  const second = store.recordUsage(input);

  assert.equal(first.id, second.id);
  assert.equal(store.listUsage('U-1').length, 1);
  assert.deepEqual(store.refreshUsageCosts('U-1').total, { USD: '0.0075' });
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('unknown and partial usage remain explicit', () => {
  assert.equal(calculateUsageCost({ completeness: 'unknown', model: 'x' }, null).status, 'unknown');
  const summary = aggregateUsage([
    { id: 'a', completeness: 'unknown' },
    { id: 'b', completeness: 'partial' },
  ]);

  assert.equal(summary.status, 'partial');
  assert.equal(summary.unknownTurns, 1);
  assert.equal(summary.partialTurns, 1);
});
