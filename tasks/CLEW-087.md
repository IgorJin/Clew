---
id: CLEW-087
title: Persist immutable run Git provenance
status: in_review
release: v0.8
priority: P0
size: M
depends_on: []
parallel_group: null
owner: null
updated: 2026-09-03
evidence_policy: v1
---

# CLEW-087 — Persist immutable run Git provenance

## Objective

Persist the Git baseline needed to explain an agent run's changes after the run, restart, or retry.

## User outcome

Every run has a durable base commit SHA and branch that can be used to inspect its worktree without guessing from the current checkout.

## Context

Change visibility must be tied to the exact run and execution environment. Existing databases and legacy runs need an explicit, safe recovery path.

## Scope

- Add persisted `base_sha` and branch provenance to run records and paired-run metadata.
- Add a safe migration for existing SQLite databases.
- Recover legacy baselines from `STAGE_RUN_STARTED` when possible; otherwise return explicit `unavailable`.

## Out of scope

- Computing diffs or opening editors; those belong to CLEW-088 and CLEW-089.
- Merge, push, or primary-checkout mutation.

## Deliverables

- Schema migration, persistence/read-model changes, legacy recovery logic, and fixtures.

## Acceptance criteria

1. New Quick, Standard, Deep, retry, restart, and paired runs retain immutable base SHA and branch metadata.
2. Existing databases migrate without data loss; legacy runs recover from `STAGE_RUN_STARTED` or report `unavailable` explicitly.

## Acceptance evidence

| Criterion | Automated evidence                                     | Logical scenarios                                         | Result                              |
| --------- | ------------------------------------------------------ | --------------------------------------------------------- | ----------------------------------- |
| AC-1      | Migration, store, scheduler, and Runner protocol tests | all profiles; retries; restarts; paired metadata contract | pass; live paired execution pending |
| AC-2      | Populated v0.7 migration fixture                       | recoverable and unavailable legacy baseline               | pass                                |

## Verification

- Run migration and persistence tests against clean and populated databases.
- Verify immutability, duplicate events, restart boundaries, and runner-local/paired state.

## Review record

- Verdict: pending independent review
- Reviewer: unassigned
- Findings: Live paired Runner acceptance is pending because the current sandbox disallows loopback listeners.

## Dependencies and parallelization

Wave 0; unblocks inspection and viewer work. Own the run schema and provenance contract.

## Risks

- Historical event payloads may not contain enough information to reconstruct a baseline.

## Blockers

None.

## Completion record

Not completed.
