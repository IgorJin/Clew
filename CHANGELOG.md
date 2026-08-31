# Changelog

## Unreleased

- Added the v0.4 local daemon/API foundation with authenticated loopback transport, exclusive state ownership, cursor-based event replay, explicit lifecycle commands, and API command forwarding.
- Reworked daemon lifecycle around a health-checked background process, stable default port, persistent logs, stale-lock recovery, and `SIGHUP` cleanup.
- Replaced the Web UI's per-task CLI subprocess fan-out with one in-process snapshot endpoint and coalesced event refreshes; disconnected views now retain clearly marked last-known data while disabling every operator action.
- Replaced the hand-written WebSocket framing with the maintained `ws` implementation, including large-payload replay, protocol validation, and ping/pong liveness checks.
- Added a shared in-process `ClewService` used by both CLI and daemon API commands; the daemon no longer spawns a nested CLI process for each UI action.

## 0.4.0

- Added the local control-plane Task Thread projection, bounded continuation/review handoff, native Session Surface, and installed Preact Web UI.
- Added v0.3-to-v0.4 migration coverage through schema version 15, daemon static asset serving with same-origin HttpOnly bootstrap, and full installed-package acceptance.
- Release verification is recorded in `RELEASE-0.4.md`; tagging and publication require an explicit operator action.

## 0.3.0

- Added optional OpenTelemetry trace export with persisted correlation, redaction, bounded failure handling, and disabled-by-default behavior.
- Added provider-reported usage normalization, idempotent lifecycle aggregation, immutable pricing provenance, and explicit unknown/partial cost states.
- Added v0.2 migration coverage for completion and evidence history plus a clean installed-package Quick, Standard, and Deep acceptance script.
- Documented v0.3 configuration, compatibility, troubleshooting, security boundaries, and release verification.

## 0.2.0

- Added deterministic runtime namespaces persisted per run.
- Added role-specific worker, architect, reviewer, and QA model configuration.
- Added pinned-result lifecycle acceptance for export, completion, and cleanup.
- Added runtime namespace schema migration and v0.2 release documentation.

## 0.1.0 — initial release

- Added versioned task/profile/plan/review/verification/event schemas, fixtures, runtime validation, and seven transactional SQLite migrations.
- Added deterministic Quick, Standard, and Deep acceptance flows with isolated worktrees, passing-evidence completion policy, structured review, bounded retries, human approvals, and auditable events.
- Added native Codex app-server lifecycle, command evidence extraction, thread/turn persistence, approvals, interrupt, timeout, and session resume. A real Codex `0.148.0` smoke reached `READY` while leaving the primary checkout untouched.
- Added OpenCode `1.18.23` HTTP/SSE lifecycle with session correlation, tool evidence, permissions, abort, resume, completion and provider-failure diagnostics. A real model turn reached `READY` with command evidence while leaving the primary checkout untouched.
- Added Deep DAG execution with bounded concurrency, per-stage harness routing, routed timeout retry, transitive commit integration, explicit conflicts, integration verification, final review, and restart reconciliation.
- Added review feedback delivery to the resumed worker session. The first retry reuses context; repeated timeout/review failures start a fresh session.
- Added exact adapter version/auth/health diagnostics, config precedence and command overrides, secret rejection/redaction, safe IDs/refs/paths, unique run-attempt enforcement, and projection rebuilding from the event log.
- Added `status --watch`, SIGINT/SIGTERM propagation, persisted cross-process interrupt requests, worktree list/remove/prune, and active/dirty worktree protection.
- Added reproducible live-adapter smoke scripts, a ten-criterion acceptance matrix, compatibility and troubleshooting guides, and clean-install instructions.

Known limitations:

- OpenCode successful model execution depends on a reachable provider configured inside OpenCode; provider outages are reported as external failures rather than `READY`.
- Clew resumes a native session/thread with a new tracked turn; it does not continue midway through an interrupted turn.
- Merge conflicts require manual resolution; Clew never applies a destructive automatic fallback.
- Runtime namespace identifiers are persisted per run; ports, databases, queues, and containers remain caller-managed.
- Node's built-in SQLite API is experimental in the supported runtime.
- Dashboard, telemetry/cost aggregation, PR automation, and remote scheduling are post-v0.1 work.

## 0.1.0-alpha.3 — execution and review iteration

- Added deterministic fake review, bounded retries, Deep DAG execution, plan approvals, commit integration, conflict diagnostics, restart recovery, native adapter conformance tests, interrupts, native IDs, and approval gates.
- Added strict Git/worktree boundaries, persisted event redaction, migrations, lint/format gates, and clean-checkout acceptance fixtures.

## 0.1.0-alpha.1 — initial product slice

- Added a runnable Node.js CLI with task CRUD, `run`, `status`, `events`, and `doctor`.
- Added validated task contracts, profile resolution, SQLite persistence, stage/run records, append-only task events, Git worktree allocation, and the deterministic Quick fake flow.
