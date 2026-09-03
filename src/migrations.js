export const CURRENT_SCHEMA_VERSION = 17;

const MIGRATIONS = Object.freeze([
  {
    version: 1,
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, contract TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS stages (task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, id TEXT NOT NULL, status TEXT NOT NULL, depends_on TEXT NOT NULL, PRIMARY KEY(task_id,id));
        CREATE TABLE IF NOT EXISTS plans (task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, version INTEGER NOT NULL, plan TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'APPROVED', created_at TEXT NOT NULL, PRIMARY KEY(task_id,version));
        CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, stage_id TEXT NOT NULL, attempt INTEGER NOT NULL, status TEXT NOT NULL, harness TEXT NOT NULL, session_id TEXT, turn_id TEXT, workspace TEXT, commit_sha TEXT, started_at TEXT, finished_at TEXT);
        CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, type TEXT NOT NULL, payload TEXT NOT NULL, at TEXT NOT NULL);
      `);
    },
  },
  {
    version: 2,
    apply(db) {
      const columns = db.prepare('PRAGMA table_info(plans)').all();

      if (!columns.some((column) => column.name === 'status'))
        db.exec("ALTER TABLE plans ADD COLUMN status TEXT NOT NULL DEFAULT 'APPROVED'");
    },
  },
  {
    version: 3,
    apply(db) {
      const columns = db.prepare('PRAGMA table_info(runs)').all();

      if (!columns.some((column) => column.name === 'turn_id'))
        db.exec('ALTER TABLE runs ADD COLUMN turn_id TEXT');
    },
  },
  {
    version: 4,
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS approvals (seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, plan_version INTEGER NOT NULL, gate_id TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT, actor TEXT NOT NULL, at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS interrupt_requests (task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, actor TEXT NOT NULL, requested_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS harness_approvals (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, run_id TEXT NOT NULL, method TEXT NOT NULL, params TEXT NOT NULL, decision TEXT, actor TEXT, requested_at TEXT NOT NULL, decided_at TEXT);
      `);
    },
  },
  {
    version: 5,
    apply(db) {
      const columns = db.prepare('PRAGMA table_info(events)').all();

      if (!columns.some((column) => column.name === 'version'))
        db.exec('ALTER TABLE events ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
    },
  },
  {
    version: 6,
    apply(db) {
      const columns = db.prepare('PRAGMA table_info(runs)').all();

      if (!columns.some((column) => column.name === 'profile'))
        db.exec('ALTER TABLE runs ADD COLUMN profile TEXT');
      if (!columns.some((column) => column.name === 'policy'))
        db.exec('ALTER TABLE runs ADD COLUMN policy TEXT');
    },
  },
  {
    version: 7,
    apply(db) {
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS runs_task_stage_attempt ON runs(task_id,stage_id,attempt)',
      );
    },
  },
  {
    version: 8,
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS operator_actions (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          action TEXT NOT NULL,
          stage_id TEXT,
          attempt INTEGER,
          actor TEXT NOT NULL,
          reason TEXT,
          expected_revision TEXT,
          at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS completions (
          task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
          expected_revision TEXT NOT NULL,
          decision TEXT NOT NULL,
          note TEXT,
          actor TEXT NOT NULL,
          at TEXT NOT NULL,
          manifest TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 9,
    apply(db) {
      const columns = db.prepare('PRAGMA table_info(runs)').all();

      if (!columns.some((column) => column.name === 'runtime_namespace'))
        db.exec('ALTER TABLE runs ADD COLUMN runtime_namespace TEXT');
    },
  },
  {
    version: 10,
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS telemetry_tasks (
          task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
          trace_id TEXT NOT NULL,
          root_span_id TEXT NOT NULL,
          root_span_context TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS telemetry_runs (
          run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          span_id TEXT NOT NULL,
          span_context TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS telemetry_exports (
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          event_key TEXT NOT NULL,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(task_id, event_key)
        );
      `);
    },
  },
  {
    version: 11,
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS usage_records (
          id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          stage_id TEXT NOT NULL,
          attempt INTEGER NOT NULL,
          session_id TEXT,
          turn_id TEXT,
          provider TEXT,
          harness TEXT NOT NULL,
          model TEXT,
          input_tokens INTEGER,
          output_tokens INTEGER,
          cache_read_tokens INTEGER,
          cache_write_tokens INTEGER,
          reasoning_tokens INTEGER,
          completeness TEXT NOT NULL,
          source TEXT NOT NULL,
          recorded_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS usage_records_task ON usage_records(task_id, stage_id, attempt);
        CREATE TABLE IF NOT EXISTS pricing_snapshots (
          id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          provider TEXT,
          currency TEXT NOT NULL,
          catalog TEXT NOT NULL,
          fetched_at TEXT NOT NULL,
          effective_from TEXT NOT NULL,
          checksum TEXT NOT NULL UNIQUE
        );
        CREATE TABLE IF NOT EXISTS usage_costs (
          usage_id TEXT PRIMARY KEY REFERENCES usage_records(id) ON DELETE CASCADE,
          pricing_snapshot_id TEXT REFERENCES pricing_snapshots(id),
          amount TEXT,
          currency TEXT,
          status TEXT NOT NULL,
          calculated_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 12,
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS operator_messages (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          actor TEXT NOT NULL,
          message TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS continuation_grants (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          stage_id TEXT,
          run_id TEXT,
          session_id TEXT,
          actor TEXT NOT NULL,
          reason TEXT NOT NULL,
          expected_revision TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS completion_overrides (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          expected_revision TEXT NOT NULL,
          actor TEXT NOT NULL,
          reason TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 13,
    apply(db) {
      const columns = db.prepare('PRAGMA table_info(operator_messages)').all();

      if (!columns.some((column) => column.name === 'target'))
        db.exec('ALTER TABLE operator_messages ADD COLUMN target TEXT');
    },
  },
  {
    version: 14,
    apply(db) {
      const grants = db.prepare('PRAGMA table_info(continuation_grants)').all();
      const overrides = db.prepare('PRAGMA table_info(completion_overrides)').all();

      if (!grants.some((column) => column.name === 'idempotency_key'))
        db.exec('ALTER TABLE continuation_grants ADD COLUMN idempotency_key TEXT');
      if (!overrides.some((column) => column.name === 'idempotency_key'))
        db.exec('ALTER TABLE completion_overrides ADD COLUMN idempotency_key TEXT');
      if (!overrides.some((column) => column.name === 'unresolved_findings'))
        db.exec('ALTER TABLE completion_overrides ADD COLUMN unresolved_findings TEXT');
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS continuation_grants_idempotency ON continuation_grants(idempotency_key) WHERE idempotency_key IS NOT NULL',
      );
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS completion_overrides_idempotency ON completion_overrides(idempotency_key) WHERE idempotency_key IS NOT NULL',
      );
    },
  },
  {
    version: 15,
    apply(db) {
      const grants = db.prepare('PRAGMA table_info(continuation_grants)').all();

      if (!grants.some((column) => column.name === 'status'))
        db.exec(
          "ALTER TABLE continuation_grants ADD COLUMN status TEXT NOT NULL DEFAULT 'GRANTED'",
        );
      if (!grants.some((column) => column.name === 'correction_run_id'))
        db.exec('ALTER TABLE continuation_grants ADD COLUMN correction_run_id TEXT');
      if (!grants.some((column) => column.name === 'operator_message_id'))
        db.exec('ALTER TABLE continuation_grants ADD COLUMN operator_message_id TEXT');
      if (!grants.some((column) => column.name === 'completed_at'))
        db.exec('ALTER TABLE continuation_grants ADD COLUMN completed_at TEXT');
      if (!grants.some((column) => column.name === 'result_state'))
        db.exec('ALTER TABLE continuation_grants ADD COLUMN result_state TEXT');
      if (!grants.some((column) => column.name === 'review_verdict'))
        db.exec('ALTER TABLE continuation_grants ADD COLUMN review_verdict TEXT');
      db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS continuation_grants_run ON continuation_grants(correction_run_id) WHERE correction_run_id IS NOT NULL',
      );
    },
  },
  {
    version: 16,
    apply(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS workflow_actions (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          descriptor TEXT NOT NULL,
          status TEXT NOT NULL,
          actor TEXT,
          created_at TEXT NOT NULL,
          approved_at TEXT
        );
        CREATE INDEX IF NOT EXISTS workflow_actions_task ON workflow_actions(task_id, created_at);
      `);
    },
  },
  {
    version: 17,
    apply(db) {
      const runColumns = db.prepare('PRAGMA table_info(runs)').all();

      if (!runColumns.some((column) => column.name === 'execution_mode'))
        db.exec("ALTER TABLE runs ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'local'");
      if (!runColumns.some((column) => column.name === 'workspace_ref'))
        db.exec('ALTER TABLE runs ADD COLUMN workspace_ref TEXT');
      if (!runColumns.some((column) => column.name === 'runner_id'))
        db.exec('ALTER TABLE runs ADD COLUMN runner_id TEXT');
      db.exec(`
        CREATE TABLE IF NOT EXISTS runner_peers (
          runner_id TEXT PRIMARY KEY,
          protocol_version INTEGER NOT NULL,
          product_version TEXT NOT NULL,
          capabilities TEXT NOT NULL,
          workspace_mappings TEXT NOT NULL,
          connection_generation INTEGER NOT NULL DEFAULT 0,
          health_status TEXT NOT NULL,
          registered_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          disconnected_at TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS runner_leases (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          stage_id TEXT NOT NULL,
          run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
          attempt INTEGER NOT NULL,
          runner_id TEXT NOT NULL REFERENCES runner_peers(runner_id),
          epoch INTEGER NOT NULL CHECK(epoch > 0),
          state TEXT NOT NULL,
          cancellation_state TEXT NOT NULL DEFAULT 'none',
          workspace_mapping_id TEXT NOT NULL,
          requirements TEXT NOT NULL,
          recovery_classification TEXT,
          recovery_reason TEXT,
          offered_at TEXT NOT NULL,
          accepted_at TEXT,
          running_at TEXT,
          result_received_at TEXT,
          acknowledged_at TEXT,
          cancel_requested_at TEXT,
          cancel_acknowledged_at TEXT,
          updated_at TEXT NOT NULL,
          UNIQUE(task_id, stage_id, attempt),
          UNIQUE(id, epoch)
        );
        CREATE INDEX IF NOT EXISTS runner_leases_active ON runner_leases(runner_id, state);
        CREATE TABLE IF NOT EXISTS runner_lease_transitions (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          lease_id TEXT NOT NULL REFERENCES runner_leases(id) ON DELETE CASCADE,
          epoch INTEGER NOT NULL,
          from_state TEXT,
          to_state TEXT NOT NULL,
          message_id TEXT,
          idempotency_key TEXT,
          details TEXT NOT NULL,
          at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS runner_lease_transition_idempotency
          ON runner_lease_transitions(lease_id, epoch, idempotency_key)
          WHERE idempotency_key IS NOT NULL;
        CREATE TABLE IF NOT EXISTS runner_commands (
          message_id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE,
          runner_id TEXT NOT NULL REFERENCES runner_peers(runner_id),
          lease_id TEXT,
          epoch INTEGER,
          kind TEXT NOT NULL,
          payload TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          sent_at TEXT,
          acknowledged_at TEXT
        );
        CREATE INDEX IF NOT EXISTS runner_commands_pending
          ON runner_commands(runner_id, status, created_at);
        CREATE TABLE IF NOT EXISTS runner_inbox (
          runner_id TEXT NOT NULL REFERENCES runner_peers(runner_id),
          message_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          kind TEXT NOT NULL,
          lease_id TEXT,
          epoch INTEGER,
          payload_hash TEXT NOT NULL,
          response TEXT NOT NULL,
          processed_at TEXT NOT NULL,
          PRIMARY KEY(runner_id, message_id),
          UNIQUE(runner_id, idempotency_key)
        );
        CREATE TABLE IF NOT EXISTS runner_lease_events (
          runner_id TEXT NOT NULL,
          lease_id TEXT NOT NULL,
          epoch INTEGER NOT NULL,
          event_id TEXT NOT NULL,
          event TEXT NOT NULL,
          received_at TEXT NOT NULL,
          PRIMARY KEY(runner_id, event_id),
          FOREIGN KEY(lease_id, epoch) REFERENCES runner_leases(id, epoch) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS runner_lease_results (
          result_id TEXT PRIMARY KEY,
          lease_id TEXT NOT NULL,
          epoch INTEGER NOT NULL,
          result TEXT NOT NULL,
          received_at TEXT NOT NULL,
          UNIQUE(lease_id, epoch),
          FOREIGN KEY(lease_id, epoch) REFERENCES runner_leases(id, epoch) ON DELETE CASCADE
        );
      `);
    },
  },
]);

export function applyMigrations(db, { through = CURRENT_SCHEMA_VERSION } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => row.version),
  );

  for (const migration of MIGRATIONS) {
    if (migration.version > through) continue;
    if (applied.has(migration.version)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.apply(db);
      db.prepare('INSERT INTO schema_migrations (version,applied_at) VALUES (?,?)').run(
        migration.version,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw new Error(`schema migration ${migration.version} failed: ${error.message}`, {
        cause: error,
      });
    }
  }
}
