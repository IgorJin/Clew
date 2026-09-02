# Clew task cards

This directory is the operational source of truth for active and planned task status. [`../tasks.md`](../tasks.md) remains the historical completion ledger and compact backlog; [`../ROADMAP.md`](../ROADMAP.md) defines release outcomes and dependency order.

## Status workflow

Allowed `status` values:

| Status        | Meaning                                                                |
| ------------- | ---------------------------------------------------------------------- |
| `planned`     | Accepted into a future release, but not currently runnable             |
| `ready`       | All dependencies are done and work may start                           |
| `in_progress` | Work is actively being implemented                                     |
| `in_review`   | Implementation exists; acceptance evidence is under independent review |
| `blocked`     | Work started or was ready, but a concrete blocker prevents progress    |
| `done`        | Acceptance criteria and required verification are complete on `main`   |
| `cancelled`   | Work was intentionally dropped                                         |
| `superseded`  | Another task replaced this task; the replacement must be recorded      |

`blocked` is not a synonym for “has dependencies.” Future work remains `planned` until it becomes the selected runnable task. Every blocked task must explain the blocker under **Blockers**.

## Required frontmatter

Every task file uses the following fields:

```yaml
---
id: CLEW-000
title: Short title
status: planned
release: v0.x
priority: P0
size: M
depends_on: []
parallel_group: null
owner: null
updated: YYYY-MM-DD
evidence_policy: v1
---
```

`status` and `updated` are updated whenever work changes state. `owner` may remain `null` until someone takes the task. New cards use `evidence_policy: v1`; `legacy` is accepted only for the explicitly grandfathered cards that predate this gate. A task becomes `done` only after every acceptance criterion has mapped evidence, the independent review verdict is `pass`, required verification succeeds, and the result is on `main`.

## Evidence policy v1

Each acceptance criterion must map to automated evidence and the logical scenarios it covers. Stateful work must explicitly consider state transitions, human overrides, terminal states, every affected profile, fallback behavior, duplicate requests, and restarts at durable boundaries. A green general test suite does not replace criterion-specific evidence.

Human-authorized transitions are valid product behavior when the card calls for them. Their tests must prove attribution, audit data, preserved unresolved findings, and terminal-state behavior after the decision.

## Current index

| Task                      | Release | Status    | Depends on    | Parallel group     |
| ------------------------- | ------- | --------- | ------------- | ------------------ |
| [CLEW-042](./CLEW-042.md) | v0.3    | done      | —             | —                  |
| [CLEW-043](./CLEW-043.md) | v0.3    | done      | CLEW-042      | —                  |
| [CLEW-067](./CLEW-067.md) | v0.3    | ready     | 042, 043      | —                  |
| [CLEW-068](./CLEW-068.md) | v0.4    | done      | 067           | —                  |
| [CLEW-069](./CLEW-069.md) | v0.4    | done      | 068           | v0.4-control-plane |
| [CLEW-070](./CLEW-070.md) | v0.4    | done      | 068           | v0.4-control-plane |
| [CLEW-071](./CLEW-071.md) | v0.4    | ready     | 068           | v0.4-control-plane |
| [CLEW-072](./CLEW-072.md) | v0.4    | ready     | 068           | v0.4-control-plane |
| [CLEW-073](./CLEW-073.md) | v0.4    | in_review | 068           | v0.4-control-plane |
| [CLEW-074](./CLEW-074.md) | v0.4    | planned   | 069–073       | —                  |
| [CLEW-075](./CLEW-075.md) | v0.6    | planned   | 074           | —                  |
| [CLEW-076](./CLEW-076.md) | v0.6    | planned   | 075           | —                  |
| [CLEW-077](./CLEW-077.md) | v0.5    | done      | 078, 079      | —                  |
| [CLEW-078](./CLEW-078.md) | v0.5    | done      | 068, 069, 072 | —                  |
| [CLEW-079](./CLEW-079.md) | v0.5    | done      | 078           | —                  |

## Execution waves

```text
Wave 0: CLEW-067
Wave 1: CLEW-068
Wave 2: CLEW-069 + 070 + 071 + 072 + 073
Wave 3: CLEW-074
Wave 4: CLEW-075
Wave 5: CLEW-076
Interactive response slice: CLEW-078 → CLEW-079 → CLEW-077 acceptance
```

The Wave 2 tasks deliberately own separate primary areas to reduce merge conflicts. Their shared contracts and fixtures must land in `CLEW-068` first.

## Updating a task

1. Confirm every `depends_on` task is `done` before setting `ready`.
2. Set `owner`, `status: in_progress`, and `updated` when implementation begins.
3. Record unexpected blockers under **Blockers** before setting `blocked`.
4. Keep decisions and scope changes in the card rather than only in chat history.
5. Move completed implementation to `in_review` and run an independent counterexample-oriented review.
6. Before `done`, resolve every review finding, replace pending evidence with passing evidence, execute the verification section, and record merge/release evidence under **Completion record**.

New cards should start from [`TEMPLATE.md`](./TEMPLATE.md).
