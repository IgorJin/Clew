import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
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
import { aggregateUsage, calculateUsageCost, normalizeUsage, snapshotChecksum } from './usage.js';
import { projectDiagnosticEvents, queryTaskThread } from './thread.js';
import {
  LEASE_STATE,
  RUNNER_MESSAGE_KIND,
  RUNNER_PROTOCOL_VERSION,
  assertLeaseTransition,
  createRunnerEnvelope,
  validateRunnerEnvelope,
} from './runner-protocol.js';

export class Store {
  constructor(file) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.transactionDepth = 0;
    this.pendingObservedEvents = [];
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
    const observedEventOffset = this.pendingObservedEvents.length;

    try {
      const result = operation();

      this.db.exec('COMMIT');
      const committedEvents = this.pendingObservedEvents.splice(observedEventOffset);

      for (const event of committedEvents) this.notifyEventObserver(event);

      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.pendingObservedEvents.splice(observedEventOffset);
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }
  createTask(contract) {
    return this.runInTransaction(() => {
      const now = new Date().toISOString();
      const tags =
        Array.isArray(contract.tags) && contract.tags.length ? JSON.stringify(contract.tags) : null;

      this.db
        .prepare('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?)')
        .run(contract.id, JSON.stringify(contract), TASK_STATE.DRAFT, now, now, tags);
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
  registerRunner({
    runnerId,
    protocolVersion = RUNNER_PROTOCOL_VERSION,
    productVersion,
    capabilities = [],
    workspaces = [],
  }) {
    return this.runInTransaction(() => {
      const configured = this.db.prepare('SELECT runner_id FROM runner_peers LIMIT 1').get();

      if (configured && configured.runner_id !== runnerId)
        throw new Error(`configured Runner identity mismatch: ${runnerId}`);
      const now = new Date().toISOString();
      const current = this.db
        .prepare('SELECT connection_generation,registered_at FROM runner_peers WHERE runner_id=?')
        .get(runnerId);
      const generation = (current?.connection_generation ?? 0) + 1;

      this.db
        .prepare(
          `INSERT INTO runner_peers
            (runner_id,protocol_version,product_version,capabilities,workspace_mappings,connection_generation,health_status,registered_at,last_seen_at,disconnected_at,updated_at)
           VALUES (?,?,?,?,?,?, 'healthy', ?,?,NULL,?)
           ON CONFLICT(runner_id) DO UPDATE SET
             protocol_version=excluded.protocol_version,
             product_version=excluded.product_version,
             capabilities=excluded.capabilities,
             workspace_mappings=excluded.workspace_mappings,
             connection_generation=excluded.connection_generation,
             health_status='healthy',
             last_seen_at=excluded.last_seen_at,
             disconnected_at=NULL,
             updated_at=excluded.updated_at`,
        )
        .run(
          runnerId,
          protocolVersion,
          productVersion,
          JSON.stringify([...new Set(capabilities)].sort()),
          JSON.stringify(workspaces),
          generation,
          current?.registered_at ?? now,
          now,
          now,
        );

      return this.getRunnerProjection(runnerId);
    });
  }
  recordRunnerHeartbeat({ runnerId, connectionGeneration }) {
    const runner = this.getRunnerProjection(runnerId);

    if (!runner) throw new Error(`Runner is not registered: ${runnerId}`);
    if (runner.connectionGeneration !== connectionGeneration)
      throw new Error('stale Runner connection generation');
    const now = new Date().toISOString();

    this.db
      .prepare(
        "UPDATE runner_peers SET health_status='healthy',last_seen_at=?,updated_at=? WHERE runner_id=? AND connection_generation=?",
      )
      .run(now, now, runnerId, connectionGeneration);

    return this.getRunnerProjection(runnerId);
  }
  getRunnerProjection(runnerId = null) {
    const row = runnerId
      ? this.db.prepare('SELECT * FROM runner_peers WHERE runner_id=?').get(runnerId)
      : this.db.prepare('SELECT * FROM runner_peers LIMIT 1').get();

    if (!row) return null;

    return {
      runnerId: row.runner_id,
      protocolVersion: row.protocol_version,
      productVersion: row.product_version,
      capabilities: JSON.parse(row.capabilities),
      workspaces: JSON.parse(row.workspace_mappings),
      connectionGeneration: row.connection_generation,
      healthStatus: row.health_status,
      registeredAt: row.registered_at,
      lastSeenAt: row.last_seen_at,
      disconnectedAt: row.disconnected_at,
    };
  }
  markRunnerDisconnected({ runnerId, connectionGeneration = null, reason = 'connection_lost' }) {
    return this.runInTransaction(() => {
      const runner = this.getRunnerProjection(runnerId);

      if (!runner) return null;
      if (connectionGeneration !== null && runner.connectionGeneration !== connectionGeneration)
        return runner;
      const now = new Date().toISOString();

      this.db
        .prepare(
          "UPDATE runner_peers SET health_status='disconnected',disconnected_at=?,updated_at=? WHERE runner_id=?",
        )
        .run(now, now, runnerId);
      const active = this.db
        .prepare(
          'SELECT * FROM runner_leases WHERE runner_id=? AND state IN (?,?) ORDER BY offered_at',
        )
        .all(runnerId, LEASE_STATE.ACCEPTED, LEASE_STATE.RUNNING);

      for (const lease of active) {
        this.transitionRunnerLease(lease, LEASE_STATE.RECOVERING, {
          details: { classification: 'ambiguous_runner_loss', reason },
          at: now,
        });
        this.db
          .prepare(
            'UPDATE runner_leases SET recovery_classification=?,recovery_reason=? WHERE id=?',
          )
          .run('ambiguous_runner_loss', reason, lease.id);
        this.db
          .prepare("UPDATE tasks SET state='RECOVERING',updated_at=? WHERE id=?")
          .run(now, lease.task_id);
        this.appendEvent(lease.task_id, 'RUNNER_RECOVERY_REQUIRED', {
          leaseId: lease.id,
          epoch: lease.epoch,
          runnerId,
          classification: 'ambiguous_runner_loss',
          reason,
        });
      }

      return this.getRunnerProjection(runnerId);
    });
  }
  reconcileRunnerLeasesOnRestart(reason = 'controller_restart') {
    const runner = this.getRunnerProjection();

    if (!runner) return { runner: null, recovering: [] };
    this.markRunnerDisconnected({ runnerId: runner.runnerId, reason });

    return {
      runner: this.getRunnerProjection(runner.runnerId),
      recovering: this.listRunnerLeases({ state: LEASE_STATE.RECOVERING }),
    };
  }
  allocateRunnerLease({ run, lease, offer }) {
    const envelope = validateRunnerEnvelope(offer);

    if (envelope.kind !== RUNNER_MESSAGE_KIND.LEASE_OFFER)
      throw new Error('Runner lease allocation requires a lease offer');

    return this.runInTransaction(() => {
      const runner = this.getRunnerProjection(lease.runnerId);

      if (!runner) throw new Error(`Runner is not registered: ${lease.runnerId}`);
      const stage = this.db
        .prepare('SELECT * FROM stages WHERE task_id=? AND id=?')
        .get(run.taskId, run.stageId);

      if (!stage) throw new Error(`stage not found: ${run.taskId}/${run.stageId}`);
      if (
        envelope.payload.runnerId !== lease.runnerId ||
        envelope.payload.leaseId !== lease.id ||
        envelope.payload.epoch !== lease.epoch ||
        envelope.payload.runId !== run.id
      )
        throw new Error('lease offer does not match allocation');
      const now = new Date().toISOString();

      this.createRun({ ...run, workspace: null });
      this.db
        .prepare(
          "UPDATE runs SET execution_mode='paired',workspace=NULL,workspace_ref=?,runner_id=? WHERE id=?",
        )
        .run(`runner-workspace:${lease.workspaceMappingId}`, lease.runnerId, run.id);
      this.db
        .prepare('UPDATE stages SET status=? WHERE task_id=? AND id=?')
        .run(STAGE_STATUS.RUNNING, run.taskId, run.stageId);
      this.db
        .prepare(
          `INSERT INTO runner_leases
            (id,task_id,stage_id,run_id,attempt,runner_id,epoch,state,workspace_mapping_id,requirements,offered_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          lease.id,
          run.taskId,
          run.stageId,
          run.id,
          run.attempt,
          lease.runnerId,
          lease.epoch,
          LEASE_STATE.OFFERED,
          lease.workspaceMappingId,
          JSON.stringify(lease.requirements ?? {}),
          now,
          now,
        );
      this.db
        .prepare(
          `INSERT INTO runner_commands
            (message_id,idempotency_key,runner_id,lease_id,epoch,kind,payload,status,created_at)
           VALUES (?,?,?,?,?,?,?,'pending',?)`,
        )
        .run(
          envelope.messageId,
          envelope.idempotencyKey,
          lease.runnerId,
          lease.id,
          lease.epoch,
          envelope.kind,
          JSON.stringify(envelope),
          now,
        );
      this.db
        .prepare(
          'INSERT INTO runner_lease_transitions (lease_id,epoch,from_state,to_state,message_id,idempotency_key,details,at) VALUES (?,?,?,?,?,?,?,?)',
        )
        .run(
          lease.id,
          lease.epoch,
          null,
          LEASE_STATE.OFFERED,
          envelope.messageId,
          envelope.idempotencyKey,
          '{}',
          now,
        );
      this.appendEvent(run.taskId, 'RUNNER_LEASE_OFFERED', {
        leaseId: lease.id,
        epoch: lease.epoch,
        runnerId: lease.runnerId,
        runId: run.id,
        workspaceMappingId: lease.workspaceMappingId,
      });

      return this.getRunnerLease(lease.id);
    });
  }
  getRunnerLease(id) {
    const row = this.db.prepare('SELECT * FROM runner_leases WHERE id=?').get(id);

    return row ? parseRunnerLease(row) : null;
  }

  getRunnerLeaseResult(leaseId) {
    const row = this.db
      .prepare(
        `SELECT result_id,lease_id,epoch,result,received_at
         FROM runner_lease_results WHERE lease_id=? ORDER BY received_at DESC LIMIT 1`,
      )
      .get(leaseId);

    return row
      ? {
          resultId: row.result_id,
          leaseId: row.lease_id,
          epoch: row.epoch,
          result: JSON.parse(row.result),
          receivedAt: row.received_at,
        }
      : null;
  }
  listRunnerLeases({ state = null } = {}) {
    const rows = state
      ? this.db.prepare('SELECT * FROM runner_leases WHERE state=? ORDER BY offered_at').all(state)
      : this.db.prepare('SELECT * FROM runner_leases ORDER BY offered_at').all();

    return rows.map(parseRunnerLease);
  }
  listPendingRunnerCommands(runnerId) {
    return this.db
      .prepare(
        "SELECT * FROM runner_commands WHERE runner_id=? AND status IN ('pending','sent') ORDER BY created_at,message_id",
      )
      .all(runnerId)
      .map(parseRunnerCommand);
  }
  markRunnerCommandSent(messageId) {
    this.db
      .prepare("UPDATE runner_commands SET status='sent',sent_at=? WHERE message_id=?")
      .run(new Date().toISOString(), messageId);
  }
  processRunnerEnvelope(input) {
    const envelope = validateRunnerEnvelope(input);

    if (envelope.kind === RUNNER_MESSAGE_KIND.REGISTER)
      throw new Error('registration must be handled before Runner frames');

    return this.runInTransaction(() => {
      const payloadHash = canonicalHash(envelope.payload);
      const prior = this.db
        .prepare('SELECT * FROM runner_inbox WHERE runner_id=? AND idempotency_key=?')
        .get(envelope.payload.runnerId, envelope.idempotencyKey);

      if (prior) {
        if (prior.payload_hash !== payloadHash || prior.kind !== envelope.kind)
          throw new Error('Runner idempotency conflict');

        return JSON.parse(prior.response);
      }
      const duplicateMessage = this.db
        .prepare('SELECT payload_hash FROM runner_inbox WHERE runner_id=? AND message_id=?')
        .get(envelope.payload.runnerId, envelope.messageId);

      if (duplicateMessage) throw new Error('Runner message identity conflict');
      const response = this.applyRunnerEnvelope(envelope);

      this.db
        .prepare(
          `INSERT INTO runner_inbox
            (runner_id,message_id,idempotency_key,kind,lease_id,epoch,payload_hash,response,processed_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          envelope.payload.runnerId,
          envelope.messageId,
          envelope.idempotencyKey,
          envelope.kind,
          envelope.payload.leaseId ?? null,
          envelope.payload.epoch ?? null,
          payloadHash,
          JSON.stringify(response),
          new Date().toISOString(),
        );

      return response;
    });
  }
  applyRunnerEnvelope(envelope) {
    const payload = envelope.payload;
    const runner = this.getRunnerProjection(payload.runnerId);

    if (!runner) throw new Error(`Runner is not registered: ${payload.runnerId}`);
    if (envelope.kind === RUNNER_MESSAGE_KIND.HEARTBEAT) {
      this.recordRunnerHeartbeat({
        runnerId: payload.runnerId,
        connectionGeneration: runner.connectionGeneration,
      });

      return createRunnerAck(envelope);
    }
    const lease = this.db.prepare('SELECT * FROM runner_leases WHERE id=?').get(payload.leaseId);

    if (!lease) throw new Error(`Runner lease not found: ${payload.leaseId}`);
    if (lease.runner_id !== payload.runnerId) throw new Error('Runner identity mismatch');
    if (lease.epoch !== payload.epoch) throw new Error('stale lease epoch');
    const now = new Date().toISOString();

    if (envelope.kind === RUNNER_MESSAGE_KIND.LEASE_ACCEPTED) {
      this.transitionRunnerLease(lease, LEASE_STATE.ACCEPTED, { envelope, at: now });
      this.db
        .prepare(
          "UPDATE runner_commands SET status='acknowledged',acknowledged_at=? WHERE lease_id=? AND kind=?",
        )
        .run(now, lease.id, RUNNER_MESSAGE_KIND.LEASE_OFFER);
    } else if (envelope.kind === RUNNER_MESSAGE_KIND.LEASE_REJECTED) {
      this.transitionRunnerLease(lease, LEASE_STATE.FAILED, {
        envelope,
        details: { reason: payload.reason },
        at: now,
      });
    } else if (envelope.kind === RUNNER_MESSAGE_KIND.LEASE_STARTED) {
      this.transitionRunnerLease(lease, LEASE_STATE.RUNNING, { envelope, at: now });
    } else if (envelope.kind === RUNNER_MESSAGE_KIND.EVENT) {
      if (![LEASE_STATE.RUNNING, LEASE_STATE.RECOVERING].includes(lease.state))
        throw new Error(`Runner event is invalid while lease is ${lease.state}`);
      this.db
        .prepare(
          'INSERT INTO runner_lease_events (runner_id,lease_id,epoch,event_id,event,received_at) VALUES (?,?,?,?,?,?)',
        )
        .run(
          payload.runnerId,
          lease.id,
          lease.epoch,
          payload.eventId,
          JSON.stringify(payload),
          now,
        );
      this.appendEvent(lease.task_id, 'RUNNER_LEASE_EVENT', {
        leaseId: lease.id,
        epoch: lease.epoch,
        eventId: payload.eventId,
        type: payload.type,
        at: payload.at,
        summary: payload.summary ?? null,
        progress: payload.progress ?? null,
      });
    } else if (envelope.kind === RUNNER_MESSAGE_KIND.RESULT) {
      const resultState = normalizeResultState(payload.status);

      this.transitionRunnerLease(lease, resultState, { envelope, at: now });
      this.db
        .prepare(
          'INSERT INTO runner_lease_results (result_id,lease_id,epoch,result,received_at) VALUES (?,?,?,?,?)',
        )
        .run(payload.resultId, lease.id, lease.epoch, JSON.stringify(payload), now);
      this.db
        .prepare('UPDATE runner_leases SET result_received_at=?,acknowledged_at=? WHERE id=?')
        .run(now, now, lease.id);
      this.appendEvent(lease.task_id, 'RUNNER_RESULT_RECEIVED', safeResultProjection(payload));
    } else if (envelope.kind === RUNNER_MESSAGE_KIND.CANCEL_ACK) {
      const terminal = [LEASE_STATE.COMPLETED, LEASE_STATE.FAILED, LEASE_STATE.CANCELLED].includes(
        lease.state,
      );

      if (!terminal)
        this.transitionRunnerLease(lease, LEASE_STATE.CANCELLED, {
          envelope,
          details: { acknowledgement: payload.status },
          at: now,
        });
      else if (payload.status !== 'already_terminal')
        throw new Error(`Runner cancellation acknowledgment conflicts with ${lease.state} lease`);
      this.db
        .prepare(
          "UPDATE runner_leases SET cancellation_state='acknowledged',cancel_acknowledged_at=? WHERE id=?",
        )
        .run(now, lease.id);
      this.db
        .prepare(
          "UPDATE runner_commands SET status='acknowledged',acknowledged_at=? WHERE lease_id=? AND kind=?",
        )
        .run(now, lease.id, RUNNER_MESSAGE_KIND.CANCEL);
    } else {
      throw new Error(`unsupported Runner frame: ${envelope.kind}`);
    }

    return createRunnerAck(envelope);
  }
  transitionRunnerLease(lease, nextState, { envelope = null, details = {}, at } = {}) {
    assertLeaseTransition(
      {
        leaseId: lease.id,
        runnerId: lease.runner_id,
        epoch: lease.epoch,
        state: lease.state,
      },
      {
        leaseId: lease.id,
        runnerId: lease.runner_id,
        epoch: lease.epoch,
        state: nextState,
      },
    );
    const timestamp = at ?? new Date().toISOString();
    const timestampColumn =
      nextState === LEASE_STATE.ACCEPTED
        ? 'accepted_at'
        : nextState === LEASE_STATE.RUNNING
          ? 'running_at'
          : null;

    this.db
      .prepare(
        `UPDATE runner_leases SET state=?,updated_at=?${timestampColumn ? `,${timestampColumn}=?` : ''} WHERE id=?`,
      )
      .run(
        ...(timestampColumn
          ? [nextState, timestamp, timestamp, lease.id]
          : [nextState, timestamp, lease.id]),
      );
    this.db
      .prepare(
        'INSERT INTO runner_lease_transitions (lease_id,epoch,from_state,to_state,message_id,idempotency_key,details,at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        lease.id,
        lease.epoch,
        lease.state,
        nextState,
        envelope?.messageId ?? null,
        envelope?.idempotencyKey ?? null,
        JSON.stringify(details),
        timestamp,
      );
    this.appendEvent(lease.task_id, 'RUNNER_LEASE_STATE_CHANGED', {
      leaseId: lease.id,
      epoch: lease.epoch,
      runnerId: lease.runner_id,
      from: lease.state,
      state: nextState,
      ...details,
    });
  }
  requestRunnerLeaseCancellation({ leaseId, reason, envelope }) {
    const command = validateRunnerEnvelope(envelope);

    if (command.kind !== RUNNER_MESSAGE_KIND.CANCEL)
      throw new Error('Runner cancellation requires a cancel command');

    return this.runInTransaction(() => {
      const lease = this.db.prepare('SELECT * FROM runner_leases WHERE id=?').get(leaseId);

      if (!lease) throw new Error(`Runner lease not found: ${leaseId}`);
      if (command.payload.leaseId !== leaseId || command.payload.epoch !== lease.epoch)
        throw new Error('cancel command does not match lease fencing identity');
      const now = new Date().toISOString();

      this.db
        .prepare(
          `INSERT INTO runner_commands
            (message_id,idempotency_key,runner_id,lease_id,epoch,kind,payload,status,created_at)
           VALUES (?,?,?,?,?,?,?,'pending',?)`,
        )
        .run(
          command.messageId,
          command.idempotencyKey,
          lease.runner_id,
          lease.id,
          lease.epoch,
          command.kind,
          JSON.stringify(command),
          now,
        );
      this.db
        .prepare(
          "UPDATE runner_leases SET cancellation_state='requested',cancel_requested_at=?,updated_at=? WHERE id=?",
        )
        .run(now, now, lease.id);
      this.appendEvent(lease.task_id, 'RUNNER_CANCEL_REQUESTED', {
        leaseId: lease.id,
        epoch: lease.epoch,
        reason,
      });

      return this.getRunnerLease(lease.id);
    });
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
  getRun(runId) {
    const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(runId);

    return row ? parseRun(row) : null;
  }
  recordUsage(input) {
    const usage = normalizeUsage(input, input);

    this.db
      .prepare(
        `INSERT OR IGNORE INTO usage_records
      (id,idempotency_key,task_id,run_id,stage_id,attempt,session_id,turn_id,provider,harness,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,completeness,source,recorded_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        usage.id,
        usage.idempotencyKey,
        usage.taskId,
        usage.runId,
        usage.stageId,
        usage.attempt,
        usage.sessionId,
        usage.turnId,
        usage.provider,
        usage.harness,
        usage.model,
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheReadTokens,
        usage.cacheWriteTokens,
        usage.reasoningTokens,
        usage.completeness,
        usage.source,
        usage.recordedAt,
      );

    return this.listUsage(input.taskId).find(
      (item) => item.idempotency_key === usage.idempotencyKey,
    );
  }
  listUsage(taskId, { stageId = null, attempt = null } = {}) {
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
      .prepare(
        `SELECT * FROM usage_records WHERE ${conditions.join(' AND ')} ORDER BY recorded_at, id`,
      )
      .all(...params);
  }
  recordPricingSnapshot({
    source,
    provider = null,
    currency = 'USD',
    catalog,
    fetchedAt = new Date().toISOString(),
    effectiveFrom = fetchedAt,
  }) {
    const checksum = snapshotChecksum(catalog);
    const id = randomUUID();

    this.db
      .prepare(
        'INSERT OR IGNORE INTO pricing_snapshots (id,source,provider,currency,catalog,fetched_at,effective_from,checksum) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        source,
        provider,
        currency,
        JSON.stringify(catalog),
        fetchedAt,
        effectiveFrom,
        checksum,
      );

    return this.db.prepare('SELECT * FROM pricing_snapshots WHERE checksum=?').get(checksum);
  }
  listPricingSnapshots() {
    return this.db
      .prepare('SELECT * FROM pricing_snapshots ORDER BY fetched_at DESC')
      .all()
      .map((row) => ({ ...row, catalog: JSON.parse(row.catalog) }));
  }
  refreshUsageCosts(taskId) {
    const records = this.listUsage(taskId);
    const snapshots = this.listPricingSnapshots();

    for (const record of records) {
      const snapshot = snapshots.find((item) => item.currency === 'USD') ?? snapshots[0];
      const usage = {
        ...record,
        input_tokens: record.input_tokens,
        output_tokens: record.output_tokens,
      };
      const cost = calculateUsageCost(usage, snapshot);

      this.db
        .prepare(
          'INSERT OR REPLACE INTO usage_costs (usage_id,pricing_snapshot_id,amount,currency,status,calculated_at) VALUES (?,?,?,?,?,?)',
        )
        .run(
          record.id,
          snapshot?.id ?? null,
          cost.amount,
          cost.currency,
          cost.status,
          new Date().toISOString(),
        );
    }

    return this.getUsageSummary(taskId);
  }
  getUsageSummary(taskId, filters = {}) {
    const records = this.listUsage(taskId, filters);
    const costs = this.db
      .prepare(
        `SELECT c.* FROM usage_costs c JOIN usage_records u ON u.id=c.usage_id WHERE u.task_id=?`,
      )
      .all(taskId);

    return aggregateUsage(records, costs);
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
    if (this.transactionDepth > 0) this.pendingObservedEvents.push({ ...event });
    else this.notifyEventObserver(event);
  }
  notifyEventObserver(event) {
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
  createWorkflowAction({ id, taskId, kind, descriptor }) {
    const createdAt = new Date().toISOString();

    this.db
      .prepare(
        'INSERT INTO workflow_actions (id,task_id,kind,descriptor,status,created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(id, taskId, kind, JSON.stringify(descriptor), 'PENDING', createdAt);
    this.appendEvent(taskId, 'WORKFLOW_ACTION_PROPOSED', { id, kind, descriptor, at: createdAt });

    return { id, taskId, kind, ...descriptor, status: 'PENDING', createdAt };
  }
  getWorkflowAction(id) {
    const row = this.db.prepare('SELECT * FROM workflow_actions WHERE id=?').get(id);

    return row
      ? {
          id: row.id,
          taskId: row.task_id,
          kind: row.kind,
          ...JSON.parse(row.descriptor),
          status: row.status,
          actor: row.actor,
          createdAt: row.created_at,
          approvedAt: row.approved_at,
        }
      : null;
  }
  latestWorkflowAction(taskId, kind = null) {
    const row = this.db
      .prepare(
        `SELECT * FROM workflow_actions WHERE task_id=?${kind ? ' AND kind=?' : ''} ORDER BY created_at DESC LIMIT 1`,
      )
      .get(...(kind ? [taskId, kind] : [taskId]));

    return row ? this.getWorkflowAction(row.id) : null;
  }
  approveWorkflowAction(id, actor = 'local-user') {
    const action = this.getWorkflowAction(id);

    if (!action) throw new Error(`workflow action not found: ${id}`);
    if (action.status !== 'PENDING')
      throw new Error(`workflow action ${id} is already ${action.status}`);
    const approvedAt = new Date().toISOString();

    this.db
      .prepare('UPDATE workflow_actions SET status=?,actor=?,approved_at=? WHERE id=?')
      .run('APPROVED', actor, approvedAt, id);
    this.appendEvent(action.taskId, 'WORKFLOW_ACTION_APPROVED', { id, actor, at: approvedAt });

    return { ...action, status: 'APPROVED', actor, approvedAt };
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
  recordOperatorMessage({ taskId, actor = 'local-user', message, target = null } = {}) {
    if (!taskId || !actor || typeof message !== 'string' || !message.trim())
      throw new Error('operator message taskId, actor, and message are required');
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const safeMessage = redactSecrets(message);
    const safeTarget = redactSecrets(target);

    this.runInTransaction(() => {
      this.db
        .prepare(
          'INSERT INTO operator_messages (id,task_id,actor,message,target,created_at) VALUES (?,?,?,?,?,?)',
        )
        .run(
          id,
          taskId,
          actor,
          safeMessage,
          safeTarget ? JSON.stringify(safeTarget) : null,
          createdAt,
        );
      this.appendEvent(taskId, 'OPERATOR_MESSAGE_RECORDED', {
        id,
        actor,
        target: safeTarget,
        at: createdAt,
      });
    });

    return { id, taskId, actor, message: safeMessage, target: safeTarget, created_at: createdAt };
  }
  listOperatorMessages(taskId) {
    return this.db
      .prepare('SELECT * FROM operator_messages WHERE task_id=? ORDER BY created_at,id')
      .all(taskId)
      .map((row) => ({ ...row, target: row.target ? JSON.parse(row.target) : null }));
  }
  recordContinuationGrant(grant) {
    const existing = grant.idempotencyKey
      ? this.db
          .prepare('SELECT * FROM continuation_grants WHERE idempotency_key=?')
          .get(grant.idempotencyKey)
      : null;

    if (existing) return existing;
    const createdAt = new Date().toISOString();

    this.db
      .prepare(
        'INSERT INTO continuation_grants (id,task_id,stage_id,run_id,session_id,actor,reason,expected_revision,expires_at,created_at,idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        grant.id,
        grant.taskId,
        grant.stageId ?? null,
        grant.runId ?? null,
        grant.sessionId ?? null,
        grant.actor,
        grant.reason,
        grant.expectedRevision,
        grant.expiresAt,
        createdAt,
        grant.idempotencyKey ?? null,
      );
    this.appendEvent(grant.taskId, 'CONTINUATION_GRANTED', { ...grant, createdAt });

    return { ...grant, createdAt };
  }
  recordContinuationRequest({ grant, message, target }) {
    return this.runInTransaction(() => {
      const existing = this.getContinuationGrantByKey(grant.idempotencyKey);

      if (existing) return existing;
      const operatorMessage = this.recordOperatorMessage({
        taskId: grant.taskId,
        actor: grant.actor,
        message,
        target,
      });
      const recorded = this.recordContinuationGrant({
        ...grant,
        reason: operatorMessage.message,
      });

      this.db
        .prepare('UPDATE continuation_grants SET operator_message_id=? WHERE id=?')
        .run(operatorMessage.id, recorded.id);

      return { ...recorded, operatorMessageId: operatorMessage.id };
    });
  }
  getContinuationGrantByKey(idempotencyKey) {
    return this.db
      .prepare('SELECT * FROM continuation_grants WHERE idempotency_key=?')
      .get(idempotencyKey);
  }
  getContinuationGrant(id) {
    return this.db.prepare('SELECT * FROM continuation_grants WHERE id=?').get(id);
  }
  claimContinuationRun(grantId, run) {
    return this.runInTransaction(() => {
      const grant = this.getContinuationGrant(grantId);

      if (!grant) throw new Error(`continuation grant not found: ${grantId}`);
      if (grant.correction_run_id) return this.getRun(grant.correction_run_id);
      this.createRun(run);
      this.db
        .prepare(
          "UPDATE continuation_grants SET correction_run_id=?,status='RUNNING' WHERE id=? AND correction_run_id IS NULL",
        )
        .run(run.id, grantId);

      return this.getRun(run.id);
    });
  }
  markContinuationWorkerCompleted(grantId) {
    this.db
      .prepare("UPDATE continuation_grants SET status='WORKER_COMPLETED' WHERE id=?")
      .run(grantId);
  }
  completeContinuation(grantId, { state, review = null, runId = null } = {}) {
    return this.runInTransaction(() => {
      const grant = this.getContinuationGrant(grantId);

      if (!grant) throw new Error(`continuation grant not found: ${grantId}`);
      if (grant.status === 'COMPLETED') return grant;
      const completedAt = new Date().toISOString();

      this.db
        .prepare(
          "UPDATE continuation_grants SET status='COMPLETED',completed_at=?,result_state=?,review_verdict=? WHERE id=?",
        )
        .run(completedAt, state, review?.verdict ?? null, grantId);
      this.appendEvent(grant.task_id, 'CONTINUATION_COMPLETED', {
        grantId,
        runId: runId ?? grant.correction_run_id,
        state,
        reviewVerdict: review?.verdict ?? null,
        completedAt,
      });

      return this.getContinuationGrant(grantId);
    });
  }
  recordCompletionOverride({
    taskId,
    expectedRevision,
    actor,
    reason,
    unresolvedFindings = [],
    idempotencyKey = null,
  }) {
    const existing = idempotencyKey
      ? this.db
          .prepare('SELECT * FROM completion_overrides WHERE idempotency_key=?')
          .get(idempotencyKey)
      : null;

    if (existing) return existing;
    const id = randomUUID();
    const createdAt = new Date().toISOString();

    this.db
      .prepare(
        'INSERT INTO completion_overrides (id,task_id,expected_revision,actor,reason,created_at,idempotency_key,unresolved_findings) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        taskId,
        expectedRevision,
        actor,
        reason,
        createdAt,
        idempotencyKey,
        JSON.stringify(unresolvedFindings),
      );
    this.appendEvent(taskId, 'COMPLETION_OVERRIDE_RECORDED', {
      id,
      expectedRevision,
      actor,
      reason,
      unresolvedFindings,
      createdAt,
    });

    return {
      id,
      taskId,
      expectedRevision,
      actor,
      reason,
      unresolvedFindings,
      createdAt,
      idempotencyKey,
    };
  }
  getTaskThread(taskId, options = {}) {
    return queryTaskThread(
      {
        taskId,
        events: this.listEvents(taskId),
        operatorMessages: this.listOperatorMessages(taskId),
      },
      options,
    );
  }
  listDiagnosticEvents(taskId) {
    return projectDiagnosticEvents(this.listEvents(taskId));
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
      if (
        task.state !== TASK_STATE.READY &&
        !(task.state === TASK_STATE.WAITING_FOR_HUMAN && normalized.reviewOverride)
      )
        throw new Error(`task ${task.id} must be READY before completion`);
      const currentResult = this.getResultManifest(task.id);

      if (currentResult.revision !== normalized.expectedRevision)
        throw new Error('completion revision is not the current READY revision');
      if (result.revision && result.revision !== normalized.expectedRevision)
        throw new Error('completion revision does not match result manifest');
      if (this.getCompletion(task.id)) throw new Error(`task ${task.id} is already completed`);
      const at = new Date().toISOString();

      if (normalized.reviewOverride)
        this.recordCompletionOverride({
          taskId: task.id,
          expectedRevision: normalized.expectedRevision,
          actor: normalized.actor,
          reason: normalized.note ?? 'operator accepted unresolved review findings',
          unresolvedFindings: normalized.unresolvedFindings,
          idempotencyKey: normalized.idempotencyKey ?? null,
        });

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
          JSON.stringify({
            ...result,
            reviewOverride: normalized.reviewOverride,
            unresolvedFindings: normalized.unresolvedFindings,
            completionActor: normalized.actor,
          }),
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
        reviewOverride: normalized.reviewOverride,
        unresolvedFindings: normalized.unresolvedFindings,
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
  latestWorkerOutput(taskId) {
    return (
      this.listEvents(taskId)
        .filter((event) => event.type === 'WORKER_OUTPUT_RECORDED')
        .map((event) => event.payload)
        .at(-1) ?? null
    );
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
    const latestWorkerOutput = this.latestWorkerOutput(taskId);
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
      usage: this.refreshUsageCosts(taskId),
      workerOutput: latestWorkerOutput?.output ?? null,
      workerOutputRunId: latestWorkerOutput?.runId ?? null,
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

function parseRunnerLease(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    stageId: row.stage_id,
    runId: row.run_id,
    attempt: row.attempt,
    runnerId: row.runner_id,
    epoch: row.epoch,
    state: row.state,
    cancellationState: row.cancellation_state,
    workspaceMappingId: row.workspace_mapping_id,
    requirements: JSON.parse(row.requirements),
    recoveryClassification: row.recovery_classification,
    recoveryReason: row.recovery_reason,
    offeredAt: row.offered_at,
    acceptedAt: row.accepted_at,
    runningAt: row.running_at,
    resultReceivedAt: row.result_received_at,
    acknowledgedAt: row.acknowledged_at,
    cancelRequestedAt: row.cancel_requested_at,
    cancelAcknowledgedAt: row.cancel_acknowledged_at,
    updatedAt: row.updated_at,
  };
}

function parseRunnerCommand(row) {
  return {
    messageId: row.message_id,
    idempotencyKey: row.idempotency_key,
    runnerId: row.runner_id,
    leaseId: row.lease_id,
    epoch: row.epoch,
    kind: row.kind,
    envelope: JSON.parse(row.payload),
    status: row.status,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    acknowledgedAt: row.acknowledged_at,
  };
}

function canonicalHash(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;

  return JSON.stringify(value);
}

function createRunnerAck(envelope) {
  const digest = createHash('sha256')
    .update(`${envelope.payload.runnerId}:${envelope.idempotencyKey}`)
    .digest('hex')
    .slice(0, 32);

  return createRunnerEnvelope({
    kind: RUNNER_MESSAGE_KIND.ACK,
    messageId: `ack-${digest}`,
    idempotencyKey: `ack-${digest}`,
    correlationId: envelope.correlationId,
    payload: {
      runnerId: envelope.payload.runnerId,
      ackedMessageId: envelope.messageId,
    },
  });
}

function normalizeResultState(status) {
  const normalized = String(status).toLowerCase();

  if (['completed', 'success', 'succeeded'].includes(normalized)) return LEASE_STATE.COMPLETED;
  if (['failed', 'failure'].includes(normalized)) return LEASE_STATE.FAILED;
  if (['cancelled', 'canceled'].includes(normalized)) return LEASE_STATE.CANCELLED;
  throw new Error(`unsupported Runner result status: ${status}`);
}

function safeResultProjection(payload) {
  return {
    leaseId: payload.leaseId,
    epoch: payload.epoch,
    resultId: payload.resultId,
    status: payload.status,
    summary: payload.summary ?? null,
    revision: payload.revision ?? null,
    evidence: payload.evidence ?? null,
    usage: payload.usage ?? null,
  };
}

// Agent session persistence for architect/reviewer roles

function parseAgentSession(row) {
  return row;
}

Store.prototype.saveAgentSession = function saveAgentSession({
  taskId,
  role,
  harness,
  sessionId,
  workspace,
}) {
  const id = `${taskId}:${role}:${sessionId}`;
  const now = new Date().toISOString();

  this.db
    .prepare(
      'INSERT OR REPLACE INTO agent_sessions (id, task_id, role, harness, session_id, workspace, created_at) VALUES (?,?,?,?,?,?,?)',
    )
    .run(id, taskId, role, harness, sessionId, workspace ?? null, now);
};

Store.prototype.getAgentSession = function getAgentSession(taskId, role) {
  const row = this.db
    .prepare(
      'SELECT * FROM agent_sessions WHERE task_id=? AND role=? ORDER BY created_at DESC LIMIT 1',
    )
    .get(taskId, role);

  return row ? parseAgentSession(row) : null;
};

Store.prototype.listAgentSessions = function listAgentSessions(taskId) {
  return this.db
    .prepare('SELECT * FROM agent_sessions WHERE task_id=? ORDER BY created_at DESC')
    .all(taskId)
    .map(parseAgentSession);
};
