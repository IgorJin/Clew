# Changelog

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
