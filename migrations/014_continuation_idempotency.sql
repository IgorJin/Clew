-- Applied conditionally by src/migrations.js so upgrades remain additive.
ALTER TABLE continuation_grants ADD COLUMN idempotency_key TEXT;
ALTER TABLE completion_overrides ADD COLUMN idempotency_key TEXT;
ALTER TABLE completion_overrides ADD COLUMN unresolved_findings TEXT;
CREATE UNIQUE INDEX continuation_grants_idempotency
  ON continuation_grants(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX completion_overrides_idempotency
  ON completion_overrides(idempotency_key) WHERE idempotency_key IS NOT NULL;
