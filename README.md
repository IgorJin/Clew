# Clew

Clew is a local, task-centric control plane for AI-assisted development. It keeps a durable task thread across native coding harnesses, isolated Git worktrees, verification, independent review, retries, Deep execution plans, and human approvals.

This repository contains the `v0.2.0` implementation. For a detailed Russian-language usage guide and concrete cases, see [`DONE.md`](./DONE.md).

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

`npm run check` runs Prettier, ESLint, the automated test suite, and syntax checks. Runtime dependencies are zero; ESLint and Prettier are development-only dependencies.

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

## Operations

```sh
node bin/clew.js status DEMO-1 --watch
node bin/clew.js interrupt DEMO-1 --actor your-name
node bin/clew.js task result DEMO-1
node bin/clew.js task history DEMO-1 --stage worker --attempt 1
node bin/clew.js retry DEMO-1 worker --actor your-name --reason "rerun after inspection"
node bin/clew.js verify DEMO-1 --revision <worker-sha> --actor your-name
node bin/clew.js task result DEMO-1 --human
node bin/clew.js complete DEMO-1 --revision <worker-sha> --actor your-name
node bin/clew.js export DEMO-1 --dir /tmp/clew-export
node bin/clew.js cleanup --retention-days 7
node bin/clew.js worktree list
node bin/clew.js worktree prune
```

`worktree prune` removes only clean, inactive, Clew-owned worktrees. Dirty and active worktrees are retained for inspection.

`task result` and `task history` expose the persisted result without direct SQLite access. `retry` records an auditable operator action and enforces the resolved attempt policy. `verify` records a new verification report against an explicitly pinned known revision without creating an implementation run.

Configuration precedence is command flag → environment → project `.clew.json` → user config → defaults. See [`docs/COMPATIBILITY.md`](./docs/COMPATIBILITY.md) and [`DONE.md`](./DONE.md) for keys and examples.

Role-specific models can be selected with `models.worker`, `models.architect`, `models.reviewer`, and `models.qa` in `.clew.json` or with the corresponding `CLEW_*_MODEL` environment variables. Every run also receives a deterministic collision-resistant runtime namespace, persisted in its run history. Ports, databases, and containers remain caller-managed.

## Release evidence

- [`spec.md`](./spec.md) — product and technical contract;
- [`tasks.md`](./tasks.md) — implementation record and current backlog;
- [`docs/ACCEPTANCE.md`](./docs/ACCEPTANCE.md) — mapping of all ten acceptance criteria;
- [`RELEASE.md`](./RELEASE.md) — release gate and live-signoff record;
- [`RELEASE-0.2.md`](./RELEASE-0.2.md) — v0.2 scope and release gates;
- [`RELEASE-0.3.md`](./RELEASE-0.3.md) — planned observability and execution-economics release;
- [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md) — operational diagnostics.

## Intentional limits

Clew has no dashboard, remote scheduler, PR/merge automation, or automatic merge-conflict resolution. Runtime namespaces are identifiers and coordination metadata; Clew does not provision ports, databases, or containers. Node's built-in SQLite API is still marked experimental by Node.js.

Clew does not implement a model loop: native harnesses own coding intelligence and tools; Clew owns the durable task lifecycle above them.
