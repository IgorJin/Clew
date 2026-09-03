---
id: CLEW-084
title: Controller Runner gateway and lease authority
status: done
release: v0.6
priority: P0
size: L
depends_on: [CLEW-082]
parallel_group: v0.6-transport
owner: null
updated: 2026-09-03
evidence_policy: v1
---

# CLEW-084 — Controller Runner gateway and lease authority

## Objective

Implement the Controller-side authenticated Runner gateway and durable lease authority, then route Scheduler execution through an explicit local-or-paired execution port without changing Task semantics.

## User outcome

The Controller can show whether its one Runner is available, offer a Stage exactly once logically, retain authority across reconnect/restart, and reject stale or unauthorized results.

## Scope

- explicitly configured Runner WebSocket endpoint and authentication;
- one active Runner identity, registration, capability, workspace, and health projection;
- durable lease, epoch, offer, acceptance, cancellation, result, and acknowledgment records;
- transactional lease transitions and idempotency ledger;
- stale-epoch fencing and post-terminal mutation rejection;
- heartbeat timeout classification without automatic ambiguous reassignment;
- Scheduler execution-port abstraction preserving in-process mode;
- mapping Stage requirements to Runner capabilities/workspaces;
- normalized Runner events/results into existing Store and Task Thread boundaries;
- public-safe Runner availability and recovery diagnostics;
- Controller restart reconciliation with active and ambiguous leases.

## Out of scope

- Runner process internals;
- pairing UX or credential rotation;
- multi-Runner selection and load balancing;
- automatic failover/reassignment;
- remote terminal streaming.

## Deliverables

- Controller Runner gateway;
- lease and idempotency migrations;
- local/paired execution-port interface;
- Scheduler integration behind capability/config selection;
- health and lease diagnostics;
- transition, fencing, restart, and security tests.

## Acceptance criteria

1. Only the configured authenticated Runner can register, and duplicate connections resolve deterministically.
2. Lease creation and every transition are transactional, idempotent, and linked to Task, Stage, Run, attempt, Runner, and epoch.
3. A dropped connection after offer or acceptance never silently makes the Stage available for duplicate execution.
4. Stale epochs, wrong Runner identities, duplicate results, and post-terminal events cannot mutate canonical state.
5. Controller restart restores Runner health and lease truth without issuing duplicate offers.
6. In-process execution remains the default and preserves existing CLI/API behavior.
7. Public projections expose safe Runner/lease diagnostics without credentials, host paths, raw native output, or PTY bytes.

## Acceptance evidence

| Criterion | Automated evidence              | Logical scenarios                                           | Result |
| --------- | ------------------------------- | ----------------------------------------------------------- | ------ |
| AC-1      | gateway auth/registration tests | valid; wrong token; duplicate socket; wrong Runner/skew     | pass   |
| AC-2      | lease-store tests               | every transition; duplicate frame; atomic persistence       | pass   |
| AC-3      | disconnect tests                | offered; accepted; running; result upload; heartbeat        | pass   |
| AC-4      | fencing/idempotency tests       | stale epoch; wrong Runner; repeated result; terminal replay | pass   |
| AC-5      | restart reconciliation tests    | offered; accepted; running; completed boundary              | pass   |
| AC-6      | local regression suite          | CLI; API; Quick; Standard; Deep; terminal                   | pass   |
| AC-7      | projection/security tests       | DB; logs; API; UI; Runner-local terminal                    | pass   |

## Verification

- run against the `CLEW-082` fake Runner conformance peer;
- inject concurrent, duplicate, stale, and reordered transitions;
- restart Controller at every persisted lease boundary;
- compare local execution behavior before and after the execution-port abstraction;
- inspect public and durable state for forbidden Runner data.

## Review record

- Verdict: pass
- Reviewer: Codex release audit, 2026-09-03
- Findings: Product skew, heartbeat timeout, cancellation/result race, restart boundaries, safe health projection, and local default behavior were reviewed. No blocking findings remain.

## Dependencies and parallelization

Depends on `CLEW-082`. Runs in parallel with Runner-side `CLEW-083`; integration waits for both.

## Risks

- heartbeat timeout can be mistaken for proof that native execution stopped;
- non-transactional lease/event persistence can produce impossible histories;
- execution-port abstraction can accidentally fork local and paired Task semantics.

## Blockers

None.

## Completion record

Completed on 2026-09-03 through migration 17, Runner-aware Store operations, `ControllerRunnerGateway`, local/paired execution ports, synchronous heartbeat-loss classification, daemon health projection, restart reconciliation, and Scheduler selection. Lease/gateway/execution-port tests, 174-test local regression, and real transport gates pass.
