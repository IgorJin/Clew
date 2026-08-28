import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { projectTaskThread, queryTaskThread } from '../src/thread.js';
import { Store } from '../src/store.js';

const event = (seq, type, payload = {}, at = '2026-08-28T10:00:00.000Z') => ({
  seq,
  task_id: 'THREAD-1',
  type,
  payload,
  at,
  version: 1,
});

test('projects curated events deterministically and ignores unknown future events', () => {
  const input = {
    taskId: 'THREAD-1',
    events: [
      event(2, 'REVIEW_RECORDED', { verdict: 'pass' }),
      event(1, 'TASK_CREATED', { contract: { title: 'Fixture' } }),
      event(3, 'FUTURE_EVENT', { completion: 'private output' }),
    ],
  };
  const first = projectTaskThread(input);
  const second = projectTaskThread(input);

  assert.deepEqual(first, second);
  assert.deepEqual(
    first.map((item) => item.kind),
    ['task_created', 'review_recorded'],
  );
  assert.equal(first[1].source.eventType, 'REVIEW_RECORDED');
  assert.equal(first[1].redacted, false);
});

test('uses stable equal-timestamp ordering and cursor pagination', () => {
  const input = {
    events: [event(2, 'TASK_STATE_CHANGED', { state: 'READY' }), event(1, 'TASK_CREATED')],
  };
  const page = queryTaskThread(input, { limit: 1 });

  assert.equal(page.items[0].kind, 'task_created');
  assert.equal(page.nextCursor, 1);
  assert.equal(page.hasMore, true);
  assert.equal(
    queryTaskThread(input, { after: page.nextCursor }).items[0].kind,
    'task_state_changed',
  );
});

test('persists redacted operator messages and exposes a separate diagnostic view', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-thread-'));
  const store = new Store(join(dir, 'clew.sqlite'));

  try {
    store.createTask({
      id: 'THREAD-1',
      title: 'Thread fixture',
      goal: 'test',
      acceptance: [{ id: 'AC-1', criterion: 'passes' }],
      risk: 'low',
      profile: 'quick',
      base_ref: 'HEAD',
    });
    const message = store.recordOperatorMessage({
      taskId: 'THREAD-1',
      actor: 'operator',
      message: 'Continue with Bearer abc123',
      target: { stageId: 'worker', runId: 'run-1' },
    });
    const item = store
      .getTaskThread('THREAD-1')
      .items.find((candidate) => candidate.id === `thread-message-${message.id}`);

    assert.equal(item.summary, 'Continue with Bearer [REDACTED]');
    assert.equal(item.redacted, true);
    assert.equal(item.actor, 'operator');
    assert.equal(item.stageId, 'worker');
    assert.equal(store.listDiagnosticEvents('THREAD-1').at(-1).type, 'OPERATOR_MESSAGE_RECORDED');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
