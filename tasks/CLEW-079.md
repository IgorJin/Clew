---
id: CLEW-079
title: Show completed worker turns in Task Thread and UI
status: in_review
release: v0.4
priority: P0
size: M
depends_on: [CLEW-078]
parallel_group: null
owner: null
updated: 2026-09-02
evidence_policy: v1
---

# CLEW-079 — Show completed worker turns in Task Thread and UI

## Objective

Persist normalized interactive turn transitions from `CLEW-078`, project completed worker responses into Task Thread, and show a live operator-attention state in the Web UI while preserving explicit `Finish worker` semantics.

## User outcome

When the worker finishes a response, the task immediately says that its terminal is waiting, shows the response in Task Thread, and lets the operator either continue the conversation or finish the worker. No page reload is required.

## Context

Task Thread is a projection of durable Clew events, not a transcript of PTY bytes. Existing interactive responses reach `WORKER_OUTPUT_RECORDED` only after explicit finish. The new monitor provides structured thread ID, turn ID, status, item identity, and final agent message; this task makes those transitions durable and visible.

## Scope

- define durable, versioned events for interactive turn running/completed/failed/interrupted transitions;
- store the bounded, redacted final agent message for completed turns exactly once;
- project completed responses and operator-waiting state into Task Thread with causal identities;
- expose current interaction status, native turn ID, and last transition time in task snapshots;
- push transitions through the existing daemon event stream;
- render `Worker running` and prominent `Terminal waiting for you` states;
- automatically reveal/focus the existing live terminal when operator attention becomes required;
- clear the waiting indication when a new turn starts;
- preserve `Finish worker` as the only action that advances to verification and Run completion;
- render safe fallback wording when a completed turn contains no public agent message.

## Out of scope

- rendering reasoning or complete native protocol history;
- interpreting natural-language completion phrases;
- automatically pressing `Finish worker`;
- changing verification, commit, review, retry, or completion policy;
- replaying terminal control sequences in Task Thread.

## Deliverables

- event/store migration if required by the chosen durable representation;
- Task Thread mappings and projection tests;
- daemon/API snapshot fields and validation;
- Web UI attention banner/status and terminal focus behavior;
- fixture, component, reconnect, restart, redaction, and duplicate tests;
- updated UI and terminal documentation.

## Acceptance criteria

1. A completed native turn creates one durable Task Thread item containing its redacted final agent response and causal Run/thread/turn identity.
2. While that turn remains latest, the daemon snapshot and UI report `waiting_for_operator` and the live terminal remains attached.
3. A subsequent `inProgress` turn clears the waiting indication without deleting or changing the previous Thread item.
4. Browser event delivery, reconnect, and full reload converge on the same current state without duplicate Thread items.
5. `Finish worker` from the waiting state performs the existing result-read and verification flow exactly once.
6. Failed and interrupted turns show explicit attention states without being mislabeled as successful responses.
7. Public output is bounded, redacted, escaped, and excludes reasoning and terminal escape sequences.
8. Existing non-interactive, fake, and OpenCode execution paths retain their current Task Thread and UI behavior.

## Acceptance evidence

| Criterion | Automated evidence                                        | Logical scenarios                                                | Result  |
| --------- | --------------------------------------------------------- | ---------------------------------------------------------------- | ------- |
| AC-1      | `test/store.test.js`, `test/thread.test.js`               | completed message; duplicate event; causal fields                | pending |
| AC-2      | `test/control-service.test.js`, `ui/src/App.test.tsx`     | waiting state with attached terminal                             | pending |
| AC-3      | `test/thread.test.js`, `ui/src/App.test.tsx`              | follow-up turn starts after completion                           | pending |
| AC-4      | `test/daemon.test.js`, `ui/src/App.test.tsx`              | live event; cursor reconnect; reload; daemon restart             | pending |
| AC-5      | `test/scheduler.test.js`, `test/terminal-manager.test.js` | finish from waiting; duplicate finish; verification failure      | pending |
| AC-6      | `test/thread.test.js`, `ui/src/App.test.tsx`              | native failed and interrupted turns                              | pending |
| AC-7      | `test/thread.test.js`, `ui/src/App.test.tsx`              | long message; ANSI; HTML; secret-like values; reasoning omission | pending |
| AC-8      | backend and UI regression suites                          | fake; OpenCode; non-interactive Codex                            | pending |

## Verification

- projection and API contract tests for every normalized turn state;
- UI component tests for event delivery, reload, focus, and follow-up transitions;
- redaction, escaping, payload-size, and unknown-event negative tests;
- full backend/UI suites, production UI build, lint, and formatting checks;
- live interactive smoke covering two turns and explicit finish.

## Review record

- Verdict: pending
- Reviewer: unassigned
- Findings: Not reviewed.

## Dependencies and parallelization

Depends on the normalized monitor contract from `CLEW-078`. Fixture and visual work may begin against that contract while backend persistence is implemented.

Primary ownership: durable interaction events, Task Thread projection, daemon/API presentation fields, `ui/`, and their tests. Do not change the Codex observer transport established by `CLEW-078`.

## Risks

- treating the waiting state as Task-level `WAITING_FOR_HUMAN` would incorrectly alter scheduler semantics; it must remain an interaction status inside an `EXECUTING` Run;
- large or unsafe agent messages require the same redaction and rendering boundaries as existing public output;
- repeated polling and reconnect replay must share one idempotency key.

## Blockers

Waiting for `CLEW-078`.

## Completion record

Implementation is present in `src/thread.js`, `src/control-service.js`, `ui/src/api.ts`, and `ui/src/App.tsx`. Task Thread, UI, full backend, UI build/tests, and lint checks pass. A live one-turn smoke on 2026-09-02 produced exactly one final `HARNESS_TURN_WAITING` with native Run/thread/turn identity, kept the Run `EXECUTING`, and reached `READY` only after explicit `Finish worker`. Live two-turn/reconnect smoke and independent review remain before `done`.
