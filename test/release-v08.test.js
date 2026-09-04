import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { applyMigrations, CURRENT_SCHEMA_VERSION } from '../src/migrations.js';

test('upgrades populated v0.7 state with recoverable and unavailable run provenance', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clew-v08-migration-'));
  const databaseFile = join(directory, 'state.sqlite');
  const database = new DatabaseSync(databaseFile);
  const at = '2026-09-03T00:00:00.000Z';
  const contract = {
    id: 'V07-1',
    title: 'Preserved v0.7 task',
    goal: 'Keep task, run, session, and event history',
    profile: 'standard',
    base_ref: 'HEAD',
    acceptance: [{ id: 'AC-1', criterion: 'state survives migration' }],
  };

  applyMigrations(database, { through: 20 });
  database.exec(`
    ALTER TABLE runs DROP COLUMN provenance_status;
    ALTER TABLE runs DROP COLUMN branch;
    ALTER TABLE runs DROP COLUMN base_sha;
  `);
  database
    .prepare('INSERT INTO tasks(id,contract,state,created_at,updated_at,tags) VALUES (?,?,?,?,?,?)')
    .run(contract.id, JSON.stringify(contract), 'READY', at, at, '["release"]');
  database
    .prepare('INSERT INTO stages(task_id,id,status,depends_on) VALUES (?,?,?,?)')
    .run(contract.id, 'worker', 'COMPLETED', '[]');
  const insertRun = database.prepare(`
    INSERT INTO runs
      (id,task_id,stage_id,attempt,status,harness,workspace,commit_sha,started_at,finished_at,profile,policy,runtime_namespace,execution_mode)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  insertRun.run(
    'v07-recoverable',
    contract.id,
    'worker',
    1,
    'COMPLETED',
    'codex',
    '/private/v07-worktree',
    'v07-revision',
    at,
    at,
    'standard',
    '{}',
    '"v07-runtime"',
    'local',
  );
  insertRun.run(
    'v07-unavailable',
    contract.id,
    'worker',
    2,
    'FAILED',
    'codex',
    null,
    null,
    at,
    at,
    'standard',
    '{}',
    '"v07-runtime-2"',
    'local',
  );
  database.prepare('INSERT INTO events(task_id,type,payload,at,version) VALUES (?,?,?,?,1)').run(
    contract.id,
    'STAGE_RUN_STARTED',
    JSON.stringify({
      id: 'v07-recoverable',
      baseSha: 'v07-base',
      branch: 'ai/V07-1-worker',
    }),
    at,
  );
  database
    .prepare(
      'INSERT INTO agent_sessions(id,task_id,role,harness,session_id,workspace,created_at) VALUES (?,?,?,?,?,?,?)',
    )
    .run(
      'v07-session-record',
      contract.id,
      'worker',
      'codex',
      'v07-session',
      '/private/v07-worktree',
      at,
    );
  assert.equal(
    database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
    20,
  );
  database.close();

  const store = new Store(databaseFile);
  const recovered = store.getRun('v07-recoverable');
  const unavailable = store.getRun('v07-unavailable');

  assert.equal(
    store.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
    CURRENT_SCHEMA_VERSION,
  );
  assert.equal(store.getTask(contract.id).contract.title, contract.title);
  assert.equal(recovered.base_sha, 'v07-base');
  assert.equal(recovered.branch, 'ai/V07-1-worker');
  assert.equal(recovered.provenanceStatus, 'available');
  assert.equal(unavailable.provenanceStatus, 'unavailable');
  assert.equal(store.listAgentSessions(contract.id)[0].session_id, 'v07-session');
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
