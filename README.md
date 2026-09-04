# Clew

Clew is a local, task-centric control plane for AI-assisted development. It keeps a durable task thread across native coding harnesses, isolated Git worktrees, verification, independent review, retries, Deep execution plans, and human approvals.

This repository contains the `v0.8.0` implementation. For a detailed Russian-language usage guide and concrete cases, see [`DONE.md`](./DONE.md). Agent changes are reviewed from the task header and transferred manually as described in [`docs/GIT-WORKFLOW.md`](./docs/GIT-WORKFLOW.md).

## Requirements

- macOS or Linux;
- Node.js 22.5 or newer (Clew uses the built-in `node:sqlite` module);
- Git 2.30 or newer;
- for native flows: Codex CLI `0.148.0` and/or OpenCode CLI/server `1.18.23`.

Windows has not been validated for v0.1.

## Clean install and quality gate

```sh
git clone https://github.com/IgorJin/Clew.git
cd Clew
npm ci
npm run check
node bin/clew.js --help
```

`npm run check` runs Prettier, ESLint, the UI build/tests, the backend suite, task-card validation, and syntax checks. Runtime dependencies provide WebSocket transport, structured logging, and the managed terminal; ESLint and Prettier are development-only dependencies.

## Quick start without external credentials

Run this inside a Git repository that has at least one commit:

```sh
node /path/to/Clew/bin/clew.js init
node /path/to/Clew/bin/clew.js task create \
  --id DEMO-1 \
  --title "First Clew task" \
  --goal "Prove task-centric execution" \
  --accept "the fixture verification passes" \
  --profile quick
node /path/to/Clew/bin/clew.js run DEMO-1 --harness fake
node /path/to/Clew/bin/clew.js status DEMO-1
node /path/to/Clew/bin/clew.js events DEMO-1
```

State is stored in `.clew/clew.sqlite`; owned worktrees are stored under `.clew/worktrees/`. The fake harness is deterministic and requires no account.

The product profiles default to native Codex as specified; `--harness fake` is an explicit deterministic test/demo route.

## Native harnesses

Diagnose the exact supported boundary before running it:

```sh
node bin/clew.js doctor --harness codex
node bin/clew.js doctor --harness opencode
```

Then select the adapter explicitly:

```sh
node bin/clew.js run DEMO-1 --harness codex
node bin/clew.js run DEMO-1 --harness opencode
```

OpenCode requires a running server, normally `opencode serve --hostname 127.0.0.1 --port 4096`. Codex uses `codex app-server` over JSON-RPC stdio. Native completion alone is insufficient for `READY`: Clew requires at least one passing command evidence item.

## Standard and Deep flows

Standard adds structured review and bounded retry. Blocking findings are added to the worker prompt; the first retry resumes its native session and a repeated failure starts fresh.

Deep adds a schema-valid DAG, approval gate, bounded parallel worktrees, deterministic commit integration, optional per-stage harness routing, broad verification, review, and restart recovery:

```sh
node bin/clew.js run DEMO-DEEP --profile deep --harness fake --architect fake
node bin/clew.js plan DEMO-DEEP
node bin/clew.js approve DEMO-DEEP --actor your-name
node bin/clew.js run DEMO-DEEP --profile deep --harness fake
```

## Controller and Runner

v0.6 can keep Controller/UI on one host and execute leased stages on one configured Runner host. Local execution remains the default. Put the shared credential in environment variables or restrictive `0600` files, and define the Runner's logical workspace mappings only in the user config on the Runner host.

```json
{
  "controllerRunner": {
    "runnerId": "runner-1",
    "credentialFile": "/secure/controller-runner.token"
  },
  "runner": {
    "id": "runner-1",
    "controllerUrl": "wss://controller.example/runner/v1",
    "credentialFile": "/secure/controller-runner.token",
    "stateDir": "/var/lib/clew-runner",
    "workspaces": {
      "clew": "/absolute/path/to/Clew"
    }
  }
}
```

Start `clew daemon start` on Controller and `clew runner serve` on the execution host, then use `clew run TASK --execution paired`. `ws://` is accepted only on loopback; remote endpoints require `wss://`. v0.6 supports one preconfigured Runner, no automatic failover, and no Docker/pairing workflow. Accepted work becomes `RECOVERING` after ambiguous loss and is never silently duplicated. Terminal ownership stays on the Runner host, and the Controller UI labels it instead of proxying PTY bytes.

Release packages are attached to GitHub Releases. The public npm name `clew` belongs to an unrelated project, so this repository does not publish to that namespace.

## Operations

```sh
node bin/clew.js status DEMO-1 --watch
node bin/clew.js interrupt DEMO-1 --actor your-name
node bin/clew.js task result DEMO-1
node bin/clew.js task history DEMO-1 --stage worker --attempt 1
node bin/clew.js retry DEMO-1 worker --actor your-name --reason "rerun after inspection"
node bin/clew.js verify DEMO-1 --revision <worker-sha> --actor your-name
node bin/clew.js task result DEMO-1 --human
node bin/clew.js task usage DEMO-1 --human
node bin/clew.js pricing sync --url https://pricing.example/catalog.json --source provider-catalog
node bin/clew.js complete DEMO-1 --revision <worker-sha> --actor your-name
node bin/clew.js export DEMO-1 --dir /tmp/clew-export
node bin/clew.js cleanup --retention-days 7
node bin/clew.js telemetry install
node bin/clew.js daemon start
node bin/clew.js api task list
CLEW_TELEMETRY_ENABLED=true node bin/clew.js telemetry status
node bin/clew.js worktree list
node bin/clew.js worktree prune
```

`worktree prune` removes only clean, inactive, Clew-owned worktrees. Dirty and active worktrees are retained for inspection.

Use `task open-changes TASK` to inspect a task workspace. The viewer priority is an explicit `--viewer cursor|vscode` (or `changeViewer` configuration), Cursor, then VS Code; pass `--run RUN-ID` to select a persisted run. Copying the path is an explicit action via `--viewer worktree-path` and is never used as an automatic fallback.

`task result` and `task history` expose the persisted result without direct SQLite access. `retry` records an auditable operator action and enforces the resolved attempt policy. `verify` records a new verification report against an explicitly pinned known revision without creating an implementation run.

Each completed native turn records reported token usage when the harness exposes it. `task usage` aggregates the complete task lifecycle, including retries and Deep stages. Missing provider data remains `unknown` or `partial`; Clew never estimates tokens or silently treats them as zero. Pricing is synced by an external cron via configured JSON endpoints (`pricing.sources`) or an explicit `--url`; every successful sync is an immutable catalog snapshot.

Telemetry is optional and disabled by default. `telemetry install` installs the official OpenTelemetry trace runtime under `.clew/telemetry`; enable it with `CLEW_TELEMETRY_ENABLED=true` or project configuration, then point the official OTLP exporter at Phoenix or another collector with `OTEL_EXPORTER_OTLP_ENDPOINT`. Collector failures are reported as diagnostics and never change task state.

The local daemon is explicit and loopback-only. `clew daemon start` launches it in the background on `127.0.0.1:43176` by default and reports the UI URL and log path. Inspect its live health with `clew daemon status`, stop it with `clew daemon stop`, and use `clew api ...` to send authenticated commands through its API. CLI and API commands share one in-process `ClewService`; the daemon does not spawn a nested CLI per request. Use `clew daemon logs --follow` to stream structured JSON lifecycle records, or `clew daemon logs --lines 200` to read recent records. `daemon.log` contains safe server, WebSocket, and command metadata; `daemon.stderr.log` retains process stderr for diagnosis. Use `clew daemon serve --port PORT` only when a foreground process is useful for debugging. Startup detects and replaces stale ownership files left by an abrupt process exit. The daemon stores its bearer token, ownership metadata, and logs under `.clew` with restrictive permissions; it never starts automatically.

For daemon-run Codex tasks, the embedded Codex TUI is the worker from the first turn: the browser automatically opens xterm, and terminal input, questions, and Codex approval prompts remain interactive throughout execution. Clew does not start a competing headless writer. Select `Finish worker` (or run `clew finish-worker TASK`) when the interactive work is ready for Clew verification; Clew stops the TUI, reads the persisted thread through a separate read-only App Server, and then verifies the workspace. Hiding the terminal only closes the browser view; it does not stop the worker. To reopen a completed persisted session, use `clew session open TASK --stage worker --role worker --harness codex`. Set `CLEW_CODEX_OPEN_DESKTOP=true` to additionally open the worker worktree in Codex Desktop; the embedded CLI terminal is always created, independently of this flag. Use `--surface none` for capability/diagnostic checks. Unsupported, starting, or stale sessions return structured `unavailable` results.

Configuration precedence is command flag → environment → project `.clew.json` → user config → defaults. See [`docs/COMPATIBILITY.md`](./docs/COMPATIBILITY.md) and [`DONE.md`](./DONE.md) for keys and examples.

Role-specific models can be selected with `models.worker`, `models.architect`, `models.reviewer`, and `models.qa` in `.clew.json` or with the corresponding `CLEW_*_MODEL` environment variables. Every run also receives a deterministic collision-resistant runtime namespace, persisted in its run history. Ports, databases, and containers remain caller-managed.

## Release evidence

- [`spec.md`](./spec.md) — product and technical contract;
- [`VISION.md`](./VISION.md) — long-term product direction and target architecture;
- [`ROADMAP.md`](./ROADMAP.md) — release outcomes and planned work packages;
- [`tasks.md`](./tasks.md) — implementation record and current backlog;
- [`tasks/`](./tasks/) — detailed active/planned task cards and canonical status fields;
- [`docs/ACCEPTANCE.md`](./docs/ACCEPTANCE.md) — mapping of all ten acceptance criteria;
- [`RELEASE.md`](./RELEASE.md) — release gate and live-signoff record;
- [`RELEASE-0.2.md`](./RELEASE-0.2.md) — v0.2 scope and release gates;
- [`RELEASE-0.3.md`](./RELEASE-0.3.md) — planned observability and execution-economics release;
- [`RELEASE-0.5.md`](./RELEASE-0.5.md) — interactive terminal and worker lifecycle release;
- [`RELEASE-0.6.md`](./RELEASE-0.6.md) — Controller/Runner transport, leases, and release evidence;
- [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md) — operational diagnostics.

## Intentional limits

Clew has no multi-Runner scheduler, automatic failover, PR/merge automation, or automatic merge-conflict resolution. Runtime namespaces are identifiers and coordination metadata; Clew does not provision ports, databases, or containers. Node's built-in SQLite API is still marked experimental by Node.js.

Clew does not implement a model loop: native harnesses own coding intelligence and tools; Clew owns the durable task lifecycle above them.
