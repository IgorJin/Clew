import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

test('persists a task, stage, run, and event history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-test-'));
  const store = new Store(join(dir, 'state.sqlite'));
  store.createTask({
    id: 'T-1',
    title: 'Test',
    goal: 'Test',
    profile: 'quick',
    acceptance: [{ id: 'AC-1', criterion: 'works' }],
  });
  const savedPlan = store.savePlan('T-1', {
    stages: [{ id: 'worker', dependsOn: [] }],
  });
  store.addStage('T-1', 'worker');
  store.setTaskState('T-1', 'QUEUED');
  store.createRun({
    id: 'run-1',
    taskId: 'T-1',
    stageId: 'worker',
    attempt: 1,
    status: 'RUNNING',
    harness: 'fake',
  });
  assert.equal(store.listStages('T-1')[0].id, 'worker');
  assert.equal(savedPlan.version, 1);
  assert.equal(store.getLatestPlan('T-1').plan.stages[0].id, 'worker');
  assert.equal(store.listRuns('T-1')[0].id, 'run-1');
  assert.ok(store.listEvents('T-1').length >= 2);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
