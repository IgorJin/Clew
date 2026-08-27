import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TASK_STATE, STAGE_STATUS, PLAN_STATUS } from './domain.js';

export class Store {
  constructor(file) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, contract TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS stages (task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, id TEXT NOT NULL, status TEXT NOT NULL, depends_on TEXT NOT NULL, PRIMARY KEY(task_id,id));
      CREATE TABLE IF NOT EXISTS plans (task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, version INTEGER NOT NULL, plan TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'APPROVED', created_at TEXT NOT NULL, PRIMARY KEY(task_id,version));
      CREATE TABLE IF NOT EXISTS approvals (seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, plan_version INTEGER NOT NULL, gate_id TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT, actor TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS interrupt_requests (task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, actor TEXT NOT NULL, requested_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, stage_id TEXT NOT NULL, attempt INTEGER NOT NULL, status TEXT NOT NULL, harness TEXT NOT NULL, session_id TEXT, turn_id TEXT, workspace TEXT, commit_sha TEXT, started_at TEXT, finished_at TEXT);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, type TEXT NOT NULL, payload TEXT NOT NULL, at TEXT NOT NULL);`);
    const planColumns = this.db.prepare('PRAGMA table_info(plans)').all();

    if (!planColumns.some((column) => column.name === 'status'))
      this.db.exec("ALTER TABLE plans ADD COLUMN status TEXT NOT NULL DEFAULT 'APPROVED'");
    const runColumns = this.db.prepare('PRAGMA table_info(runs)').all();

    if (!runColumns.some((column) => column.name === 'turn_id'))
      this.db.exec('ALTER TABLE runs ADD COLUMN turn_id TEXT');
  }
  close() {
    this.db.close();
  }
  runInTransaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();

      this.db.exec('COMMIT');

      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  createTask(contract) {
    const now = new Date().toISOString();

    this.db
      .prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?)')
      .run(contract.id, JSON.stringify(contract), TASK_STATE.DRAFT, now, now);
    this.appendEvent(contract.id, 'TASK_CREATED', { state: TASK_STATE.DRAFT, contract });
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
  requestInterrupt(taskId, actor = 'local-user') {
    const requestedAt = new Date().toISOString();

    this.db
      .prepare(
        'INSERT INTO interrupt_requests (task_id,actor,requested_at) VALUES (?,?,?) ON CONFLICT(task_id) DO UPDATE SET actor=excluded.actor,requested_at=excluded.requested_at',
      )
      .run(taskId, actor, requestedAt);
    this.appendEvent(taskId, 'INTERRUPT_REQUESTED', { actor, requestedAt });

    return { taskId, actor, requestedAt };
  }
  isInterruptRequested(taskId) {
    return Boolean(
      this.db.prepare('SELECT task_id FROM interrupt_requests WHERE task_id=?').get(taskId),
    );
  }
  clearInterruptRequest(taskId) {
    this.db.prepare('DELETE FROM interrupt_requests WHERE task_id=?').run(taskId);
  }
  addStage(taskId, id, dependsOn = [], status = STAGE_STATUS.QUEUED) {
    this.db
      .prepare('INSERT OR IGNORE INTO stages VALUES (?, ?, ?, ?)')
      .run(taskId, id, status, JSON.stringify(dependsOn));
  }
  savePlan(taskId, plan, status = PLAN_STATUS.PENDING_APPROVAL) {
    return this.runInTransaction(() => {
      const latestPlan = this.getLatestPlan(taskId);
      const version = (latestPlan?.version ?? 0) + 1;

      this.db
        .prepare('INSERT INTO plans (task_id,version,plan,status,created_at) VALUES (?,?,?,?,?)')
        .run(taskId, version, JSON.stringify(plan), status, new Date().toISOString());
      this.appendEvent(taskId, 'PLAN_PERSISTED', { version, status, plan });

      return { version, status, plan };
    });
  }
  getLatestPlan(taskId) {
    const row = this.db
      .prepare('SELECT * FROM plans WHERE task_id=? ORDER BY version DESC LIMIT 1')
      .get(taskId);

    return row ? { ...row, plan: JSON.parse(row.plan) } : null;
  }
  decideLatestPlan(
    taskId,
    decision,
    { gateId = 'deep-plan', actor = 'local-user', reason = null } = {},
  ) {
    if (![PLAN_STATUS.APPROVED, PLAN_STATUS.REJECTED].includes(decision))
      throw new Error('plan decision must be APPROVED or REJECTED');

    return this.runInTransaction(() => {
      const plan = this.getLatestPlan(taskId);

      if (!plan) throw new Error(`plan not found for task ${taskId}`);
      if (plan.status !== PLAN_STATUS.PENDING_APPROVAL)
        throw new Error(`plan ${taskId} v${plan.version} is already ${plan.status}`);
      const task = this.getTask(taskId);

      if (task?.state !== TASK_STATE.WAITING_FOR_HUMAN)
        throw new Error(`task ${taskId} is not waiting for plan approval`);
      const at = new Date().toISOString();

      this.db
        .prepare('UPDATE plans SET status=? WHERE task_id=? AND version=?')
        .run(decision, taskId, plan.version);
      this.db
        .prepare(
          'INSERT INTO approvals (task_id,plan_version,gate_id,decision,reason,actor,at) VALUES (?,?,?,?,?,?,?)',
        )
        .run(taskId, plan.version, gateId, decision, reason, actor, at);
      this.appendEvent(
        taskId,
        decision === PLAN_STATUS.APPROVED ? 'PLAN_APPROVED' : 'PLAN_REJECTED',
        {
          version: plan.version,
          gateId,
          decision,
          reason,
          actor,
          at,
        },
      );
      this.setTaskState(
        taskId,
        decision === PLAN_STATUS.APPROVED ? TASK_STATE.PLAN_READY : TASK_STATE.FAILED,
      );

      return { ...plan, status: decision, decision: { gateId, actor, reason, at } };
    });
  }
  listApprovals(taskId) {
    return this.db.prepare('SELECT * FROM approvals WHERE task_id=? ORDER BY seq').all(taskId);
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
        'INSERT INTO runs (id,task_id,stage_id,attempt,status,harness,session_id,turn_id,workspace,started_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        run.id,
        run.taskId,
        run.stageId,
        run.attempt,
        run.status,
        run.harness,
        run.sessionId ?? null,
        run.turnId ?? null,
        run.workspace ?? null,
        run.startedAt ?? null,
      );
  }
  setRunIdentity(id, sessionId, turnId = null) {
    this.db.prepare('UPDATE runs SET session_id=?,turn_id=? WHERE id=?').run(sessionId, turnId, id);
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
