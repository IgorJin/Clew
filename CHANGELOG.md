# Changelog

## Unreleased

No changes yet.

## 0.6.0

- Added protocol-v1 contracts for one authenticated Controller/Runner connection with bounded envelopes, compatibility negotiation, TLS enforcement, idempotency, and lease epoch fencing.
- Added the foreground Runner service, stable identity, standalone configuration, local process ownership, durable outbox/inbound ledger, reconnect, heartbeat, cancellation, and safe diagnostics.
- Added the Controller Runner gateway, durable lease/command/result migration, health projection, restart reconciliation, and explicit ambiguous-loss recovery.
- Added Scheduler `--execution paired` support with Standard review/retry and Deep Runner-side planning, approval-gated DAG execution, isolated Runner worktrees, dependency integration, and final review while preserving local execution as the default.
- Kept native credentials, repository paths, raw output, and terminal bytes on the Runner host; remote terminal streaming remains out of scope.
- Added populated v0.5 migration coverage, product-version fencing, heartbeat recovery, dropped/reordered/replayed-frame coverage, separate-process installed acceptance, and a passing live Codex Runner smoke.

## 0.5.0

The headline feature of this release is an interactive terminal for native Codex workers.

- Added an embedded terminal that keeps the Codex TUI operator-owned from the first worker turn.
- Added read-only native turn monitoring: Clew detects running and completed turns without creating a competing writer.
- Completed worker responses now appear once in Task Thread with bounded, redacted content and native causal identity.
- Added the live `waiting_for_operator` state, follow-up interaction, terminal focus, and explicit `Finish worker` handoff to verification.
- Preserved the local daemon/API, reconnectable event stream, Task Thread projection, continuation flow, and packaged Preact UI introduced in the control-plane work.
- Added terminal lifecycle, restart, reconnect, duplicate-suppression, redaction, and UI regression coverage.

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
