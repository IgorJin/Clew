# Clew

Clew is a local, task-centric control plane for AI-assisted development. It keeps a durable task thread across native coding harnesses, isolated Git worktrees, verification, independent review, retries, Deep execution plans, and human approvals.

This repository contains the `v0.1.0-rc.1` implementation. For a detailed Russian-language usage guide and concrete cases, see [`DONE.md`](./DONE.md).

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
node bin/clew.js worktree list
node bin/clew.js worktree prune
```

`worktree prune` removes only clean, inactive, Clew-owned worktrees. Dirty and active worktrees are retained for inspection.

Configuration precedence is command flag → environment → project `.clew.json` → user config → defaults. See [`docs/COMPATIBILITY.md`](./docs/COMPATIBILITY.md) and [`DONE.md`](./DONE.md) for keys and examples.

## Release evidence

- [`spec.md`](./spec.md) — product and technical contract;
- [`tasks.md`](./tasks.md) — implementation record and post-v0.1 backlog;
- [`docs/ACCEPTANCE.md`](./docs/ACCEPTANCE.md) — mapping of all ten acceptance criteria;
- [`RELEASE.md`](./RELEASE.md) — release gate and live-signoff record;
- [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md) — operational diagnostics.

## Intentional v0.1 limits

Clew has no dashboard, remote scheduler, PR/merge automation, runtime namespace isolation for ports/databases/containers, or automatic merge-conflict resolution. Node's built-in SQLite API is still marked experimental by Node.js. These are explicit post-v0.1 boundaries, not hidden dependencies.

Clew does not implement a model loop: native harnesses own coding intelligence and tools; Clew owns the durable task lifecycle above them.
