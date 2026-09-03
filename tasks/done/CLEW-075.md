---
id: CLEW-075
title: Controller/Runner transport and leases
status: done
release: v0.6
priority: P0
size: L
depends_on: [CLEW-077]
parallel_group: null
owner: null
updated: 2026-09-03
evidence_policy: v1
---

# CLEW-075 — Controller/Runner transport and leases

## Objective

Separate execution from the Clew Controller through a versioned, authenticated, reconnectable protocol so one Runner can execute leased Stages without giving the Controller access to repositories, native harness credentials, or an unrestricted shell.

## User outcome

A developer can run Controller/UI and Runner as separate processes, submit a Task through the Controller, execute it on the Runner's machine, survive temporary disconnects, and retain one truthful durable Task history.

## Release outcome

This work package is the complete scope of `v0.6.0`. The release proves the distributed execution boundary before adding pairing UX, Docker packaging, or multi-Runner scheduling.

The v0.6 operator configures one Runner identity and a pre-shared credential out of band through secret files or environment configuration. `CLEW-080` replaces this bootstrap with pairing, rotation, revocation, and replacement UX in v0.7.

## Architecture boundary

Controller owns:

- Task contracts, plans, lifecycle state, operator actions, and the canonical event history;
- scheduling decisions, lease authority, attempt policy, review orchestration, and final completion;
- public Task Thread and Web UI projections;
- acknowledgment of Runner events and normalized results.

Runner owns:

- repository mappings, Git operations, worktrees, native harness processes, and local verification commands;
- Codex/OpenCode credentials and environment secrets;
- local terminal/session processes and their output boundary;
- temporary delivery buffers required to reconnect safely.

The Controller may receive normalized, redacted events, evidence, revisions, summaries, and artifacts explicitly allowed by protocol. It never receives arbitrary repository files, environment values, harness credentials, or general shell access.

## Protocol shape

The Runner initiates an authenticated WebSocket connection and registers one stable `runner_id`, protocol version, product version, capabilities, and workspace mappings. The first protocol version uses explicit envelopes and durable idempotency keys for:

- `RUNNER_REGISTER` and registration acknowledgment;
- heartbeat and capability refresh;
- `LEASE_OFFER`, `LEASE_ACCEPT`, and lease rejection;
- normalized Stage progress events;
- cancellation request and cancellation acknowledgment;
- `STAGE_RESULT` or terminal failure upload;
- Controller acknowledgment and bounded Runner outbox cleanup.

Delivery is at least once. Correctness comes from durable idempotency and lease fencing, not from pretending the network provides exactly-once delivery.

## Lease lifecycle

```text
AVAILABLE
  → OFFERED
  → ACCEPTED
  → RUNNING
  → RESULT_UPLOADED
  → ACKNOWLEDGED
```

Exceptional transitions are explicit:

- an unaccepted offer may expire and return to `AVAILABLE`;
- an accepted or running lease never silently becomes available merely because the socket disconnected;
- reconnect resumes the same lease from persisted Runner and Controller identities;
- lease expiry after Runner loss moves the Stage to human-visible recovery, not automatic duplicate execution;
- cancellation is requested durably and remains pending until acknowledged or classified as unreachable;
- stale lease epochs cannot upload events or results after reassignment/recovery.

## Scope

- versioned Controller/Runner contracts and compatibility negotiation;
- one configured Runner per Controller;
- pre-shared credential authentication with strict redaction;
- outbound Runner WebSocket with heartbeat and reconnect backoff;
- stable Runner identity, capabilities, workspace mappings, and health projection;
- durable Stage lease records with epochs/fencing tokens;
- offer, accept, reject, cancellation, result, and acknowledgment lifecycle;
- idempotent inbound commands and outbound event/result delivery;
- bounded Runner outbox persisted across reconnect and process restart;
- stable `runner_id` and lease identity on Runs, events, and results;
- parity adapter preserving the existing in-process execution path;
- explicit local-only terminal capability: no PTY bytes traverse Controller;
- fake-harness Quick, Standard, and Deep paired acceptance;
- one optional live Codex smoke opened and finished locally on the Runner host.

## Out of scope

- pairing codes, credential rotation/revocation UI, and Runner replacement workflow (`CLEW-080`);
- Docker image, Compose, TLS/reverse proxy, backup/restore, and self-hosted packaging (`CLEW-076`);
- multiple active Runners, load balancing, failover, or lease migration;
- remote terminal streaming or browser access to Runner PTY bytes;
- repository or arbitrary artifact upload;
- team identity, RBAC, hosted accounts, or public ingress;
- automatic reassignment after ambiguous Runner loss.

## Deliverables

- protocol schemas, runtime validators, compatibility fixtures, and redaction policy;
- Runner service/CLI mode and outbound transport client;
- Controller Runner gateway and health projection;
- lease/outbox persistence and migrations;
- Scheduler execution-port abstraction for in-process and paired modes;
- reconnect, duplicate, reorder, cancellation, restart, and stale-epoch tests;
- paired fake-harness acceptance and optional live Runner-host Codex smoke;
- `RELEASE-0.6.md`, migration evidence, installed-package check, tag, and publication record.

## Acceptance criteria

1. One authenticated Runner registers outbound with stable identity, compatible versions, capabilities, and workspace mappings.
2. Quick, Standard, and Deep fake-harness Tasks produce equivalent durable outcomes through in-process and paired execution.
3. Every remote Stage uses one persisted lease identity and epoch from offer through Controller acknowledgment.
4. Duplicate, delayed, reordered, or replayed protocol messages cannot create another logical Run, native turn, event, or result.
5. Disconnect and restart at every lease boundary resume or surface one explicit recovery state without automatic duplicate execution.
6. Cancellation is durable, acknowledged when reachable, and truthfully reported when the Runner is unreachable.
7. Stale credentials, unsupported protocol/product versions, unknown Runner identities, and stale lease epochs are rejected before mutation.
8. Controller persistence, logs, APIs, and browser projections contain no Runner credentials, harness credentials, environment secrets, arbitrary source files, or PTY bytes.
9. Local-first in-process mode remains the default and passes its existing acceptance suite unchanged.
10. A Runner-host live Codex smoke, when credentials are available, keeps terminal ownership local and records normalized progress/result through the transport; otherwise the release records an explicit environmental skip.

## Acceptance evidence

| Criterion | Automated evidence                     | Logical scenarios                                        | Result |
| --------- | -------------------------------------- | -------------------------------------------------------- | ------ |
| AC-1      | protocol, auth, and registration tests | valid; duplicate; incompatible; unknown workspace        | pass   |
| AC-2      | local/paired parity suite              | Quick; Standard review/retry; Deep plan/DAG/review       | pass   |
| AC-3      | lease-store and Scheduler tests        | offer; accept; run; result; acknowledgment               | pass   |
| AC-4      | transport fault-injection tests        | duplicate; reorder; replay; delayed; dropped ACK         | pass   |
| AC-5      | restart/reconnect matrix               | every Controller boundary; Runner ledger/outbox restart  | pass   |
| AC-6      | cancellation tests                     | duplicate; running; late result/ACK; unreachable command | pass   |
| AC-7      | compatibility, auth, and fencing tests | stale credential; product/protocol skew; identity; epoch | pass   |
| AC-8      | security and package inspection        | DB; API; UI; outbox; tarball; separate process           | pass   |
| AC-9      | existing local acceptance suite        | 174 backend + 16 UI; local Quick/Standard/Deep/terminal  | pass   |
| AC-10     | live Codex smoke                       | paired Runner; local worktree; normalized result; no PTY | pass   |

## Decomposition

- `CLEW-082` — protocol contracts, identities, compatibility, and security boundary;
- `CLEW-083` — Runner process, outbound authenticated transport, heartbeat, reconnect, and outbox;
- `CLEW-084` — Controller gateway, durable lease authority, fencing, and Scheduler execution port;
- `CLEW-085` — paired execution integration, result delivery, cancellation, and fault recovery;
- `CLEW-086` — v0.6 parity acceptance, migration, release evidence, tag, and publication.

`CLEW-083` and `CLEW-084` may proceed in parallel after `CLEW-082`. `CLEW-085` integrates them. `CLEW-086` owns the final release gate.

## Verification

- validate every protocol fixture against schemas and runtime validators;
- inject duplicate, reordered, delayed, dropped, and replayed frames;
- restart Controller and Runner at every persisted lease transition;
- compare local and paired Task histories and final results;
- inspect SQLite, logs, API payloads, browser snapshots, and package contents for forbidden data;
- run `npm run check`, installed-package acceptance, and the dedicated paired acceptance suite;
- run or explicitly skip the optional Runner-host live Codex smoke.

## Review record

- Verdict: pass
- Reviewer: Codex release audit, 2026-09-03
- Findings: Candidate gaps in Standard/Deep parity, Runner worktree isolation, product skew, heartbeat durability, late cancellation ACK handling, and native Codex write policy were found and closed. No blocking findings remain.

## Dependencies and parallelization

Depends on the released v0.5 daemon/API, Task Thread, terminal lifecycle, and shared `ClewService`. `CLEW-082` is complete; Runner and Controller implementation proceed in parallel through `CLEW-083` and `CLEW-084`.

## Risks

- ambiguous Runner loss can duplicate expensive native work if accepted leases are automatically recycled;
- an unbounded outbox can exhaust disk during Controller outages;
- version skew can corrupt state unless rejected before registration or lease mutation;
- treating WebSocket delivery as exactly once can hide replay bugs;
- current terminal UX is local to the Runner host and must degrade explicitly from the Controller UI;
- Controller-side workspace paths can accidentally become host filesystem authority if mappings are underspecified.

## Blockers

None.

## Completion record

Completed on 2026-09-03 as the dedicated v0.6 release. `CLEW-082` through `CLEW-086` are complete; protocol, Runner, Controller lease authority, stage-level paired semantics, Runner-owned Git isolation, recovery/fault matrix, migration, clean installed dual-process acceptance, security inspection, full local regression, and live Codex smoke pass. Publication is explicitly authorized as the final release action.
