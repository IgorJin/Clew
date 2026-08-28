# Troubleshooting

## `doctor` reports an incompatible version

Install the versions in `docs/COMPATIBILITY.md` or deliberately update the compatibility constants and conformance evidence together.

## Codex app-server exits before initialize

Run `codex login status` and verify that Codex can read and write its own state directory. Clew reports the app-server exit without converting it into a successful task.

## OpenCode endpoint is unreachable

Start `opencode serve`, set `CLEW_OPENCODE_URL`, and rerun `clew doctor --harness opencode`.

If `doctor` passes but a run emits `session.status` retries such as “Cannot connect to provider API”, the HTTP/SSE adapter is healthy and OpenCode's selected model provider is unavailable. Repair that provider in OpenCode, then rerun `npm run smoke:opencode`. Clew classifies the result as `external_unavailable` and does not mark the task `READY`.

## Harness completed without verification evidence

Clew intentionally fails the run. A native worker must execute at least one command that verifies the acceptance criteria; successful tool completion becomes evidence linked to task, stage, run, attempt, workspace, revision and acceptance IDs.

## A task was interrupted by a process crash

Run the same task again. Clew marks abandoned `RUNNING` records as `INTERRUPTED`, transitions through `RECOVERING`, and resumes a persisted native session when available.

## Worktrees remain after execution

Clew uses a retention policy so results stay inspectable. List and safely prune them with:

```sh
node bin/clew.js worktree list
node bin/clew.js worktree prune
```

Prune skips active and dirty worktrees. Explicit removal of a dirty worktree requires `worktree remove PATH --force`.

## Telemetry is unavailable

Telemetry is optional. Run `node bin/clew.js telemetry install`, set `CLEW_TELEMETRY_ENABLED=true`, and configure `OTEL_EXPORTER_OTLP_ENDPOINT` when an OTLP collector is available. A missing or unavailable collector does not block task execution; inspect `node bin/clew.js telemetry status` and `node bin/clew.js doctor` for the local state.

## Usage or cost is unknown

Run `node bin/clew.js task usage TASK --human`. Unknown usage means the native harness did not report token counters; partial means only some counters were reported. Configure a provider catalog and run `node bin/clew.js pricing sync`, preferably from an external daily cron. Historical snapshots are retained, so a later price change does not rewrite an already calculated lifecycle total.
