CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  harness TEXT NOT NULL,
  session_id TEXT NOT NULL,
  workspace TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_sessions_task ON agent_sessions(task_id, role);
