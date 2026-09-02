---
id: CLEW-077
title: Interactive worker response and operator-waiting lifecycle
status: planned
release: v0.4
priority: P0
size: L
depends_on: [CLEW-078, CLEW-079]
parallel_group: null
owner: null
updated: 2026-09-02
evidence_policy: v1
---

# CLEW-077 — Interactive worker response and operator-waiting lifecycle

## Objective

Make an interactive Codex worker observable without taking control away from its live TUI: Clew must detect when the current Codex turn starts and completes, persist the completed response into the causal Task Thread, and clearly tell the operator when the attached terminal is waiting for their next instruction or an explicit `Finish worker` action.

## User outcome

While a Task remains `EXECUTING`, the operator can distinguish “the worker is actively reasoning or using tools” from “the worker has returned an answer and the terminal is waiting for me.” Completed worker responses appear in Task Thread without closing the terminal, refreshing the page, parsing terminal escape sequences, or creating a second writer for the Codex thread.

## Context

The live terminal and Task Thread currently use different data paths. The terminal streams a Codex TUI PTY directly to the browser, while Task Thread projects durable Clew events. In the interactive harness, Clew waits for `Finish worker` before reading the Codex thread and recording `WORKER_OUTPUT_RECORDED`, so a final agent response can be visible in the terminal while the UI still reports only an attached, running worker.

Codex CLI `0.148.0` exposes `turn/started` and `turn/completed` in its generated App Server protocol. A read-only `thread/read` against the active persisted thread was verified to return the completed turn and final `agentMessage` while the TUI remained attached. The previously attempted `app-server proxy --sock` path is not a safe basis for this feature because it produced `invalid token` failures in the same installed version.

The accepted design therefore keeps the TUI as the sole writer and observes persisted thread state through an independent stdio App Server reader. See [`../problems/terminal.md`](../problems/terminal.md) for the terminal ownership history and failure analysis.

## Scope

- discover and persist the real Codex thread identity shortly after interactive TUI startup;
- observe the latest Codex turn through read-only App Server requests;
- normalize `inProgress`, `completed`, `failed`, and `interrupted` turn states;
- record each completed agent response exactly once in durable Clew history;
- project the response and an explicit operator-waiting event into Task Thread;
- expose current worker interaction state through the daemon snapshot/API;
- update the Web UI without manual reload and display a prominent terminal-waiting state;
- clear the waiting state when a subsequent turn starts;
- keep `Finish worker` as the explicit boundary for verification, commit, and Run completion;
- recover observation after daemon restart without duplicating Task Thread items.

## Out of scope

- parsing ANSI/PTY output or natural-language phrases such as “I am finished”;
- automatically finishing the Run on the first completed turn;
- allowing an observer to call `turn/start`, `thread/resume`, approval, or mutation methods;
- copying reasoning, hidden chain-of-thought, or arbitrary raw protocol payloads into Task Thread;
- replacing the Codex TUI with a custom chat client;
- changing the semantics of final verification, commit, review, or `Finish worker`.

## Deliverables

- read-only interactive turn monitor and lifecycle integration from `CLEW-078`;
- durable event, projection, API, and UI attention state from `CLEW-079`;
- protocol fixtures covering completed responses and subsequent turns;
- restart, duplicate-suppression, degraded-reader, and interactive terminal regression tests;
- an updated terminal problem record documenting the final implementation and diagnostics.

## Acceptance criteria

1. An active interactive Codex worker exposes `running` while its latest turn is `inProgress` and `waiting_for_operator` after that turn becomes `completed`.
2. The final `agentMessage` for every completed turn appears once in Task Thread with Task, Stage, Run, native thread, and native turn identity.
3. Completing a turn does not kill, detach, or supersede the Codex TUI and does not complete the Clew Run.
4. Sending another terminal message changes the interaction state back to `running`; the next completed response creates one new causal Thread item.
5. `Finish worker` retains its existing behavior and uses the same native thread for result collection, verification, commit, and downstream state transitions.
6. Observer startup/read failures degrade to the existing interactive behavior with an explicit diagnostic and never fail or interrupt the worker.
7. Daemon/UI reconnect and daemon restart recover the latest state without duplicated responses or competing-writer errors.
8. No terminal control sequences, secrets, hidden reasoning, or unbounded native payloads enter public Task Thread or browser state.

## Acceptance evidence

| Criterion | Automated evidence                                                  | Logical scenarios                                                 | Result  |
| --------- | ------------------------------------------------------------------- | ----------------------------------------------------------------- | ------- |
| AC-1      | `test/harness-conformance.test.js`, `test/terminal-manager.test.js` | initial turn; in-progress turn; completed turn                    | pending |
| AC-2      | `test/thread.test.js`, `test/store.test.js`                         | first response; duplicate poll; multiple turns; causal identities | pending |
| AC-3      | `test/harness-conformance.test.js`, `test/terminal-manager.test.js` | completed turn with live PTY and running Run                      | pending |
| AC-4      | `test/harness-conformance.test.js`, `ui/src/App.test.tsx`           | operator follow-up; running reset; second response                | pending |
| AC-5      | `test/scheduler.test.js`, `test/terminal-manager.test.js`           | waiting then explicit finish; verification success/failure        | pending |
| AC-6      | `test/harness-conformance.test.js`, `test/scheduler.test.js`        | missing thread; reader exit; timeout; malformed response          | pending |
| AC-7      | `test/daemon.test.js`, `test/store.test.js`, `ui/src/App.test.tsx`  | browser reconnect; daemon restart; duplicate suppression          | pending |
| AC-8      | `test/thread.test.js`, `ui/src/App.test.tsx`                        | ANSI, HTML, long output, secret-like values, reasoning items      | pending |

## Verification

- generate and inspect the protocol schema from the supported Codex CLI version;
- run unit and contract tests for monitor, Store, Thread projection, daemon snapshot, and UI;
- run the full backend and UI suites plus lint and formatting checks;
- execute a live smoke: Run Task → terminal auto-opens → turn completes → waiting indicator appears → follow-up starts → indicator clears → second response appears → Finish worker completes normally;
- repeat the smoke across a browser reconnect and a daemon restart at the completed-turn boundary;
- verify through process and protocol logs that no second writer or socket proxy is created.

## Review record

- Verdict: pending
- Reviewer: unassigned
- Findings: Not reviewed.

## Dependencies and parallelization

`CLEW-078` establishes the native observation boundary and persisted interaction state. `CLEW-079` consumes that contract to add public Task Thread projection and UI behavior. The parent is complete only after both child tasks pass their own evidence gates and the combined live smoke succeeds.

## Risks

- thread discovery by working directory must reject stale sessions created by earlier Runs;
- polling too frequently can add process and SQLite contention, while polling too slowly makes the UI feel stale;
- native protocol fields can vary across Codex versions and require compatibility normalization;
- daemon restart may encounter a live TUI whose thread identity was not yet persisted;
- public response storage must remain bounded and redacted.

## Blockers

Waiting for the remaining two-turn/reconnect/restart evidence and independent review of `CLEW-078` and `CLEW-079`.

## Completion record

One-turn live smoke passed on 2026-09-02: delayed discovery recovered the native Codex UUID, one completed response appeared as `HARNESS_TURN_WAITING`, the terminal stayed operator-owned, the worktree remained clean, and explicit `Finish worker` completed verification. The smoke uncovered three lifecycle defects; discovery retry, synthetic resume filtering, and provisional external-writer status deduplication were fixed with regression tests. Two-turn and restart/reconnect evidence remain before completion.
