# Changelog

## 0.1.0-alpha.1 — initial product slice

- Added a runnable Node.js CLI with `init`, task creation/list/show, `run`, `status`, `events`, and `doctor` commands.
- Added validated task contracts, profile resolution, SQLite persistence, stage/run records, and append-only task events.
- Added explicit task and stage state transitions, including the distinction between harness completion and task readiness.
- Added native Git worktree allocation and revision tracking.
- Added machine-facing Codex app-server and OpenCode HTTP adapter boundaries with normalized lifecycle events.
- Added a deterministic fake harness and tests for the first Quick flow.
- Added a deterministic fake reviewer and Standard-flow review decision path.
- Documented the v0.1 release gates and implementation backlog.

Known limitations:

- Codex and OpenCode production protocol adapters are not yet enabled by default.
- Standard review/retry and Deep parallel integration are still under implementation.
- Worktrees are retained for inspection; cleanup policy is not automatic yet.
- Node's built-in SQLite API is experimental in the supported runtime.
