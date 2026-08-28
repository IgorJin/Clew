-- Applied conditionally by src/migrations.js for additive upgrades.
ALTER TABLE continuation_grants ADD COLUMN status TEXT NOT NULL DEFAULT 'GRANTED';
ALTER TABLE continuation_grants ADD COLUMN correction_run_id TEXT;
ALTER TABLE continuation_grants ADD COLUMN operator_message_id TEXT;
ALTER TABLE continuation_grants ADD COLUMN completed_at TEXT;
ALTER TABLE continuation_grants ADD COLUMN result_state TEXT;
ALTER TABLE continuation_grants ADD COLUMN review_verdict TEXT;
CREATE UNIQUE INDEX continuation_grants_run
  ON continuation_grants(correction_run_id) WHERE correction_run_id IS NOT NULL;
