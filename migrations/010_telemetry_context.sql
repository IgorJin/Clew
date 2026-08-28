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
