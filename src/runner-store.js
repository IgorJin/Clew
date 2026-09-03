import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LEASE_STATE, RUNNER_DIRECTION, validateRunnerEnvelope } from './runner-protocol.js';

const DEFAULT_MAX_OUTBOX_ENTRIES = 10_000;
const DEFAULT_MAX_OUTBOX_BYTES = 64 * 1024 * 1024;
const DEFAULT_RESERVED_TERMINAL_ENTRIES = 32;
const DEFAULT_RESERVED_TERMINAL_BYTES = 1024 * 1024;

function assertPositiveLimit(value, name, { allowZero = false } = {}) {
  const minimum = allowZero ? 0 : 1;

  if (!Number.isSafeInteger(value) || value < minimum)
    throw new Error(`${name} must be an integer >= ${minimum}`);
}

function parseEnvelope(value) {
  return validateRunnerEnvelope(JSON.parse(value));
}

function executionFromRow(row) {
  if (!row) return null;

  return {
    leaseId: row.lease_id,
    epoch: row.epoch,
    runId: row.run_id,
    state: row.state,
    workspaceId: row.workspace_id,
    harness: row.harness,
    cancelState: row.cancel_state,
    updatedAt: row.updated_at,
  };
}

export class RunnerStore {
  constructor(
    file,
    {
      maxOutboxEntries = DEFAULT_MAX_OUTBOX_ENTRIES,
      maxOutboxBytes = DEFAULT_MAX_OUTBOX_BYTES,
      reservedTerminalEntries = DEFAULT_RESERVED_TERMINAL_ENTRIES,
      reservedTerminalBytes = DEFAULT_RESERVED_TERMINAL_BYTES,
      configuredRunnerId = null,
    } = {},
  ) {
    assertPositiveLimit(maxOutboxEntries, 'maxOutboxEntries');
    assertPositiveLimit(maxOutboxBytes, 'maxOutboxBytes');
    assertPositiveLimit(reservedTerminalEntries, 'reservedTerminalEntries', { allowZero: true });
    assertPositiveLimit(reservedTerminalBytes, 'reservedTerminalBytes', { allowZero: true });
    if (reservedTerminalEntries >= maxOutboxEntries)
      throw new Error('reservedTerminalEntries must be smaller than maxOutboxEntries');
    if (reservedTerminalBytes >= maxOutboxBytes)
      throw new Error('reservedTerminalBytes must be smaller than maxOutboxBytes');

    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.transactionDepth = 0;
    this.configuredRunnerId = configuredRunnerId;
    this.limits = Object.freeze({
      maxOutboxEntries,
      maxOutboxBytes,
      reservedTerminalEntries,
      reservedTerminalBytes,
    });
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS runner_schema (
        version INTEGER NOT NULL
      );
      INSERT INTO runner_schema (version)
        SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM runner_schema);
      CREATE TABLE IF NOT EXISTS runner_identity (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        runner_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        envelope TEXT NOT NULL,
        byte_size INTEGER NOT NULL CHECK (byte_size > 0),
        reserve_class TEXT NOT NULL CHECK (reserve_class IN ('normal', 'terminal')),
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inbound_ledger (
        idempotency_key TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        response_envelope TEXT NOT NULL,
        processed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS executions (
        lease_id TEXT NOT NULL,
        epoch INTEGER NOT NULL CHECK (epoch > 0),
        run_id TEXT NOT NULL,
        state TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        harness TEXT,
        cancel_state TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (lease_id, epoch)
      );
    `);
  }

  close() {
    this.db.close();
  }

  transaction(operation) {
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

  getOrCreateIdentity() {
    return this.transaction(() => {
      let row = this.db.prepare('SELECT runner_id, created_at FROM runner_identity').get();

      if (!row) {
        row = {
          runner_id: this.configuredRunnerId ?? randomUUID(),
          created_at: new Date().toISOString(),
        };
        this.db
          .prepare('INSERT INTO runner_identity VALUES (1, ?, ?)')
          .run(row.runner_id, row.created_at);
      }
      if (this.configuredRunnerId && row.runner_id !== this.configuredRunnerId)
        throw new Error('configured Runner identity does not match durable Runner identity');

      return { runnerId: row.runner_id, createdAt: row.created_at };
    });
  }

  #outboxUsage() {
    return this.db
      .prepare('SELECT COUNT(*) AS entries, COALESCE(SUM(byte_size), 0) AS bytes FROM outbox')
      .get();
  }

  #enqueue(envelope, { reserveClass = 'normal' } = {}) {
    if (!['normal', 'terminal'].includes(reserveClass))
      throw new Error('reserveClass must be normal or terminal');
    const validated = validateRunnerEnvelope(envelope);

    if (validated.direction !== RUNNER_DIRECTION.TO_CONTROLLER)
      throw new Error('Runner outbox only accepts messages directed to Controller');
    const serialized = JSON.stringify(validated);
    const byteSize = Buffer.byteLength(serialized);
    const usage = this.#outboxUsage();
    const entryLimit =
      this.limits.maxOutboxEntries -
      (reserveClass === 'normal' ? this.limits.reservedTerminalEntries : 0);
    const byteLimit =
      this.limits.maxOutboxBytes -
      (reserveClass === 'normal' ? this.limits.reservedTerminalBytes : 0);

    if (usage.entries + 1 > entryLimit || usage.bytes + byteSize > byteLimit) {
      const error = new Error(`Runner outbox capacity exhausted for ${reserveClass} message`);

      error.code = 'OUTBOX_CAPACITY';
      throw error;
    }
    this.db
      .prepare(
        `INSERT INTO outbox
          (message_id,idempotency_key,kind,envelope,byte_size,reserve_class,created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        validated.messageId,
        validated.idempotencyKey,
        validated.kind,
        serialized,
        byteSize,
        reserveClass,
        new Date().toISOString(),
      );

    return validated;
  }

  enqueue(envelope, options) {
    return this.transaction(() => this.#enqueue(envelope, options));
  }

  pendingOutbox({ limit = 100 } = {}) {
    assertPositiveLimit(limit, 'limit');

    return this.db
      .prepare(
        `SELECT seq,envelope,attempts,reserve_class,created_at
         FROM outbox ORDER BY seq LIMIT ?`,
      )
      .all(limit)
      .map((row) => ({
        seq: row.seq,
        envelope: parseEnvelope(row.envelope),
        attempts: row.attempts,
        reserveClass: row.reserve_class,
        createdAt: row.created_at,
      }));
  }

  markAttempt(messageId) {
    this.db.prepare('UPDATE outbox SET attempts=attempts+1 WHERE message_id=?').run(messageId);
  }

  hasPending(messageId) {
    return Boolean(this.db.prepare('SELECT 1 FROM outbox WHERE message_id=?').get(messageId));
  }

  acknowledge({ messageId, idempotencyKey } = {}) {
    if (!messageId) throw new Error('messageId is required for acknowledgement');

    return this.transaction(() => {
      const row = this.db
        .prepare('SELECT idempotency_key FROM outbox WHERE message_id=?')
        .get(messageId);

      if (!row || (idempotencyKey && row.idempotency_key !== idempotencyKey)) return false;
      this.db.prepare('DELETE FROM outbox WHERE message_id=?').run(messageId);

      return true;
    });
  }

  recordInbound(envelope, operation) {
    const inbound = validateRunnerEnvelope(envelope);

    if (inbound.direction !== RUNNER_DIRECTION.TO_RUNNER)
      throw new Error('inbound ledger only accepts messages directed to Runner');
    if (typeof operation !== 'function') throw new Error('inbound operation must be a function');

    return this.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT message_id,kind,response_envelope
           FROM inbound_ledger WHERE idempotency_key=?`,
        )
        .get(inbound.idempotencyKey);

      if (existing) {
        if (existing.message_id !== inbound.messageId || existing.kind !== inbound.kind) {
          const error = new Error('Runner inbound idempotency identity conflict');

          error.code = 'IDEMPOTENCY_CONFLICT';
          throw error;
        }

        const response = parseEnvelope(existing.response_envelope);

        if (!this.hasPending(response.messageId))
          this.#enqueue(response, { reserveClass: 'terminal' });

        return { duplicate: true, response };
      }
      const outcome = operation(inbound) ?? {};
      const response = validateRunnerEnvelope(outcome.response);

      if (response.direction !== RUNNER_DIRECTION.TO_CONTROLLER)
        throw new Error('inbound operation response must be directed to Controller');
      this.#enqueue(response, { reserveClass: outcome.reserveClass ?? 'terminal' });
      this.db
        .prepare(
          `INSERT INTO inbound_ledger
            (idempotency_key,message_id,kind,response_envelope,processed_at)
           VALUES (?,?,?,?,?)`,
        )
        .run(
          inbound.idempotencyKey,
          inbound.messageId,
          inbound.kind,
          JSON.stringify(response),
          new Date().toISOString(),
        );

      return { duplicate: false, response, value: outcome.value };
    });
  }

  createExecution({ leaseId, epoch, runId, state, workspaceId, harness = null }) {
    if (!Object.values(LEASE_STATE).includes(state))
      throw new Error(`invalid execution state: ${state}`);
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO executions
          (lease_id,epoch,run_id,state,workspace_id,harness,cancel_state,updated_at)
         VALUES (?,?,?,?,?,?,NULL,?)`,
      )
      .run(leaseId, epoch, runId, state, workspaceId, harness, now);

    return this.getExecution(leaseId, epoch);
  }

  getExecution(leaseId, epoch) {
    return executionFromRow(
      this.db.prepare('SELECT * FROM executions WHERE lease_id=? AND epoch=?').get(leaseId, epoch),
    );
  }

  getLatestExecution(leaseId) {
    return executionFromRow(
      this.db
        .prepare('SELECT * FROM executions WHERE lease_id=? ORDER BY epoch DESC LIMIT 1')
        .get(leaseId),
    );
  }

  listActiveExecutions() {
    return this.db
      .prepare(
        `SELECT * FROM executions
         WHERE state IN ('offered','accepted','running','recovering')
         ORDER BY updated_at`,
      )
      .all()
      .map(executionFromRow);
  }

  transitionExecution(leaseId, epoch, expectedState, nextState, { cancelState } = {}) {
    if (!Object.values(LEASE_STATE).includes(nextState))
      throw new Error(`invalid execution state: ${nextState}`);
    const result = this.db
      .prepare(
        `UPDATE executions SET state=?,cancel_state=COALESCE(?,cancel_state),updated_at=?
         WHERE lease_id=? AND epoch=? AND state=?`,
      )
      .run(nextState, cancelState ?? null, new Date().toISOString(), leaseId, epoch, expectedState);

    if (result.changes !== 1)
      throw new Error(
        `execution transition rejected for ${leaseId}@${epoch} from ${expectedState}`,
      );

    return this.getExecution(leaseId, epoch);
  }

  markActiveExecutionsRecovering() {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE executions SET state='recovering',updated_at=?
         WHERE state IN ('accepted','running')`,
      )
      .run(now);

    return Number(result.changes);
  }

  status() {
    const usage = this.#outboxUsage();
    const activeExecutions = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM executions
         WHERE state IN ('offered','accepted','running','recovering')`,
      )
      .get().count;

    return Object.freeze({
      outbox: {
        entries: usage.entries,
        bytes: usage.bytes,
        capacityEntries: this.limits.maxOutboxEntries,
        capacityBytes: this.limits.maxOutboxBytes,
      },
      activeExecutions,
    });
  }
}
