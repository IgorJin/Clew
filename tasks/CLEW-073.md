---
id: CLEW-073
title: Continue and review exhaustion handoff
status: done
release: v0.4
priority: P0
size: M
depends_on: [CLEW-068]
parallel_group: v0.4-control-plane
owner: null
updated: 2026-08-28
---

# CLEW-073 — Continue and review exhaustion handoff

## Objective

Make operator feedback and bounded review correction a durable workflow that always returns ambiguous or repeatedly failing execution to a human.

## User outcome

A developer can continue a `READY` or human-blocked Task with a message, reuse the correct worker context, receive one additional implementation/review cycle, and see why automation stopped.

## Context

Current retry paths are failure-oriented and review exhaustion ends in failure. The target lifecycle distinguishes automatic bounded correction from an explicit operator grant.

## Scope

- `clew continue TASK --message TEXT [--actor ACTOR]`;
- continuation from `READY` and `WAITING_FOR_HUMAN`;
- full redacted operator message with target Stage/session and causal reference;
- exactly one new Run/attempt per continuation;
- native session resume when supported, otherwise a fresh session with prior findings and operator message;
- default automatic budget of three Worker attempts total: initial implementation and two corrections;
- reviewer execution after every automatic or operator-granted correction;
- exhaustion transition to `WAITING_FOR_HUMAN` with count, remaining findings, and explanation;
- each explicit continue grants exactly one Worker correction and one reviewer pass;
- operator completion with unresolved findings from `WAITING_FOR_HUMAN`;
- immutable completion snapshot with `review_override`, actor, and unresolved findings;
- restart/replay idempotency for continuation grants.

## Out of scope

- automatic unlimited retry;
- formal QA verdict;
- mandatory comment when an operator completes with findings;
- UI implementation;
- terminal launching.

## Deliverables

- continuation domain contract implementation;
- migration/store records for messages, grants, and overrides;
- Scheduler review-budget and handoff behavior;
- CLI command and API handler boundary;
- Task Thread source events;
- tests and operational documentation.

## Acceptance criteria

1. Automatic review correction never exceeds three total Worker attempts.
2. Exhaustion creates one `WAITING_FOR_HUMAN` handoff with truthful counts/findings.
3. Replaying or retrying a continuation request cannot create duplicate Runs.
4. One explicit continue grants one correction and one reviewer pass, then returns to `READY` or human attention.
5. Operator feedback reaches the intended worker context and appears redacted in history.
6. Operator completion with findings is allowed, attributable, and immutable.
7. `COMPLETED` remains terminal; later problems require a follow-up Task.

## Verification

- domain transition tests;
- Standard and Deep review-exhaustion fixtures;
- continue from `READY` and `WAITING_FOR_HUMAN`;
- process restart between grant, Run creation, worker completion, and reviewer completion;
- duplicate command/idempotency tests;
- override completion manifest checks.

## Dependencies and parallelization

Depends only on `CLEW-068`. Runs in parallel with daemon, projection, UI, and Session Surface. Uses a stub session capability so it does not depend on `CLEW-072` implementation.

Primary ownership: domain transitions, Store records, Scheduler correction budget, and CLI continuation. Avoid Thread projection and UI components.

## Risks

- current Run count mixes failure retries and review corrections, requiring an explicit budget definition;
- resuming a session and creating a new Run must remain separate identities;
- allowing completion from human attention must not weaken `COMPLETED` immutability.

## Blockers

None.

## Completion record

- Implementation: durable operator continuation messages and grants, idempotent completion overrides, bounded review exhaustion handoff, CLI `continue`, public thread events, migration 014, and immutable completion snapshots retaining override metadata and unresolved findings.
- Verification: `npm run check` passed on 2026-08-28 (91 tests passed, 2 loopback tests skipped by sandbox policy).
- Commit: `93fe379` (`feat: add bounded continuation handoff`).
