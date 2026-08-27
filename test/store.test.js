import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { CURRENT_SCHEMA_VERSION } from '../src/migrations.js';

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
    profile: 'quick',
    policy: { maxAttempts: 3 },
  });
  store.setRunIdentity('run-1', 'thread-1', 'turn-1');
  assert.throws(
    () =>
      store.createRun({
        id: 'run-duplicate-attempt',
        taskId: 'T-1',
        stageId: 'worker',
        attempt: 1,
        status: 'RUNNING',
        harness: 'fake',
      }),
    /UNIQUE constraint failed/,
  );
  assert.equal(store.listStages('T-1')[0].id, 'worker');
  assert.equal(savedPlan.version, 1);
  assert.equal(store.getLatestPlan('T-1').plan.stages[0].id, 'worker');
  assert.equal(store.listRuns('T-1')[0].id, 'run-1');
  assert.equal(store.listRuns('T-1')[0].session_id, 'thread-1');
  assert.equal(store.listRuns('T-1')[0].turn_id, 'turn-1');
  assert.equal(store.listRuns('T-1')[0].profile, 'quick');
  assert.equal(store.listRuns('T-1')[0].policy.maxAttempts, 3);
  assert.ok(store.listEvents('T-1').length >= 2);
  store.setStage('T-1', 'worker', 'COMPLETED');
  store.db.prepare("UPDATE tasks SET state='FAILED' WHERE id='T-1'").run();
  store.db.prepare("UPDATE stages SET status='FAILED' WHERE task_id='T-1'").run();
  const rebuilt = store.rebuildTaskProjection('T-1');

  assert.equal(rebuilt.taskState, 'QUEUED');
  assert.equal(store.getTask('T-1').state, 'QUEUED');
  assert.equal(store.listStages('T-1')[0].status, 'COMPLETED');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('upgrades persisted plans with approval status', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-store-migration-'));
  const databaseFile = join(dir, 'state.sqlite');
  const legacyDatabase = new DatabaseSync(databaseFile);

  legacyDatabase.exec(`
    CREATE TABLE plans (
      task_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      plan TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(task_id, version)
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      stage_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      status TEXT NOT NULL,
      harness TEXT NOT NULL,
      session_id TEXT,
      workspace TEXT,
      commit_sha TEXT,
      started_at TEXT,
      finished_at TEXT
    );
  `);
  legacyDatabase.close();

  const store = new Store(databaseFile);
  const statusColumn = store.db
    .prepare('PRAGMA table_info(plans)')
    .all()
    .find((column) => column.name === 'status');

  assert.ok(statusColumn);
  assert.equal(statusColumn.dflt_value, "'APPROVED'");
  assert.ok(
    store.db
      .prepare('PRAGMA table_info(runs)')
      .all()
      .some((column) => column.name === 'turn_id'),
  );
  assert.equal(
    store.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
    CURRENT_SCHEMA_VERSION,
  );
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
