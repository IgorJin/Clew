import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class Store {
  constructor(file) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, contract TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS stages (task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, id TEXT NOT NULL, status TEXT NOT NULL, depends_on TEXT NOT NULL, PRIMARY KEY(task_id,id));
      CREATE TABLE IF NOT EXISTS plans (task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, version INTEGER NOT NULL, plan TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(task_id,version));
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, stage_id TEXT NOT NULL, attempt INTEGER NOT NULL, status TEXT NOT NULL, harness TEXT NOT NULL, session_id TEXT, workspace TEXT, commit_sha TEXT, started_at TEXT, finished_at TEXT);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, type TEXT NOT NULL, payload TEXT NOT NULL, at TEXT NOT NULL);`);
  }
  close() {
    this.db.close();
  }
  createTask(contract) {
    const now = new Date().toISOString();
    this.db
      .prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?)')
      .run(contract.id, JSON.stringify(contract), 'DRAFT', now, now);
    this.appendEvent(contract.id, 'TASK_CREATED', { state: 'DRAFT', contract });
  }
  getTask(id) {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
    return row ? { ...row, contract: JSON.parse(row.contract) } : null;
  }
  listTasks() {
    return this.db
      .prepare('SELECT id, state, created_at, updated_at FROM tasks ORDER BY created_at DESC')
      .all();
  }
  setTaskState(id, state) {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE tasks SET state=?,updated_at=? WHERE id=?').run(state, now, id);
    this.appendEvent(id, 'TASK_STATE_CHANGED', { state });
  }
  addStage(taskId, id, dependsOn = [], status = 'QUEUED') {
    this.db
      .prepare('INSERT OR IGNORE INTO stages VALUES (?, ?, ?, ?)')
      .run(taskId, id, status, JSON.stringify(dependsOn));
  }
  savePlan(taskId, plan) {
    const latestPlan = this.getLatestPlan(taskId);
    const version = (latestPlan?.version ?? 0) + 1;
    this.db
      .prepare('INSERT INTO plans (task_id,version,plan,created_at) VALUES (?,?,?,?)')
      .run(taskId, version, JSON.stringify(plan), new Date().toISOString());
    this.appendEvent(taskId, 'PLAN_PERSISTED', { version, plan });
    return { version, plan };
  }
  getLatestPlan(taskId) {
    const row = this.db
      .prepare('SELECT * FROM plans WHERE task_id=? ORDER BY version DESC LIMIT 1')
      .get(taskId);
    return row ? { ...row, plan: JSON.parse(row.plan) } : null;
  }
  listStages(taskId) {
    return this.db
      .prepare('SELECT * FROM stages WHERE task_id=? ORDER BY rowid')
      .all(taskId)
      .map((x) => ({ ...x, depends_on: JSON.parse(x.depends_on) }));
  }
  setStage(taskId, id, status) {
    this.db.prepare('UPDATE stages SET status=? WHERE task_id=? AND id=?').run(status, taskId, id);
    this.appendEvent(taskId, 'STAGE_STATE_CHANGED', { stageId: id, status });
  }
  createRun(run) {
    this.db
      .prepare(
        'INSERT INTO runs (id,task_id,stage_id,attempt,status,harness,session_id,workspace,started_at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(
        run.id,
        run.taskId,
        run.stageId,
        run.attempt,
        run.status,
        run.harness,
        run.sessionId ?? null,
        run.workspace ?? null,
        run.startedAt ?? null,
      );
  }
  setRunSession(id, sessionId) {
    this.db.prepare('UPDATE runs SET session_id=? WHERE id=?').run(sessionId, id);
  }
  finishRun(id, status, commitSha = null) {
    this.db
      .prepare('UPDATE runs SET status=?,finished_at=?,commit_sha=? WHERE id=?')
      .run(status, new Date().toISOString(), commitSha, id);
  }
  listRuns(taskId) {
    return this.db.prepare('SELECT * FROM runs WHERE task_id=? ORDER BY rowid').all(taskId);
  }
  appendEvent(taskId, type, payload) {
    this.db
      .prepare('INSERT INTO events (task_id,type,payload,at) VALUES (?,?,?,?)')
      .run(taskId, type, JSON.stringify(payload), new Date().toISOString());
  }
  listEvents(taskId) {
    return this.db
      .prepare('SELECT seq,task_id,type,payload,at FROM events WHERE task_id=? ORDER BY seq')
      .all(taskId)
      .map((x) => ({ ...x, payload: JSON.parse(x.payload) }));
  }
}
