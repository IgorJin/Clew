---
id: CLEW-070
title: Task Thread projection
status: planned
release: v0.4
priority: P0
size: M
depends_on: [CLEW-068]
parallel_group: v0.4-control-plane
owner: null
updated: 2026-08-28
---

# CLEW-070 — Task Thread projection

## Objective

Build a deterministic causal read model that turns durable execution history into a concise Task Thread without creating a second source of truth.

## User outcome

A developer can understand what happened, why execution retried, what the reviewer found, which revision resulted, and what requires attention without reading raw events or native chat.

## Context

Clew already has append-only events and normalized projections, but `task history` exposes mostly technical records. v0.4 needs a stable presentation model shared by CLI/API and Web UI.

## Scope

- pure/deterministic projection from durable events and referenced records;
- curated items for Task creation, plan versions, human decisions, Stage/Run boundaries, retries, interruptions, structured summaries, reviewer findings, operator messages, result revisions, readiness, overrides, and completion;
- causal source references (`event_seq`, Run/Stage/decision identifiers);
- stable ordering for equal timestamps;
- pagination and reconnect cursor behavior from `CLEW-068`;
- full redacted operator message text;
- separate diagnostic raw-event query;
- rebuild after migration or process restart;
- API-neutral query service usable before daemon integration;
- unknown-event forward compatibility.

## Out of scope

- copying complete native harness conversations;
- storing streamed agent output;
- Evidence Graph or acceptance coverage policy;
- modifying Task execution because projection fails;
- Web UI components.

## Deliverables

- Thread projector/read model;
- query and pagination interface;
- representative snapshot fixtures;
- rebuild and compatibility tests;
- mapping documentation from durable events to Thread item types.

## Acceptance criteria

1. The same durable input always produces byte-equivalent ordered Thread items.
2. Every item identifies its durable source and causal Task/Stage/Run where applicable.
3. A retrying Standard fixture explains findings, correction attempts, and final state.
4. A parallel Deep fixture explains plan approval, concurrent Stages, integration, and review.
5. Operator messages are redacted before projection and preserve actor/timestamp/target.
6. Unknown future events do not break existing projections.
7. Projection errors cannot mutate Task state or event history.

## Verification

- golden snapshot tests;
- randomized equal-timestamp ordering tests;
- rebuild/restart equivalence;
- pagination boundary and cursor tests;
- redaction and unknown-event fixtures.

## Dependencies and parallelization

Depends only on `CLEW-068`. Runs in parallel with daemon, UI, session, and continuation tasks. `CLEW-071` consumes fixtures first and integrates with this query service later.

Primary ownership: Thread projection/read-model modules and query contract implementation. Avoid UI and transport code.

## Risks

- existing event payloads may omit causal identifiers needed by the Thread;
- deriving presentation text directly from unstable payloads can break replay consistency;
- projection rebuild cost may grow with long event histories.

## Blockers

Waiting for `CLEW-068` contracts and fixtures.

## Completion record

Not completed.
