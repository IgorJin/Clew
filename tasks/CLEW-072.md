---
id: CLEW-072
title: Native Session Surface
status: planned
release: v0.4
priority: P1
size: L
depends_on: [CLEW-068]
parallel_group: v0.4-control-plane
owner: null
updated: 2026-08-28
---

# CLEW-072 — Native Session Surface

## Objective

Open the exact native Codex session and workspace behind a Clew role in a normal terminal without replacing native UX or disturbing scheduler ownership.

## User outcome

From CLI or Web UI, a developer can open the Architect, Worker, or Reviewer thread in a terminal, inspect or interact with it, and return to Clew's Task view.

## Context

Clew persists native session and turn IDs but currently exposes them only as data. Codex CLI supports session resume, while concurrent attach/ownership behavior must be proven rather than assumed.

## Scope

- capability-based `SessionSurface` interface from `CLEW-068`;
- required plain-terminal surface;
- Codex `resume` integration spike covering active and completed turns;
- correct session ID, working directory, model context, and workspace selection;
- safe process launch without shell interpolation;
- opening a session does not pause Scheduler or create a second Clew Run;
- detach and terminal-close behavior;
- stale/missing session diagnostics;
- native interruption/process-exit signal propagation when reliably observable;
- `NoneSurface` fallback;
- CLI/API open-session operation consumed by UI.

## Out of scope

- terminal emulator embedded in Clew;
- mandatory cmux or Agent Deck dependency;
- guaranteed OpenCode attach in v0.4;
- controlling a live session when the harness does not support safe concurrent clients;
- remote terminal streaming.

## Deliverables

- documented Codex attach/resume spike decision;
- Session Surface implementation and conformance suite;
- plain-terminal launcher for supported local platforms;
- capability/status diagnostics;
- stale and unsupported session handling.

## Acceptance criteria

1. Clew opens the intended Codex Architect, Worker, or Reviewer session in its workspace.
2. Opening/closing a terminal does not duplicate Runs or turns.
3. Active-session behavior is capability-tested and never guessed.
4. Unsupported harness/surface combinations return structured diagnostics.
5. User-controlled IDs and paths cannot inject shell commands.
6. A native interruption is never normalized as successful completion.

## Verification

- fake terminal/session conformance tests;
- Codex protocol fixture tests;
- live optional Codex resume smoke for active and completed sessions;
- stale session, wrong workspace, detach, and interruption cases;
- command argument and path safety tests.

## Dependencies and parallelization

Depends only on `CLEW-068`. Runs independently of UI and continuation; exposes stable operations they can consume.

Primary ownership: Session Surface abstraction and terminal adapters. Avoid Scheduler transition changes owned by `CLEW-073`.

## Risks

- native CLI/app-server may not guarantee simultaneous interactive ownership;
- terminal-launch APIs vary across macOS and Linux;
- resuming a completed session may start a new turn unexpectedly if arguments are wrong.

## Blockers

Waiting for `CLEW-068` Session Surface contract.

## Completion record

Not completed.
