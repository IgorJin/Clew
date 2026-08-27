# Changelog

## 0.1.0-alpha.3 — execution and review iteration

- Added `clew interrupt ID` and Ctrl-C propagation through scheduler and harnesses; interrupted tasks become `CANCELLED` with an auditable `INTERRUPTED` run.
- Added persisted interrupt requests so a second CLI process can safely signal an active scheduler.
- Added Codex thread resume during Deep recovery: persisted native session IDs are reused through `thread/resume` before a new turn starts.
- Added a deterministic fake reviewer and Standard-flow review decision path.
- Added bounded automatic retries after blocking review findings, with per-attempt workspaces and retry events.
- Added validated Deep plan execution with backend/frontend worker stages, integration stage, and final review.
- Added concurrent execution for independent Deep stages, dependency-gated integration, and explicit blocked/failed states.
- Added a general local DAG executor that starts stages only after successful dependencies, enforces the profile concurrency limit, and propagates blocked states.
- Added deterministic transitive commit integration so downstream stages receive the complete output of their ancestor stages.
- Added versioned persisted Deep plans and restart reconciliation that reuses completed stages, interrupts abandoned runs, and resumes unfinished DAG work.
- Added fake and native read-only Codex architect routes with schema-constrained plan output.
- Added transactional, audited Deep plan approval/rejection and `plan`, `approve`, and `reject` CLI commands; no worktree is allocated before approval.
- Added Git commit capture for worker outputs and deterministic cherry-pick integration into a dedicated integration worktree.
- Added explicit integration-conflict diagnostics with a safe cherry-pick abort and inspectable failed state.
- Added an optional native Codex reviewer route with read-only/output-schema options and a separate `--review-harness` CLI flag.
- Added a shared harness conformance suite covering correlated lifecycle events, native identity, approval decisions, interruption, and timeout behavior for Fake, Codex, and OpenCode adapters.
- Updated the Codex adapter to persist native thread/turn IDs, route server approval requests through an explicit callback, and interrupt active turns through the official `turn/interrupt` protocol.
- Added persisted native harness approval gates with auditable decisions and `approve-run`/`reject-run` CLI commands for a second operator process.
- Added explicit failure classes to run events and bounded retries for timed-out worker attempts.

## 0.1.0-alpha.1 — initial product slice

- Added a runnable Node.js CLI with `init`, task creation/list/show, `run`, `status`, `events`, and `doctor` commands.
- Added validated task contracts, profile resolution, SQLite persistence, stage/run records, and append-only task events.
- Added explicit task and stage state transitions, including the distinction between harness completion and task readiness.
- Added native Git worktree allocation and revision tracking.
- Added a deterministic fake harness and tests for the first Quick flow.
- Documented the v0.1 release gates and implementation backlog.

The Codex app-server and OpenCode adapter boundaries were introduced during the alpha execution iterations and remain experimental.

Known limitations:

- Codex and OpenCode adapters are experimental: their normalized lifecycle is fixture-tested, while live version compatibility, Codex reconnect, and OpenCode SSE consumption still require validation.
- Native reviewer/retry is not production-ready; fake review/retry is available for deterministic tests.
- Arbitrary validated DAG execution, plan approval, and local restart recovery are implemented; native Codex architect compatibility and live OpenCode reconnect still need validation, while automatic conflict resolution is not implemented.
- Worktrees are retained for inspection; cleanup policy is not automatic yet.
- Node's built-in SQLite API is experimental in the supported runtime.
