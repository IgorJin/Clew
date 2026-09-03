---
id: CLEW-069
title: Local daemon and API server
status: done
release: v0.4
priority: P0
size: L
depends_on: [CLEW-068]
parallel_group: v0.4-control-plane
owner: null
updated: 2026-08-28
evidence_policy: legacy
---

# CLEW-069 — Local daemon and API server

## Objective

Move direct CLI orchestration behind an explicit single-user local daemon without changing existing Task semantics.

## User outcome

A developer explicitly starts Clew once, then CLI and Web clients can inspect and control durable Tasks through authenticated local APIs while one process safely owns scheduling.

## Context

Today each CLI invocation opens SQLite and may instantiate Scheduler directly. A UI and live Thread require a long-running owner, event streaming, and clear process lifecycle.

## Scope

- `clew daemon start`, `status`, and `stop`;
- loopback-only HTTP and WebSocket server on `127.0.0.1`;
- generated bearer token stored outside committed project config with restrictive permissions;
- exclusive lock per Clew state directory;
- one in-process local Runner and Scheduler owner;
- `/api/v1` handlers for existing task, plan, approval, run, result, usage, worktree, telemetry-status, and operator commands;
- API-backed CLI client with explicit daemon-unavailable and version-mismatch errors;
- monotonic event streaming and reconnect replay according to `CLEW-068`;
- graceful shutdown, interruption handoff, and restart reconciliation;
- static-asset serving hook for the future UI build;
- compatibility path for initialization and migration from direct CLI state.

## Out of scope

- automatically starting the daemon from arbitrary CLI commands;
- non-loopback listeners;
- Docker and remote Runner transport;
- Task Thread projection logic;
- React UI implementation;
- terminal launching.

## Deliverables

- daemon runtime and command group;
- authenticated HTTP/WebSocket server;
- API client used by CLI commands;
- exclusive-owner lock and lifecycle metadata;
- integration fixtures and operational documentation.

## Acceptance criteria

1. Daemon starts only through an explicit command and reports endpoint, version, and state directory.
2. A second daemon cannot own the same state directory.
3. Non-loopback binding and unauthenticated requests are rejected.
4. Existing CLI lifecycle operations work through the API.
5. WebSocket reconnect resumes from a persisted/validated cursor without silent gaps.
6. Restart does not duplicate a Run, native session, or turn.
7. Shutdown leaves SQLite consistent and reports interrupted active work truthfully.
8. No remote service or account is required.

## Verification

- unit tests for auth, lock, lifecycle, version negotiation, and cursor handling;
- API contract tests against `CLEW-068` fixtures;
- Quick/Standard/Deep acceptance through API-backed CLI;
- daemon crash/restart and duplicate-start matrix;
- loopback and unauthorized-request negative tests.

## Dependencies and parallelization

Depends only on `CLEW-068`. Runs in parallel with `CLEW-070`–`073`.

Primary ownership: daemon/server transport, CLI API client, process lifecycle. Consume Thread/session/continuation contracts without implementing those domains.

## Risks

- CLI commands currently mix parsing, persistence, and orchestration and may need careful extraction;
- lock behavior differs across operating systems;
- bearer-token delivery to browser clients must avoid URL/log leakage;
- graceful shutdown must not hang on native harness processes.

## Blockers

None.

## Completion record

- Implementation: authenticated loopback daemon, exclusive state-directory lock, restrictive token/metadata files, HTTP command/query endpoint, WebSocket cursor replay, static asset hook, explicit CLI daemon lifecycle, and API client command.
- Verification: daemon/control-plane/store integration tests passed with loopback enabled; full suite passed with 86 tests and 2 environment skips on 2026-08-28.
- Compatibility: existing CLI commands remain available through `clew api ...`; no automatic daemon startup, remote service, or account dependency was added.
