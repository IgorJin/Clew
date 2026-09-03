import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';
import { applyMigrations, CURRENT_SCHEMA_VERSION } from '../src/migrations.js';

test('upgrades populated v0.5 state to v0.6 without changing local execution truth', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clew-v06-migration-'));
  const databaseFile = join(directory, 'state.sqlite');
  const database = new DatabaseSync(databaseFile);
  const at = '2026-09-01T00:00:00.000Z';
  const contract = {
    id: 'V05-1',
    title: 'Preserved v0.5 task',
    goal: 'Keep local terminal-era history',
    profile: 'standard',
    base_ref: 'HEAD',
    acceptance: [{ id: 'AC-1', criterion: 'state survives migration' }],
  };

  applyMigrations(database, { through: 16 });
  database
    .prepare('INSERT INTO tasks VALUES (?,?,?,?,?)')
    .run(contract.id, JSON.stringify(contract), 'READY', at, at);
  database
    .prepare('INSERT INTO stages VALUES (?,?,?,?)')
    .run(contract.id, 'worker', 'COMPLETED', '[]');
  database
    .prepare(
      `INSERT INTO runs
        (id,task_id,stage_id,attempt,status,harness,session_id,turn_id,workspace,commit_sha,started_at,finished_at,profile,policy,runtime_namespace)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      'v05-run',
      contract.id,
      'worker',
      1,
      'COMPLETED',
      'codex',
      'v05-session',
      'v05-turn',
      '/private/v05-worktree',
      'v05-revision',
      at,
      at,
      'standard',
      JSON.stringify({ review: true }),
      JSON.stringify({ value: 'v05-runtime' }),
    );
  database
    .prepare('INSERT INTO events(task_id,type,payload,at,version) VALUES (?,?,?,?,1)')
    .run(contract.id, 'TASK_CREATED', JSON.stringify({ source: 'v0.5' }), at);
  database
    .prepare(
      'INSERT INTO workflow_actions(id,task_id,kind,descriptor,status,actor,created_at,approved_at) VALUES (?,?,?,?,?,?,?,?)',
    )
    .run('v05-action', contract.id, 'finish_worker', '{}', 'completed', 'v05-user', at, at);
  assert.equal(
    database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
    16,
  );
  database.close();

  const store = new Store(databaseFile);
  const run = store.getRun('v05-run');

  assert.equal(
    store.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,
    CURRENT_SCHEMA_VERSION,
  );
  assert.equal(store.getTask(contract.id).state, 'READY');
  assert.equal(store.listEvents(contract.id)[0].payload.source, 'v0.5');
  assert.equal(run.execution_mode, 'local');
  assert.equal(run.workspace, '/private/v05-worktree');
  assert.equal(run.workspace_ref, null);
  assert.equal(run.runner_id, null);
  assert.equal(store.listRunnerLeases().length, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM runner_peers').get().count, 0);
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
