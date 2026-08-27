# Changelog

## 0.1.0-alpha.1 — initial product slice

- Added a runnable Node.js CLI with `init`, task creation/list/show, `run`, `status`, `events`, and `doctor` commands.
- Added validated task contracts, profile resolution, SQLite persistence, stage/run records, and append-only task events.
- Added explicit task and stage state transitions, including the distinction between harness completion and task readiness.
- Added native Git worktree allocation and revision tracking.
- Added machine-facing Codex app-server and OpenCode HTTP adapter boundaries with normalized lifecycle events.
- Added a deterministic fake harness and tests for the first Quick flow.
- Added a deterministic fake reviewer and Standard-flow review decision path.
- Added bounded automatic retries after blocking review findings, with per-attempt workspaces and retry events.
- Added validated Deep plan execution with backend/frontend worker stages, integration stage, and final review.
- Added an optional native Codex reviewer route with read-only/output-schema options and a separate `--review-harness` CLI flag.
- Documented the v0.1 release gates and implementation backlog.

Known limitations:

- Codex and OpenCode production protocol adapters are not yet enabled by default.
- Native reviewer/retry and Deep parallel integration are still under implementation; fake review/retry is available for deterministic tests.
- Worktrees are retained for inspection; cleanup policy is not automatic yet.
- Node's built-in SQLite API is experimental in the supported runtime.
