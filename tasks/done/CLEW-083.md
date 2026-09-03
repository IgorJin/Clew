---
id: CLEW-083
title: Runner process and outbound transport
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

# CLEW-083 — Runner process and outbound transport

## Objective

Implement the host-side Runner service that authenticates outbound, advertises local execution capabilities, retains a bounded durable outbox, and reconnects without losing or duplicating protocol intent.

## User outcome

A developer can start one Runner beside their repositories and native harnesses, connect it to a Controller, diagnose its health, and keep an accepted Stage alive across temporary network loss.

## Scope

- `clew runner serve` foreground service and explicit configuration;
- stable Runner identity and pre-shared credential loading from environment or restrictive secret file;
- outbound WebSocket authentication and protocol registration;
- TLS requirement for non-loopback Controller URLs;
- capabilities, workspace mappings, version, and heartbeat reporting;
- reconnect with bounded exponential backoff and jitter;
- durable bounded outbox for events, results, cancellation acknowledgments, and replay;
- inbound idempotency ledger for offers and cancellation requests;
- local execution-port interface used by fake and native harness implementations;
- local terminal/session ownership and explicit `runner_local` capability metadata;
- graceful shutdown, signal handling, diagnostics, and stale-process ownership protection.

## Out of scope

- Controller lease decisions;
- pairing-code lifecycle;
- remote PTY streaming;
- daemonization/service-manager installers;
- multiple simultaneous Controller connections.

## Deliverables

- Runner runtime and CLI commands;
- transport client and protocol adapter;
- Runner state/outbox persistence;
- fake execution port and conformance tests;
- operational status and safe logs;
- reconnect, restart, overflow, and shutdown tests.

## Acceptance criteria

1. Runner authenticates and registers with stable identity, versions, capabilities, and workspace mappings.
2. Connection loss triggers bounded reconnect without starting another local execution or losing accepted work.
3. Outbound events/results survive Runner restart and are deleted only after matching Controller acknowledgment.
4. Duplicate lease offers and cancellation requests produce one local action and repeat the prior acknowledgment.
5. Outbox limits and Controller outage cannot grow disk usage without a visible bounded-failure policy.
6. Secrets and local terminal bytes never enter logs, status payloads, or the outbox.
7. Shutdown leaves no orphan transport process, timer, native execution, or writable ownership lock.

## Acceptance evidence

| Criterion | Automated evidence                   | Logical scenarios                                            | Result |
| --------- | ------------------------------------ | ------------------------------------------------------------ | ------ |
| AC-1      | Runner registration tests            | valid; auth error; skew; workspace capabilities              | pass   |
| AC-2      | reconnect tests                      | disconnect before/after accept; bounded backoff; reconnect   | pass   |
| AC-3      | outbox persistence tests             | event; result; restart; delayed/dropped acknowledgment       | pass   |
| AC-4      | inbound idempotency tests            | duplicate offer; duplicate cancel; process restart           | pass   |
| AC-5      | resource-bound tests                 | normal reserve; terminal reserve; visible capacity failure   | pass   |
| AC-6      | redaction and persistence inspection | token; environment; PTY bytes; native output                 | pass   |
| AC-7      | teardown tests                       | SIGTERM; socket error; active fake execution; ownership lock | pass   |

## Verification

- run against the `CLEW-082` fake Controller conformance peer;
- inject disconnects and process restarts around every outbox operation;
- inspect Runner state and logs for forbidden fields;
- verify local terminal capability never serializes terminal data;
- run the full repository quality gate.

## Review record

- Verdict: pass
- Reviewer: Codex release audit, 2026-09-03
- Findings: Durable replay, bounded outbox, duplicate offer/cancel behavior, Runner restart recovery, test-only native approval, and clean process ownership were reviewed. No blocking findings remain.

## Dependencies and parallelization

Depends on `CLEW-082`. Runs in parallel with Controller-side `CLEW-084`; both consume only shared protocol fixtures until integration in `CLEW-085`.

## Risks

- replaying an accepted offer after restart can start a second native process without a local idempotency ledger;
- an unbounded outbox can turn Controller downtime into disk exhaustion;
- terminal ownership can leak into transport scope through convenience shortcuts.

## Blockers

None.

## Completion record

Completed on 2026-09-03 in `src/runner.js`, `src/runner-transport.js`, `src/runner-store.js`, `src/runner-execution.js`, standalone config, and `clew runner serve|status`. Runner now owns isolated Git worktrees and Deep dependency integration. Focused restart/replay/capacity/security tests, separate-process installed acceptance, live paired Codex, and the full repository gate pass.
