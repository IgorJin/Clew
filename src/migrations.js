export const CURRENT_SCHEMA_VERSION = 8;

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
]);

export function applyMigrations(db) {
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
