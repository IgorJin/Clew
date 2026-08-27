# Changelog

## 0.1.0-rc.1 — complete v0.1 release candidate

- Added versioned task/profile/plan/review/verification/event schemas, fixtures, runtime validation, and seven transactional SQLite migrations.
- Added deterministic Quick, Standard, and Deep acceptance flows with isolated worktrees, passing-evidence completion policy, structured review, bounded retries, human approvals, and auditable events.
- Added native Codex app-server lifecycle, command evidence extraction, thread/turn persistence, approvals, interrupt, timeout, and session resume. A real Codex `0.148.0` smoke reached `READY` while leaving the primary checkout untouched.
- Added OpenCode `1.18.23` HTTP/SSE lifecycle with session correlation, tool evidence, permissions, abort, resume, completion and provider-failure diagnostics. Live transport/session/SSE/failure behavior was verified against a local server.
- Added Deep DAG execution with bounded concurrency, per-stage harness routing, routed timeout retry, transitive commit integration, explicit conflicts, integration verification, final review, and restart reconciliation.
- Added review feedback delivery to the resumed worker session. The first retry reuses context; repeated timeout/review failures start a fresh session.
- Added exact adapter version/auth/health diagnostics, config precedence and command overrides, secret rejection/redaction, safe IDs/refs/paths, unique run-attempt enforcement, and projection rebuilding from the event log.
- Added `status --watch`, SIGINT/SIGTERM propagation, persisted cross-process interrupt requests, worktree list/remove/prune, and active/dirty worktree protection.
- Added reproducible live-adapter smoke scripts, a ten-criterion acceptance matrix, compatibility and troubleshooting guides, and clean-install instructions.

Known limitations:

- OpenCode successful model execution depends on the provider configured inside OpenCode. The release-signoff server's `omlx` provider was unreachable; Clew correctly recorded the streamed retries and external failure instead of reporting `READY`.
- Clew resumes a native session/thread with a new tracked turn; it does not continue midway through an interrupted turn.
- Merge conflicts require manual resolution; Clew never applies a destructive automatic fallback.
- Runtime namespaces for ports, databases, queues, and containers are not isolated.
- Node's built-in SQLite API is experimental in the supported runtime.
- Dashboard, telemetry/cost aggregation, PR automation, and remote scheduling are post-v0.1 work.

## 0.1.0-alpha.3 — execution and review iteration

- Added deterministic fake review, bounded retries, Deep DAG execution, plan approvals, commit integration, conflict diagnostics, restart recovery, native adapter conformance tests, interrupts, native IDs, and approval gates.
- Added strict Git/worktree boundaries, persisted event redaction, migrations, lint/format gates, and clean-checkout acceptance fixtures.

## 0.1.0-alpha.1 — initial product slice

- Added a runnable Node.js CLI with task CRUD, `run`, `status`, `events`, and `doctor`.
- Added validated task contracts, profile resolution, SQLite persistence, stage/run records, append-only task events, Git worktree allocation, and the deterministic Quick fake flow.
