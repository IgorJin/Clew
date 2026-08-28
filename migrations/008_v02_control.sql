CREATE TABLE operator_actions (
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

CREATE TABLE completions (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  expected_revision TEXT NOT NULL,
  decision TEXT NOT NULL,
  note TEXT,
  actor TEXT NOT NULL,
  at TEXT NOT NULL,
  manifest TEXT NOT NULL
);
