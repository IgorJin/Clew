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

## The Web UI reports that the daemon is disconnected

Run `clew daemon status`. Status performs an authenticated health check; `stale` means the previous process exited without cleanup, while `unreachable` means the recorded PID is still alive and ownership is deliberately preserved. `clew daemon start` safely replaces only stale daemon ownership and starts a background process on the stable default port `43176`. Inspect recent structured activity with `clew daemon logs --lines 200`, or follow it live with `clew daemon logs --follow`. `.clew/daemon.log` contains safe JSON records for lifecycle, HTTP, WebSocket, and command events; `.clew/daemon.stderr.log` contains process stderr. The UI reconnects and refreshes automatically after the daemon returns; operator actions stay disabled while only last-known data is available.

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
