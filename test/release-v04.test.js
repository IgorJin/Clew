import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { CURRENT_SCHEMA_VERSION } from '../src/migrations.js';

test('upgrades a populated v0.3 database through the v0.4 control-plane migrations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-v04-migration-'));
  const databaseFile = join(dir, 'state.sqlite');
  const database = new DatabaseSync(databaseFile);

  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE tasks (id TEXT PRIMARY KEY, contract TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE stages (task_id TEXT NOT NULL, id TEXT NOT NULL, status TEXT NOT NULL, depends_on TEXT NOT NULL, PRIMARY KEY(task_id,id));
    CREATE TABLE plans (task_id TEXT NOT NULL, version INTEGER NOT NULL, plan TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'APPROVED', created_at TEXT NOT NULL, PRIMARY KEY(task_id,version));
    CREATE TABLE runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, stage_id TEXT NOT NULL, attempt INTEGER NOT NULL, status TEXT NOT NULL, harness TEXT NOT NULL, session_id TEXT, turn_id TEXT, workspace TEXT, commit_sha TEXT, started_at TEXT, finished_at TEXT, profile TEXT, policy TEXT, runtime_namespace TEXT);
    CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE operator_actions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, action TEXT NOT NULL, stage_id TEXT, attempt INTEGER, actor TEXT NOT NULL, reason TEXT, expected_revision TEXT, at TEXT NOT NULL);
    CREATE TABLE completions (task_id TEXT PRIMARY KEY, expected_revision TEXT NOT NULL, decision TEXT NOT NULL, note TEXT, actor TEXT NOT NULL, at TEXT NOT NULL, manifest TEXT NOT NULL);
    CREATE TABLE telemetry_tasks (task_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, root_span_id TEXT NOT NULL, root_span_context TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE telemetry_runs (run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, span_id TEXT NOT NULL, span_context TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE telemetry_exports (task_id TEXT NOT NULL, event_key TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY(task_id,event_key));
    CREATE TABLE usage_records (id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL, run_id TEXT NOT NULL, stage_id TEXT NOT NULL, attempt INTEGER NOT NULL, session_id TEXT, turn_id TEXT, provider TEXT, harness TEXT NOT NULL, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER, completeness TEXT NOT NULL, source TEXT NOT NULL, recorded_at TEXT NOT NULL);
    CREATE TABLE pricing_snapshots (id TEXT PRIMARY KEY, source TEXT NOT NULL, provider TEXT, currency TEXT NOT NULL, catalog TEXT NOT NULL, fetched_at TEXT NOT NULL, effective_from TEXT NOT NULL, checksum TEXT NOT NULL UNIQUE);
    CREATE TABLE usage_costs (usage_id TEXT PRIMARY KEY, pricing_snapshot_id TEXT, amount TEXT, currency TEXT, status TEXT NOT NULL, calculated_at TEXT NOT NULL);
    INSERT INTO schema_migrations(version, applied_at) VALUES
      (1,'2026-01-01T00:00:00.000Z'),(2,'2026-01-01T00:00:00.000Z'),(3,'2026-01-01T00:00:00.000Z'),
      (4,'2026-01-01T00:00:00.000Z'),(5,'2026-01-01T00:00:00.000Z'),(6,'2026-01-01T00:00:00.000Z'),
      (7,'2026-01-01T00:00:00.000Z'),(8,'2026-01-01T00:00:00.000Z'),(9,'2026-01-01T00:00:00.000Z'),
      (10,'2026-01-01T00:00:00.000Z'),(11,'2026-01-01T00:00:00.000Z');
    INSERT INTO tasks VALUES ('V03-1','{"id":"V03-1","title":"Preserved task","goal":"Keep history","acceptance":[{"id":"AC-1","criterion":"history survives"}],"profile":"standard","base_ref":"HEAD"}','READY','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    INSERT INTO stages VALUES ('V03-1','worker','COMPLETED','[]');
    INSERT INTO plans VALUES ('V03-1',1,'{"stages":[{"id":"worker","dependsOn":[]}]}','APPROVED','2026-01-01T00:00:00.000Z');
    INSERT INTO runs VALUES ('v03-run','V03-1','worker',1,'COMPLETED','fake','v03-session','v03-turn','/tmp/v03-worktree','v03-revision','2026-01-01T00:00:00.000Z','2026-01-01T00:01:00.000Z','standard','{"maxAttempts":3}','"v03-runtime"');
    INSERT INTO events(task_id,type,payload,at) VALUES ('V03-1','TASK_CREATED','{"source":"v0.3"}','2026-01-01T00:00:00.000Z');
    INSERT INTO operator_actions VALUES ('v03-action','V03-1','VERIFY','worker',1,'v03-user','legacy evidence','v03-revision','2026-01-01T00:02:00.000Z');
    INSERT INTO completions VALUES ('V03-1','v03-revision','accept','preserved','v03-user','2026-01-01T00:03:00.000Z','{"taskId":"V03-1","revision":"v03-revision"}');
    INSERT INTO telemetry_tasks VALUES ('V03-1','v03-trace','v03-root-span','{"traceId":"v03-trace"}','2026-01-01T00:03:30.000Z');
    INSERT INTO telemetry_runs VALUES ('v03-run','V03-1','v03-run-span','{"traceId":"v03-trace"}','2026-01-01T00:03:40.000Z');
    INSERT INTO telemetry_exports VALUES ('V03-1','v03-event','exported',1,'2026-01-01T00:03:50.000Z');
    INSERT INTO usage_records VALUES ('v03-usage','v03-usage-key','V03-1','v03-run','worker',1,'v03-session','v03-turn','test','fake','fixture',10,5,NULL,NULL,NULL,'complete','v0.3','2026-01-01T00:04:00.000Z');
  `);
  database.close();

  const store = new Store(databaseFile);

  assert.equal(
    store.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
    CURRENT_SCHEMA_VERSION,
  );
  assert.equal(store.getTask('V03-1').contract.title, 'Preserved task');
  assert.equal(store.listRuns('V03-1')[0].session_id, 'v03-session');
  assert.equal(store.listEvents('V03-1')[0].payload.source, 'v0.3');
  assert.equal(store.getCompletion('V03-1').actor, 'v03-user');
  assert.equal(store.listOperatorActions('V03-1')[0].id, 'v03-action');
  assert.equal(store.listUsage('V03-1')[0].idempotency_key, 'v03-usage-key');
  assert.equal(
    store.db.prepare("SELECT trace_id FROM telemetry_tasks WHERE task_id='V03-1'").get().trace_id,
    'v03-trace',
  );
  assert.equal(
    store.db.prepare("SELECT span_id FROM telemetry_runs WHERE run_id='v03-run'").get().span_id,
    'v03-run-span',
  );
  assert.equal(
    store.db.prepare("SELECT status FROM telemetry_exports WHERE task_id='V03-1'").get().status,
    'exported',
  );
  for (const column of ['target'])
    assert.ok(
      store.db
        .prepare('PRAGMA table_info(operator_messages)')
        .all()
        .some((item) => item.name === column),
    );
  for (const column of [
    'idempotency_key',
    'status',
    'correction_run_id',
    'operator_message_id',
    'review_verdict',
  ])
    assert.ok(
      store.db
        .prepare('PRAGMA table_info(continuation_grants)')
        .all()
        .some((item) => item.name === column),
    );
  for (const column of ['idempotency_key', 'unresolved_findings'])
    assert.ok(
      store.db
        .prepare('PRAGMA table_info(completion_overrides)')
        .all()
        .some((item) => item.name === column),
    );
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
