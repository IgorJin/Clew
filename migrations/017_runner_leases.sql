ALTER TABLE runs ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'local';
ALTER TABLE runs ADD COLUMN workspace_ref TEXT;
ALTER TABLE runs ADD COLUMN runner_id TEXT;

CREATE TABLE runner_peers (
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

CREATE TABLE runner_leases (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  stage_id TEXT NOT NULL,
  run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  runner_id TEXT NOT NULL REFERENCES runner_peers(runner_id),
  epoch INTEGER NOT NULL CHECK (epoch > 0),
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
  UNIQUE (task_id, stage_id, attempt),
  UNIQUE (id, epoch)
);

CREATE INDEX runner_leases_active ON runner_leases(runner_id, state);

CREATE TABLE runner_lease_transitions (
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

CREATE UNIQUE INDEX runner_lease_transition_idempotency
  ON runner_lease_transitions(lease_id, epoch, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE runner_commands (
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

CREATE INDEX runner_commands_pending ON runner_commands(runner_id, status, created_at);

CREATE TABLE runner_inbox (
  runner_id TEXT NOT NULL REFERENCES runner_peers(runner_id),
  message_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  lease_id TEXT,
  epoch INTEGER,
  payload_hash TEXT NOT NULL,
  response TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  PRIMARY KEY (runner_id, message_id),
  UNIQUE (runner_id, idempotency_key)
);

CREATE TABLE runner_lease_events (
  runner_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  event TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (runner_id, event_id),
  FOREIGN KEY (lease_id, epoch) REFERENCES runner_leases(id, epoch) ON DELETE CASCADE
);

CREATE TABLE runner_lease_results (
  result_id TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  result TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE (lease_id, epoch),
  FOREIGN KEY (lease_id, epoch) REFERENCES runner_leases(id, epoch) ON DELETE CASCADE
);
