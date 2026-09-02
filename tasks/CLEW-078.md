---
id: CLEW-078
title: Read-only Codex interactive turn monitor
status: in_review
release: v0.4
priority: P0
size: M
depends_on: [CLEW-068, CLEW-069, CLEW-072]
parallel_group: null
owner: null
updated: 2026-09-02
evidence_policy: v1
---

# CLEW-078 — Read-only Codex interactive turn monitor

## Objective

Add a version-tolerant, read-only monitor that discovers the native thread owned by an interactive Codex TUI and reports durable turn-state transitions and completed agent responses to the Clew scheduler without writing to that thread.

## User outcome

Clew knows whether the live worker is running or waiting for input while the operator continues to use the unchanged Codex terminal.

## Context

`CodexHarness.runInteractive()` currently emits a synthetic session identity, starts the TUI, and then blocks in `terminalManager.waitForFinish()`. The native thread is read only after explicit finish. A separate stdio `codex app-server` successfully performed `thread/read` on an active TUI-owned thread and returned `status: completed` plus its final `agentMessage`. This task turns that verified diagnostic into a bounded adapter.

The adapter must not use `app-server proxy --sock`: that path has already failed with `invalid token` on Codex CLI `0.148.0` and could reintroduce the competing-session failure this terminal design removed.

## Scope

- introduce an isolated native thread-status reader using stdio App Server JSON-RPC;
- discover the current thread by exact worker `cwd`, Run start boundary, and newest compatible session metadata;
- persist the real native thread ID as soon as discovery succeeds;
- read the latest turn ID, status, final agent message, and bounded usage metadata;
- normalize native status values into `starting`, `running`, `waiting_for_operator`, `failed`, and `interrupted`;
- report transitions through callbacks/events without completing the harness promise;
- deduplicate repeated reads by native thread ID, turn ID, status, and item ID;
- stop the reader on `Finish worker`, interruption, PTY exit, or harness teardown;
- tolerate reader timeouts, incompatible payloads, missing sessions, and restarts without affecting the TUI;
- make poll interval and timeout bounded and testable.

## Out of scope

- starting, resuming, interrupting, approving, or mutating Codex turns;
- connecting a second client through the live Unix socket;
- parsing PTY output;
- public Task Thread wording or UI components;
- automatically completing the Clew Run.

## Deliverables

- native read-only thread monitor module or focused harness component;
- normalized transition contract and terminal/session state integration;
- early persisted native session identity;
- deterministic fake App Server fixtures;
- unit, lifecycle, restart, and failure tests;
- compatibility notes for supported Codex protocol fields.

## Acceptance criteria

1. The monitor identifies the active native thread without selecting an older thread that shares the same repository or title.
2. A latest turn with `inProgress` emits one `running` transition and a turn with `completed` emits one `waiting_for_operator` transition containing its final agent message.
3. Repeated reads of the same completed turn produce no duplicate transition or response.
4. A later native turn resets state to `running` and can independently complete.
5. Monitoring never invokes a native write method and does not terminate or detach the TUI.
6. Reader timeout, exit, malformed data, missing thread, and unsupported status produce bounded diagnostics while the worker remains interactive.
7. Monitor teardown leaves no child process, timer, waiter, or socket behind.
8. Recovery after daemon restart can rediscover the active thread and current turn state idempotently.

## Acceptance evidence

| Criterion | Automated evidence                                                  | Logical scenarios                                        | Result  |
| --------- | ------------------------------------------------------------------- | -------------------------------------------------------- | ------- |
| AC-1      | `test/harness-conformance.test.js`                                  | exact cwd; stale same-project thread; Run start boundary | pending |
| AC-2      | `test/harness-conformance.test.js`, `test/terminal-manager.test.js` | starting; in-progress; completed with agent message      | pending |
| AC-3      | `test/harness-conformance.test.js`                                  | repeated poll; repeated native payload                   | pending |
| AC-4      | `test/harness-conformance.test.js`                                  | completed → new in-progress → completed                  | pending |
| AC-5      | `test/harness-conformance.test.js`, protocol call assertions        | sole writer; read-method allowlist                       | pending |
| AC-6      | `test/harness-conformance.test.js`, `test/scheduler.test.js`        | timeout; exit; malformed; missing; unknown status        | pending |
| AC-7      | `test/terminal-manager.test.js`                                     | finish; interrupt; PTY exit; harness failure             | pending |
| AC-8      | `test/daemon.test.js`, `test/harness-conformance.test.js`           | restart before/after discovery and completion            | pending |

## Verification

- adapter tests assert an allowlist containing only initialization and thread read/list requests;
- lifecycle tests use fake clocks and fake App Server processes;
- live smoke reads `inProgress` and `completed` from an attached TUI without `active writer`, `invalid token`, or terminal disconnect errors;
- full backend test and lint suites pass.

## Review record

- Verdict: pending
- Reviewer: unassigned
- Findings: Not reviewed.

## Dependencies and parallelization

Depends on the completed control-plane, daemon, and Session Surface foundations. `CLEW-079` may prepare fixtures against the normalized contract, but final integration waits for this task.

Primary ownership: Codex harness observation, terminal/session runtime state, scheduler callback boundary, and their tests. Avoid public projection wording and visual UI changes owned by `CLEW-079`.

## Risks

- session timestamps and paths require normalization across Codex versions;
- a short-lived initial turn can complete before discovery unless the first read recovers historical state;
- spawning a reader per poll would be expensive, so the implementation should reuse a bounded reader process where possible.

## Blockers

None.

## Completion record

Implementation is present in `src/codex-turn-monitor.js`, `src/harness.js`, and terminal session state. Targeted monitor, harness, terminal-manager, full backend, and lint checks pass. A live one-turn smoke on 2026-09-02 proved delayed native-thread discovery, persistence of the real UUID, completed-turn detection, and explicit finish without changing files. It also exposed and fixed the startup discovery race, synthetic correlation-ID resume bug, and false provisional `interrupted` transitions from a TUI-owned turn. Live two-turn/restart smoke and independent review remain before `done`.
