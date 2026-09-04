-- Executable migration 21 is implemented transactionally in src/migrations.js
-- because SQLite lacks portable IF NOT EXISTS support for ADD COLUMN and the
-- legacy event backfill requires JSON parsing with explicit failure handling.
ALTER TABLE runs ADD COLUMN base_sha TEXT;
ALTER TABLE runs ADD COLUMN branch TEXT;
ALTER TABLE runs ADD COLUMN provenance_status TEXT NOT NULL DEFAULT 'unavailable';
