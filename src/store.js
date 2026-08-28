import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  TASK_STATE,
  STAGE_STATUS,
  PLAN_STATUS,
  OPERATOR_ACTION,
  assertValidTaskTransition,
  validateCompletionDecision,
  validateNormalizedEvent,
  validateResultManifest,
} from './domain.js';
import { applyMigrations } from './migrations.js';
import { redactSecrets } from './security.js';
import { evaluateEvidence, verificationEnvironment } from './trust.js';

export class Store {
  constructor(file) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.transactionDepth = 0;
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    applyMigrations(this.db);
  }
  close() {
    this.db.close();
  }
  runInTransaction(operation) {
    if (this.transactionDepth > 0) return operation();
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth += 1;
    try {
      const result = operation();

      this.db.exec('COMMIT');

      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }
  createTask(contract) {
    return this.runInTransaction(() => {
      const now = new Date().toISOString();

      this.db
        .prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?)')
        .run(contract.id, JSON.stringify(contract), TASK_STATE.DRAFT, now, now);
      this.appendEvent(contract.id, 'TASK_CREATED', { state: TASK_STATE.DRAFT, contract });
    });
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
    return this.runInTransaction(() => {
      const now = new Date().toISOString();

      this.db.prepare('UPDATE tasks SET state=?,updated_at=? WHERE id=?').run(state, now, id);
      this.appendEvent(id, 'TASK_STATE_CHANGED', { state });
    });
  }
  requestInterrupt(taskId, actor = 'local-user') {
    return this.runInTransaction(() => {
      const requestedAt = new Date().toISOString();

      this.db
        .prepare(
          'INSERT INTO interrupt_requests (task_id,actor,requested_at) VALUES (?,?,?) ON CONFLICT(task_id) DO UPDATE SET actor=excluded.actor,requested_at=excluded.requested_at',
        )
        .run(taskId, actor, requestedAt);
      this.appendEvent(taskId, 'INTERRUPT_REQUESTED', { actor, requestedAt });

      return { taskId, actor, requestedAt };
    });
  }
  isInterruptRequested(taskId) {
    return Boolean(
      this.db.prepare('SELECT task_id FROM interrupt_requests WHERE task_id=?').get(taskId),
    );
  }
  clearInterruptRequest(taskId) {
    this.db.prepare('DELETE FROM interrupt_requests WHERE task_id=?').run(taskId);
  }
  createHarnessApproval({ id, taskId, runId, method, params }) {
    return this.runInTransaction(() => {
      const requestedAt = new Date().toISOString();

      this.db
        .prepare(
          'INSERT INTO harness_approvals (id,task_id,run_id,method,params,requested_at) VALUES (?,?,?,?,?,?)',
        )
        .run(id, taskId, runId, method, JSON.stringify(params), requestedAt);
      this.appendEvent(taskId, 'HARNESS_APPROVAL_REQUESTED', {
        approvalId: id,
        runId,
        method,
        requestedAt,
      });

      return { id, taskId, runId, method, params, requestedAt };
    });
  }
  getHarnessApproval(id) {
    const row = this.db.prepare('SELECT * FROM harness_approvals WHERE id=?').get(id);

    return row ? { ...row, params: JSON.parse(row.params) } : null;
  }
  decideHarnessApproval(id, decision, actor = 'local-user') {
    if (!['accept', 'acceptForSession', 'decline', 'cancel'].includes(decision))
      throw new Error(`unsupported harness approval decision: ${decision}`);

    return this.runInTransaction(() => {
      const approval = this.getHarnessApproval(id);

      if (!approval) throw new Error(`harness approval not found: ${id}`);
      if (approval.decision) throw new Error(`harness approval ${id} is already decided`);
      const decidedAt = new Date().toISOString();

      this.db
        .prepare('UPDATE harness_approvals SET decision=?,actor=?,decided_at=? WHERE id=?')
        .run(decision, actor, decidedAt, id);
      this.appendEvent(approval.task_id, 'HARNESS_APPROVAL_DECIDED', {
        approvalId: id,
        decision,
        actor,
        decidedAt,
      });

      return { ...approval, decision, actor, decidedAt };
    });
  }
  listHarnessApprovals(taskId) {
    return this.db
      .prepare('SELECT * FROM harness_approvals WHERE task_id=? ORDER BY requested_at')
      .all(taskId)
      .map((row) => ({ ...row, params: JSON.parse(row.params) }));
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
      .map((stageRow) => ({ ...stageRow, depends_on: JSON.parse(stageRow.depends_on) }));
  }
  setStage(taskId, id, status) {
    return this.runInTransaction(() => {
      this.db
        .prepare('UPDATE stages SET status=? WHERE task_id=? AND id=?')
        .run(status, taskId, id);
      this.appendEvent(taskId, 'STAGE_STATE_CHANGED', { stageId: id, status });
    });
  }
  createRun(run) {
    this.db
      .prepare(
        'INSERT INTO runs (id,task_id,stage_id,attempt,status,harness,session_id,turn_id,workspace,started_at,profile,policy,runtime_namespace) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
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
        run.profile ?? null,
        run.policy ? JSON.stringify(run.policy) : null,
        run.runtimeNamespace ? JSON.stringify(run.runtimeNamespace) : null,
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
  listRuns(taskId, { stageId = null, attempt = null } = {}) {
    const conditions = ['task_id=?'];
    const params = [taskId];

    if (stageId !== null) {
      conditions.push('stage_id=?');
      params.push(stageId);
    }
    if (attempt !== null) {
      conditions.push('attempt=?');
      params.push(attempt);
    }

    return this.db
      .prepare(`SELECT * FROM runs WHERE ${conditions.join(' AND ')} ORDER BY rowid`)
      .all(...params)
      .map(parseRun);
  }
  listAllRuns() {
    return this.db.prepare('SELECT * FROM runs ORDER BY rowid').all().map(parseRun);
  }
  appendEvent(taskId, type, payload) {
    const safePayload = redactSecrets(payload);
    const event = validateNormalizedEvent({
      task_id: taskId,
      type,
      payload: safePayload,
      at: new Date().toISOString(),
      version: 1,
    });

    this.db
      .prepare('INSERT INTO events (task_id,type,payload,at,version) VALUES (?,?,?,?,1)')
      .run(event.task_id, event.type, JSON.stringify(event.payload), event.at);
    try {
      if (typeof this.eventObserver === 'function') this.eventObserver({ ...event });
      else this.eventObserver?.onEvent?.({ ...event });
    } catch {
      // Telemetry is diagnostic and must never alter durable task behavior.
    }
  }
  setEventObserver(observer) {
    this.eventObserver = observer;
    observer?.setStore?.(this);
  }
  getTelemetryTask(taskId) {
    const row = this.db.prepare('SELECT * FROM telemetry_tasks WHERE task_id=?').get(taskId);

    return row ? { ...row, rootSpanContext: JSON.parse(row.root_span_context) } : null;
  }
  saveTelemetryTask(taskId, context) {
    this.db
      .prepare(
        'INSERT INTO telemetry_tasks (task_id,trace_id,root_span_id,root_span_context,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET trace_id=excluded.trace_id,root_span_id=excluded.root_span_id,root_span_context=excluded.root_span_context,updated_at=excluded.updated_at',
      )
      .run(
        taskId,
        context.traceId,
        context.spanId,
        JSON.stringify(context),
        new Date().toISOString(),
      );
  }
  getTelemetryRun(runId) {
    const row = this.db.prepare('SELECT * FROM telemetry_runs WHERE run_id=?').get(runId);

    return row ? { ...row, spanContext: JSON.parse(row.span_context) } : null;
  }
  saveTelemetryRun(runId, taskId, context) {
    this.db
      .prepare(
        'INSERT INTO telemetry_runs (run_id,task_id,span_id,span_context,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET span_id=excluded.span_id,span_context=excluded.span_context,updated_at=excluded.updated_at',
      )
      .run(runId, taskId, context.spanId, JSON.stringify(context), new Date().toISOString());
  }
  listEvents(taskId) {
    return this.db
      .prepare(
        'SELECT seq,task_id,type,payload,at,version FROM events WHERE task_id=? ORDER BY seq',
      )
      .all(taskId)
      .map((eventRow) => ({ ...eventRow, payload: JSON.parse(eventRow.payload) }));
  }
  listVerification(taskId) {
    return this.listEvents(taskId)
      .filter((event) => event.type === 'VERIFICATION_RECORDED')
      .map((event) => event.payload);
  }
  listOperatorActions(taskId) {
    return this.db
      .prepare('SELECT * FROM operator_actions WHERE task_id=? ORDER BY at, id')
      .all(taskId);
  }
  recordOperatorAction(requestOrTaskId, positionalAction, positionalOptions = {}) {
    const request =
      typeof requestOrTaskId === 'string'
        ? { taskId: requestOrTaskId, action: positionalAction, ...positionalOptions }
        : requestOrTaskId;
    const {
      taskId,
      action,
      stageId = null,
      attempt = null,
      actor = 'local-user',
      reason = null,
      expectedRevision = null,
    } = request;

    if (!taskId || !actor) throw new Error('operator action taskId and actor are required');
    const normalizedAction = typeof action === 'string' ? action.toLowerCase() : action;

    if (!Object.values(OPERATOR_ACTION).includes(normalizedAction))
      throw new Error(`unsupported operator action: ${action}`);
    const id = randomUUID();
    const at = new Date().toISOString();

    this.db
      .prepare(
        'INSERT INTO operator_actions (id,task_id,action,stage_id,attempt,actor,reason,expected_revision,at) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(id, taskId, normalizedAction, stageId, attempt, actor, reason, expectedRevision, at);
    this.appendEvent(taskId, 'OPERATOR_ACTION_RECORDED', {
      id,
      action: normalizedAction,
      stageId,
      attempt,
      actor,
      reason,
      expectedRevision,
      at,
    });

    return {
      id,
      taskId,
      action: normalizedAction,
      stageId,
      attempt,
      actor,
      reason,
      expectedRevision,
      at,
    };
  }
  getCompletion(taskId) {
    const row = this.db.prepare('SELECT * FROM completions WHERE task_id=?').get(taskId);

    return row ? { ...row, manifest: JSON.parse(row.manifest) } : null;
  }
  recordCompletion(decision, manifest) {
    const normalized = validateCompletionDecision(decision);
    const result = validateResultManifest(manifest);

    if (normalized.taskId !== result.taskId)
      throw new Error('completion task and result manifest task do not match');

    return this.runInTransaction(() => {
      const task = this.getTask(normalized.taskId);

      if (!task) throw new Error(`task not found: ${normalized.taskId}`);
      if (task.state !== TASK_STATE.READY)
        throw new Error(`task ${task.id} must be READY before completion`);
      const currentResult = this.getResultManifest(task.id);

      if (currentResult.revision !== normalized.expectedRevision)
        throw new Error('completion revision is not the current READY revision');
      if (result.revision && result.revision !== normalized.expectedRevision)
        throw new Error('completion revision does not match result manifest');
      if (this.getCompletion(task.id)) throw new Error(`task ${task.id} is already completed`);
      const at = new Date().toISOString();

      assertValidTaskTransition(task.state, TASK_STATE.COMPLETED);
      this.db
        .prepare(
          'INSERT INTO completions (task_id,expected_revision,decision,note,actor,at,manifest) VALUES (?,?,?,?,?,?,?)',
        )
        .run(
          task.id,
          normalized.expectedRevision,
          normalized.decision,
          normalized.note,
          normalized.actor,
          at,
          JSON.stringify(result),
        );
      this.recordOperatorAction({
        taskId: task.id,
        action: OPERATOR_ACTION.COMPLETE,
        actor: normalized.actor,
        reason: normalized.note,
        expectedRevision: normalized.expectedRevision,
      });
      this.setTaskState(task.id, TASK_STATE.COMPLETED);
      this.appendEvent(task.id, 'TASK_COMPLETED', {
        expectedRevision: normalized.expectedRevision,
        decision: normalized.decision,
        actor: normalized.actor,
        note: normalized.note,
        at,
      });

      return this.getCompletion(task.id);
    });
  }
  saveCompletion(taskId, revision, manifest, { actor = 'local-user', note = null } = {}) {
    const current = this.getResultManifest(taskId);

    return this.recordCompletion(
      { taskId, expectedRevision: revision, actor, note },
      { ...current, ...manifest, taskId, revision },
    );
  }
  latestVerification(taskId, stageId = null) {
    const reports = this.listEvents(taskId)
      .filter((event) => event.type === 'VERIFICATION_RECORDED')
      .map((event) => event.payload)
      .filter((report) => stageId === null || report.stageId === stageId);

    return reports.at(-1) ?? null;
  }
  evaluateTaskTrust(taskId, context = {}) {
    const report = this.latestVerification(taskId);
    const task = this.getTask(taskId);
    const revision = context.revision ?? report?.revision;
    const policy = context.policy ?? this.listRuns(taskId).at(-1)?.policy ?? {};
    const evaluated = (report?.evidence ?? []).map((item) => ({
      ...item,
      trust: evaluateEvidence(item, {
        ...context,
        revision,
        policy,
        environment:
          context.environment ??
          verificationEnvironment({ command: item.command, cwd: report.workspace, revision }),
      }),
    }));
    const result = {
      evidence: evaluated,
      evaluated,
      reusable: evaluated.some((item) => item.trust.reusable),
    };

    if (task?.state === TASK_STATE.READY && !result.reusable) {
      this.runInTransaction(() => {
        this.setTaskState(taskId, TASK_STATE.VERIFYING);
        this.appendEvent(taskId, 'READY_INVALIDATED', {
          reason: result.evaluated.map((item) => item.trust.reason),
          ...context,
        });
      });
    }

    return result;
  }
  latestReview(taskId) {
    return (
      this.listEvents(taskId)
        .filter((event) => event.type === 'REVIEW_RECORDED')
        .map((event) => event.payload)
        .at(-1) ?? null
    );
  }
  getResultManifest(taskId) {
    const task = this.getTask(taskId);

    if (!task) throw new Error(`task not found: ${taskId}`);
    const runs = this.listRuns(taskId);
    const latestCompletedRun = [...runs].reverse().find((run) => run.status === 'COMPLETED');
    const latestVerification = this.latestVerification(taskId);
    const manifest = {
      version: 1,
      taskId,
      state: task.state,
      contract: task.contract,
      attention: task.state === TASK_STATE.WAITING_FOR_HUMAN ? 'HUMAN_ACTION_REQUIRED' : null,
      plan: this.getLatestPlan(taskId),
      attempts: runs.map((run) => ({
        id: run.id,
        stageId: run.stage_id,
        attempt: run.attempt,
        status: run.status,
        harness: run.harness,
        profile: run.profile,
        workspace: run.workspace,
        runtimeNamespace: run.runtimeNamespace,
        revision: run.commit_sha,
        startedAt: run.started_at,
        finishedAt: run.finished_at,
      })),
      revision: latestCompletedRun?.commit_sha ?? latestVerification?.revision ?? null,
      baseRevision: task.contract.base_ref,
      resultRevision: latestCompletedRun?.commit_sha ?? latestVerification?.revision ?? null,
      diffSummary: {
        baseRevision: task.contract.base_ref,
        resultRevision: latestCompletedRun?.commit_sha ?? latestVerification?.revision ?? null,
        changed: Boolean(latestCompletedRun?.commit_sha ?? latestVerification?.revision),
      },
      evidence: latestVerification?.evidence ?? [],
      evidenceCoverage: latestVerification
        ? [...new Set(latestVerification.evidence.flatMap((item) => item.acceptanceCriteria ?? []))]
        : [],
      review: this.latestReview(taskId),
      workspace: latestCompletedRun?.workspace ?? latestVerification?.workspace ?? null,
      completion: this.getCompletion(taskId),
    };

    return validateResultManifest(manifest);
  }
  recordVerification({
    taskId,
    stageId = 'worker',
    revision,
    actor = 'local-user',
    evidence,
    rationale = 'Verification rerun against the pinned revision',
    skippedChecks = [],
  }) {
    const task = this.getTask(taskId);

    if (!task) throw new Error(`task not found: ${taskId}`);
    const run = [...this.listRuns(taskId, { stageId })]
      .reverse()
      .find((item) => item.commit_sha === revision);

    if (!run) throw new Error(`revision ${revision} is not a known ${stageId} run revision`);
    const normalizedEvidence = (
      evidence ??
      this.latestVerification(taskId, stageId)?.evidence ??
      []
    ).map((item) => {
      const environment = verificationEnvironment({
        command: item.command,
        cwd: run.workspace,
        revision,
      });

      return {
        ...item,
        revision,
        endedAt: new Date().toISOString(),
        environment,
        environmentFingerprint: environment.fingerprint,
      };
    });
    const report = {
      taskId,
      stageId,
      runId: run.id,
      attempt: run.attempt,
      workspace: run.workspace,
      evidence: normalizedEvidence,
      revision,
      rationale,
      skippedChecks,
      reverifiedBy: actor,
    };
    const normalized = this.runInTransaction(() => {
      this.recordOperatorAction({
        taskId,
        action: OPERATOR_ACTION.VERIFY,
        stageId,
        attempt: run.attempt,
        actor,
        expectedRevision: revision,
      });
      this.appendEvent(taskId, 'VERIFICATION_RECORDED', report);
      if (
        task.state === TASK_STATE.VERIFYING &&
        normalizedEvidence.some((item) => item.result === 'passed')
      )
        this.setTaskState(taskId, TASK_STATE.READY);

      return report;
    });

    return normalized;
  }
  rebuildTaskProjection(taskId) {
    const task = this.getTask(taskId);

    if (!task) throw new Error(`task not found: ${taskId}`);
    const events = this.listEvents(taskId);
    const taskState = events.filter((event) => event.type === 'TASK_STATE_CHANGED').at(-1)
      ?.payload.state;
    const stageStates = new Map();

    for (const event of events)
      if (event.type === 'STAGE_STATE_CHANGED')
        stageStates.set(event.payload.stageId, event.payload.status);

    return this.runInTransaction(() => {
      if (taskState)
        this.db
          .prepare('UPDATE tasks SET state=?,updated_at=? WHERE id=?')
          .run(taskState, new Date().toISOString(), taskId);
      for (const [stageId, status] of stageStates)
        this.db
          .prepare('UPDATE stages SET status=? WHERE task_id=? AND id=?')
          .run(status, taskId, stageId);
      this.appendEvent(taskId, 'PROJECTION_REBUILT', {
        taskState: taskState ?? task.state,
        stageStates: Object.fromEntries(stageStates),
      });

      return {
        taskState: taskState ?? task.state,
        stageStates: Object.fromEntries(stageStates),
      };
    });
  }
}

function parseRun(run) {
  return {
    ...run,
    policy: run.policy ? JSON.parse(run.policy) : null,
    runtimeNamespace: run.runtime_namespace ? JSON.parse(run.runtime_namespace) : null,
  };
}
