import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';

function fixtureStore() {
  const dir = mkdtempSync(join(tmpdir(), 'clew-continuation-'));
  const store = new Store(join(dir, 'state.sqlite'));

  store.createTask({
    id: 'CONT-1',
    title: 'Continuation',
    goal: 'test continuation',
    profile: 'standard',
    risk: 'medium',
    base_ref: 'HEAD',
    acceptance: [{ id: 'AC-1', criterion: 'works' }],
  });

  return { dir, store };
}

test('continuation grants are idempotent and operator messages are redacted', () => {
  const { dir, store } = fixtureStore();

  try {
    const message = store.recordOperatorMessage({
      taskId: 'CONT-1',
      actor: 'operator',
      message: 'Fix Bearer secret-value',
      target: { stageId: 'worker', cause: 'review_exhaustion' },
    });
    const grant = {
      id: 'grant-1',
      taskId: 'CONT-1',
      stageId: 'worker',
      actor: 'operator',
      reason: message.message,
      expectedRevision: 'rev-1',
      expiresAt: '2026-08-29T00:00:00.000Z',
      idempotencyKey: 'request-1',
    };
    const first = store.recordContinuationGrant(grant);
    const replay = store.recordContinuationGrant({ ...grant, id: 'grant-2' });

    assert.equal(message.message, 'Fix Bearer [REDACTED]');
    assert.equal(first.id, 'grant-1');
    assert.equal(replay.id, 'grant-1');
    assert.equal(store.getContinuationGrantByKey('request-1').task_id, 'CONT-1');
    assert.equal(store.listOperatorMessages('CONT-1').length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('completion override preserves unresolved findings and is idempotent', () => {
  const { dir, store } = fixtureStore();

  try {
    const findings = [{ severity: 'blocking', criterion: 'AC-1', reason: 'still open' }];
    const first = store.recordCompletionOverride({
      taskId: 'CONT-1',
      expectedRevision: 'rev-1',
      actor: 'operator',
      reason: 'accepted with risk',
      unresolvedFindings: findings,
      idempotencyKey: 'override-1',
    });
    const replay = store.recordCompletionOverride({
      taskId: 'CONT-1',
      expectedRevision: 'rev-2',
      actor: 'other',
      reason: 'replay',
      idempotencyKey: 'override-1',
    });

    assert.deepEqual(first.unresolvedFindings, findings);
    assert.equal(replay.id, first.id);
    assert.equal(store.listEvents('CONT-1').at(-1).type, 'COMPLETION_OVERRIDE_RECORDED');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
