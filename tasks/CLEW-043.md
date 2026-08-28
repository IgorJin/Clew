---
id: CLEW-043
title: Usage, token, and cost accounting
status: done
release: v0.3
priority: P1
size: L
depends_on: [CLEW-042]
parallel_group: null
owner: null
updated: 2026-08-28
evidence_policy: legacy
---

# CLEW-043 — Usage, token, and cost accounting

## Objective

Answer what a Task consumed using provider-reported usage and reproducible pricing data without fabricating missing values.

## User outcome

A developer can inspect the complete Task lifecycle usage and cost across Stages, attempts, retries, sessions, and turns in JSON or concise human output.

## Delivered scope

- one idempotent usage record per native turn;
- input, output, cache-read, cache-write, and reasoning token categories;
- explicit complete, partial, and unknown usage;
- immutable provider/catalog pricing snapshots;
- provider-agnostic `clew pricing sync` command for external cron use;
- decimal cost projection with separate currencies;
- `clew task usage` and result-manifest summary;
- migration 011, schemas, documentation, and tests.

## Out of scope

- tokenizer-based estimation;
- silently treating unknown usage as zero;
- embedded scheduler for pricing sync;
- budgets, quotas, chargeback, and optimization recommendations.

## Acceptance criteria

1. Replaying the same turn does not duplicate usage.
2. Missing data remains unknown or partial.
3. Decimal totals reproduce the underlying records.
4. Pricing snapshots are immutable and checksum-addressed.
5. Complete lifecycle totals include every recorded attempt and Stage.

## Verification

- Full project check passed with 80 automated tests.
- Idempotency and exact decimal-cost fixtures passed.

## Dependencies and parallelization

Built after `CLEW-042`; `CLEW-067` consumes both work packages for release acceptance.

## Risks

- Native adapters expose different and sometimes incomplete usage fields.
- Provider pricing APIs and catalog formats are not standardized.

## Blockers

None.

## Completion record

- Implementation commit: `c181345`.
- Merge commit: `8640d2c`.
