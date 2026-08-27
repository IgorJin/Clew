# Clew

Clew is a local, task-centric control plane for AI-assisted development. It keeps the thread across task contracts, native coding harnesses, Git worktrees, verification, review, retries, and human approvals.

For a human-oriented guide with concrete use cases and current limitations, see [`DONE.md`](./DONE.md).

Clew v0.1 starts with a deterministic local engine and a Quick vertical slice. The `fake` harness is included so the product can be exercised without external credentials; Codex and OpenCode adapters are isolated behind the same interface and are enabled as their machine-facing protocols are configured.

## Requirements

- Node.js 22.5 or newer (uses the built-in `node:sqlite` module)
- Git 2.30 or newer

## Quick start

```sh
npm test
node bin/clew.js init
node bin/clew.js task create \
  --id DEMO-1 \
  --title "First Clew task" \
  --goal "Prove task-centric execution" \
  --accept "the fixture verification passes" \
  --profile quick
node bin/clew.js run DEMO-1 --harness fake
node bin/clew.js status DEMO-1
node bin/clew.js events DEMO-1
```

Task state is stored in `.clew/clew.sqlite`; owned worktrees are stored in `.clew/worktrees/`. Both are ignored by Git.

Contracts can also be supplied as JSON:

```sh
node bin/clew.js task create --file task.json
```

## Current release boundary

Implemented in the first product slice:

- validated task contracts and Quick/Standard/Deep profile names;
- SQLite persistence for tasks, stages, runs, and immutable events;
- state transitions and truthful `HARNESS_COMPLETED` vs task `READY` semantics;
- local Git worktree allocation and revision evidence;
- deterministic fake harness for end-to-end testing;
- deterministic fake reviewer for Standard-flow testing;
- concurrent Deep worker stages with commit capture, dependency-gated cherry-pick integration, conflict diagnostics, and review;
- CLI task lifecycle, JSON output, status, events, and diagnostics.

The remaining v0.1 candidate work is tracked in [`tasks.md`](./tasks.md) and gated in [`RELEASE.md`](./RELEASE.md), including production Codex/OpenCode protocol adapters, arbitrary DAG scheduling and recovery, human-assisted conflict resolution, and hardening.

## Design boundary

Clew does not implement a coding-agent loop. Native harnesses own tools, context, shell/browser behavior, sandboxing, and approvals. Clew owns the task lifecycle above them.
