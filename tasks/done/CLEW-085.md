---
id: CLEW-085
title: Paired execution delivery and recovery
status: done
release: v0.6
priority: P0
size: L
depends_on: [CLEW-083, CLEW-084]
parallel_group: null
owner: null
updated: 2026-09-03
evidence_policy: v1
---

# CLEW-085 — Paired execution delivery and recovery

## Objective

Integrate Runner and Controller implementations into one end-to-end execution path, including normalized progress/result delivery, cancellation, reconnect, restart, and explicit ambiguous-loss recovery.

## User outcome

A Task can execute on the paired Runner and remain understandable when either process or the network fails, without creating hidden duplicate work.

## Scope

- end-to-end Stage offer, acceptance, local execution, progress, result, and acknowledgment;
- fake-harness Quick, Standard, and Deep paired flows;
- review, retry, verification, continuation, and final result parity where applicable;
- cancellation before acceptance and during execution;
- Controller and Runner restart at every durable lease boundary;
- duplicate, delayed, reordered, dropped, and replayed frame injection;
- explicit recovery state and operator diagnostics after ambiguous Runner loss;
- stale-epoch rejection after recovery decisions;
- local-only terminal capability projection and graceful remote-UI degradation;
- bounded normalized artifact/evidence transfer without arbitrary repository upload.

## Out of scope

- automatic ambiguous lease reassignment;
- production pairing UX;
- Docker packaging;
- remote PTY streaming;
- multiple Runners.

## Deliverables

- paired execution adapter and integration tests;
- transport fault-injection harness;
- local-versus-paired parity comparator;
- recovery and cancellation operator diagnostics;
- terminal capability degradation behavior;
- optional Runner-host live Codex smoke procedure.

## Acceptance criteria

1. Paired fake Quick, Standard, and Deep flows reach the same canonical outcomes as local execution.
2. Retry, review, verification, continuation, and result records retain correct Runner/lease provenance.
3. Fault injection at every message and durable transition produces one logical history without duplicate execution.
4. Controller or Runner restart resumes delivery and acknowledgment from persisted identities.
5. Ambiguous loss blocks automatic reassignment and gives the operator an actionable recovery explanation.
6. Cancellation and stale-epoch behavior remain truthful across disconnect and reconnect.
7. Controller UI never attempts to proxy the remote terminal and clearly identifies Runner-local session access.

## Acceptance evidence

| Criterion | Automated evidence          | Logical scenarios                                 | Result |
| --------- | --------------------------- | ------------------------------------------------- | ------ |
| AC-1      | paired parity suite         | Quick; Standard review; Deep plan/DAG/review      | pass   |
| AC-2      | lifecycle provenance tests  | run; lease; session/turn; verify; review; result  | pass   |
| AC-3      | fault-injection matrix      | duplicate; reorder; replay; delayed; dropped ACK  | pass   |
| AC-4      | process/restart suite       | Controller boundaries; Runner ledger; outbox      | pass   |
| AC-5      | recovery presentation tests | accepted/running loss; heartbeat; explicit action | pass   |
| AC-6      | cancellation/fencing tests  | duplicate; running; late ACK; stale epoch         | pass   |
| AC-7      | API/UI capability tests     | local; paired; Runner-local terminal              | pass   |

## Verification

- execute the full paired matrix against real separate processes;
- compare canonical event histories and final results with local mode;
- kill sockets and processes at deterministic barriers;
- inspect all recovery states for an explicit safe next action;
- run the complete backend and UI regression suite.

## Review record

- Verdict: pass
- Reviewer: Codex release audit, 2026-09-03
- Findings: The earlier generic paired shortcut was rejected during review. Stage-level transport, Runner-side native planning/review, Deep DAG execution, isolated worktrees, dependency integration, retry/review provenance, and explicit Runner-local terminal presentation now pass.

## Dependencies and parallelization

Depends on both `CLEW-083` and `CLEW-084`. Owns cross-component behavior and should avoid redesigning their protocol contracts without updating `CLEW-082` fixtures first.

## Risks

- integration shortcuts can bypass the durable outbox or lease authority proven in component tests;
- parity can hide security differences if only final Task state is compared;
- remote terminal expectations can accidentally pull PTY streaming into v0.6.

## Blockers

None.

## Completion record

Completed on 2026-09-03. A real authenticated WebSocket acceptance drives Quick, Standard, and Deep through their distinct canonical lifecycles: Standard records review, and Deep leases architecture plus backend/frontend/integration stages, waits for plan approval, integrates revisions, and records final review. Six durable leases are acknowledged without duplicate history. Separate-process installed acceptance and live Codex paired smoke also pass.
