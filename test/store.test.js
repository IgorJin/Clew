import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { CURRENT_SCHEMA_VERSION } from '../src/migrations.js';
import { verificationEnvironment } from '../src/trust.js';

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
  assert.equal(store.listRuns('T-1')[0].runtimeNamespace, null);
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

test('invalidates READY when persisted verification environment becomes stale', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-trust-projection-'));
  const store = new Store(join(dir, 'state.sqlite'));

  store.createTask({
    id: 'TRUST-1',
    title: 'Trust',
    goal: 'Trust',
    profile: 'quick',
    acceptance: [{ id: 'AC-1', criterion: 'works' }],
  });
  store.addStage('TRUST-1', 'worker');
  store.createRun({
    id: 'trust-run',
    taskId: 'TRUST-1',
    stageId: 'worker',
    attempt: 1,
    status: 'COMPLETED',
    harness: 'fake',
    workspace: '/tmp/trust-worktree',
    commitSha: 'trust-revision',
    profile: 'quick',
    policy: { maxAttempts: 3 },
  });
  store.finishRun('trust-run', 'COMPLETED', 'trust-revision');
  const environment = verificationEnvironment({
    command: 'node --version',
    cwd: '/tmp/trust-worktree',
    revision: 'trust-revision',
  });

  store.setTaskState('TRUST-1', 'READY');
  store.recordVerification({
    taskId: 'TRUST-1',
    stageId: 'worker',
    revision: 'trust-revision',
    actor: 'tester',
    evidence: [
      {
        type: 'command',
        command: 'node --version',
        result: 'passed',
        revision: 'trust-revision',
        endedAt: new Date().toISOString(),
        environment,
        environmentFingerprint: environment.fingerprint,
      },
    ],
  });
  store.db
    .prepare(
      "UPDATE events SET payload=json_set(payload, '$.evidence[0].environmentFingerprint', 'stale') WHERE task_id=? AND type='VERIFICATION_RECORDED'",
    )
    .run('TRUST-1');

  const trust = store.evaluateTaskTrust('TRUST-1', { revision: 'trust-revision' });

  assert.equal(trust.reusable, false);
  assert.equal(store.getTask('TRUST-1').state, 'VERIFYING');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('upgrades a populated v0.1 database without losing task history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-store-migration-'));
  const databaseFile = join(dir, 'state.sqlite');
  const legacyDatabase = new DatabaseSync(databaseFile);

  legacyDatabase.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, contract TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE stages (task_id TEXT NOT NULL, id TEXT NOT NULL, status TEXT NOT NULL, depends_on TEXT NOT NULL, PRIMARY KEY(task_id,id));
    CREATE TABLE plans (
      task_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      plan TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'APPROVED',
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
      turn_id TEXT,
      workspace TEXT,
      commit_sha TEXT,
      started_at TEXT,
      finished_at TEXT,
      profile TEXT,
      policy TEXT
    );
    CREATE TABLE events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      at TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    INSERT INTO schema_migrations(version, applied_at)
      VALUES (1, '2026-01-01T00:00:00.000Z'), (2, '2026-01-01T00:00:00.000Z'),
        (3, '2026-01-01T00:00:00.000Z'), (4, '2026-01-01T00:00:00.000Z'),
        (5, '2026-01-01T00:00:00.000Z'), (6, '2026-01-01T00:00:00.000Z'),
        (7, '2026-01-01T00:00:00.000Z');
    INSERT INTO tasks VALUES ('LEGACY-1', '{"id":"LEGACY-1","title":"Legacy","goal":"Preserve","acceptance":[{"id":"AC-1","criterion":"works"}],"profile":"quick","base_ref":"HEAD"}', 'READY', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO stages VALUES ('LEGACY-1', 'worker', 'COMPLETED', '[]');
    INSERT INTO plans VALUES ('LEGACY-1', 1, '{"stages":[{"id":"worker","dependsOn":[]}]}', 'APPROVED', '2026-01-01T00:00:00.000Z');
    INSERT INTO runs VALUES ('legacy-run', 'LEGACY-1', 'worker', 1, 'COMPLETED', 'fake', 'legacy-session', 'legacy-turn', 'legacy-worktree', 'abc123', '2026-01-01T00:00:00.000Z', '2026-01-01T00:01:00.000Z', 'quick', '{"maxAttempts":3}');
    INSERT INTO events(task_id, type, payload, at) VALUES ('LEGACY-1', 'TASK_CREATED', '{"legacy":true}', '2026-01-01T00:00:00.000Z');
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
  assert.ok(
    store.db
      .prepare('PRAGMA table_info(runs)')
      .all()
      .some((column) => column.name === 'runtime_namespace'),
  );
  assert.equal(
    store.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
    CURRENT_SCHEMA_VERSION,
  );
  assert.equal(store.getTask('LEGACY-1').contract.title, 'Legacy');
  assert.equal(store.listRuns('LEGACY-1')[0].session_id, 'legacy-session');
  assert.equal(store.listEvents('LEGACY-1')[0].type, 'TASK_CREATED');
  assert.equal(
    store.db
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('telemetry_tasks','telemetry_runs','telemetry_exports')",
      )
      .get().count,
    3,
  );
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
