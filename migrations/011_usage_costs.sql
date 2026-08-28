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
