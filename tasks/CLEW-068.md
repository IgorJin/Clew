---
id: CLEW-068
title: Local control plane contracts
status: done
release: v0.4
priority: P0
size: M
depends_on: [CLEW-067]
parallel_group: null
owner: null
updated: 2026-08-28
evidence_policy: legacy
---

# CLEW-068 — Local control plane contracts

## Objective

Freeze the v0.4 API, streaming, Task Thread, continuation, and Session Surface contracts so five downstream packages can be implemented independently.

## User outcome

This is an enabling contract task. It prevents the daemon, UI, projection, session, and continuation implementations from inventing incompatible boundaries.

## Context

Current Clew commands instantiate Store and Scheduler directly. v0.4 introduces a local Controller while preserving existing Task behavior and SQLite data.

## Scope

- `/api/v1` command/query/response/error envelopes;
- HTTP authentication and local client identity contract;
- WebSocket event envelope, monotonic cursor, replay window, reconnect, and gap behavior;
- daemon identity and exclusive state-directory ownership record;
- Task Thread item, causal source, pagination, and redaction schemas;
- operator-message, continuation grant, review exhaustion, and completion override contracts;
- `SessionSurface` capabilities and open-session request/result contracts;
- migration design for new durable records;
- runtime validators and forward-compatible unknown-field rules;
- secret-safe fixtures for Quick, retrying Standard, parallel Deep, interruption, and human handoff.

## Out of scope

- daemon process implementation;
- Thread projection implementation;
- React application;
- terminal launch;
- changing current execution behavior.

## Deliverables

- versioned JSON Schemas;
- runtime validators and domain types;
- migration and compatibility notes;
- fixture corpus consumable by backend, UI, and adapter tests;
- concise API protocol documentation.

## Acceptance criteria

1. Every planned v0.4 command and read model has a versioned schema.
2. WebSocket ordering, reconnect, duplicate, and cursor-expiry semantics are unambiguous.
3. UI fixtures represent every required state without importing server code.
4. Continuation and session contracts preserve Task/Run/session identity.
5. Raw secrets and native chat content are absent from fixtures.
6. Existing v0.3 records remain valid after the proposed migration.

## Verification

- schema and fixture JSON validation;
- runtime-validator parity tests;
- compatibility fixtures for known/unknown fields;
- consumer contract tests stubbed for `CLEW-069`–`073`.

## Dependencies and parallelization

Depends on the released v0.3 baseline. Completion unlocks the `v0.4-control-plane` parallel group.

Primary ownership: `schemas/`, shared protocol/domain modules, and fixtures. Avoid implementing downstream runtime behavior.

## Risks

- over-designing remote/team behavior before local daemon experience exists;
- coupling Thread presentation to current event payload accidents;
- browser and CLI authentication needs diverging contracts.

## Blockers

None.

## Completion record

- Implementation: v1 API/WebSocket/Thread/continuation/Session Surface schemas, forward-compatible runtime validators, safe fixture corpus, protocol documentation, and additive migration 012.
- Verification: `npm run check` passed with 83 tests on 2026-08-28; schema artifacts and runtime validator parity tests passed.
- Unblocked: `CLEW-069`–`CLEW-073` are now ready for parallel implementation.
