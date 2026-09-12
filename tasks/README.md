# Clew task cards

This directory is the operational source of truth for active and planned task status. Completed cards live in [`done/`](./done/). [`../tasks.md`](../tasks.md) remains the historical completion ledger and compact backlog; [`../ROADMAP.md`](../ROADMAP.md) defines release outcomes and dependency order.

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

| Task                                                          | Release    | Status     | Depends on                   | Parallel group      |
| ------------------------------------------------------------- | ---------- | ---------- | ---------------------------- | ------------------- |
| [CLEW-042](./done/CLEW-042.md)                                | v0.3       | done       | —                            | —                   |
| [CLEW-043](./done/CLEW-043.md)                                | v0.3       | done       | CLEW-042                     | —                   |
| [CLEW-067](./done/CLEW-067.md)                                | v0.3       | done       | 042, 043                     | —                   |
| [CLEW-068](./done/CLEW-068.md)                                | v0.4       | done       | 067                          | —                   |
| [CLEW-069](./done/CLEW-069.md)                                | v0.4       | done       | 068                          | v0.4-control-plane  |
| [CLEW-070](./done/CLEW-070.md)                                | v0.4       | done       | 068                          | v0.4-control-plane  |
| [CLEW-071](./done/CLEW-071.md)                                | v0.4       | done       | 068                          | v0.4-control-plane  |
| [CLEW-072](./done/CLEW-072.md)                                | v0.4       | done       | 068                          | v0.4-control-plane  |
| [CLEW-073](./done/CLEW-073.md)                                | v0.4       | done       | 068                          | v0.4-control-plane  |
| [CLEW-074](./CLEW-074.md)                                     | v0.4       | superseded | 069–073                      | —                   |
| [CLEW-075](./done/CLEW-075.md)                                | v0.6       | done       | 077                          | —                   |
| [CLEW-076](./CLEW-076.md)                                     | v0.7       | planned    | 075, 080                     | —                   |
| [CLEW-077](./done/CLEW-077.md)                                | v0.5       | done       | 078, 079                     | —                   |
| [CLEW-078](./done/CLEW-078.md)                                | v0.5       | done       | 068, 069, 072                | —                   |
| [CLEW-079](./done/CLEW-079.md)                                | v0.5       | done       | 078                          | —                   |
| [CLEW-080](./CLEW-080.md)                                     | v0.7       | planned    | 075                          | —                   |
| [CLEW-081](./CLEW-081.md)                                     | v0.7       | planned    | 075, 076, 080                | —                   |
| [CLEW-082](./done/CLEW-082.md)                                | v0.6       | done       | 077                          | —                   |
| [CLEW-083](./done/CLEW-083.md)                                | v0.6       | done       | 082                          | v0.6-transport      |
| [CLEW-084](./done/CLEW-084.md)                                | v0.6       | done       | 082                          | v0.6-transport      |
| [CLEW-085](./done/CLEW-085.md)                                | v0.6       | done       | 083, 084                     | —                   |
| [CLEW-086](./done/CLEW-086.md)                                | v0.6       | done       | 082–085                      | —                   |
| [CLEW-087](./CLEW-087.md)                                     | v0.8       | done       | —                            | —                   |
| [CLEW-088](./CLEW-088.md)                                     | v0.8       | done       | 087                          | v0.8-change-data    |
| [CLEW-089](./CLEW-089.md)                                     | v0.8       | done       | 087                          | v0.8-change-viewers |
| [CLEW-090](./CLEW-090.md)                                     | v0.8       | superseded | 088, 089                     | —                   |
| [CLEW-092](./CLEW-092.md)                                     | v0.8       | done       | 088, 089                     | —                   |
| [CLEW-091](./CLEW-091.md)                                     | v0.8       | done       | 087–089, 092                 | —                   |
| [CLEW-093](./CLEW-093.md)                                     | v0.9       | done       | 087–092                      | —                   |
| [CLEW-099](./CLEW-099.md)                                     | v0.10      | in_review  | —                            | —                   |
| [CLEW-100](./CLEW-100.md)                                     | v0.9       | in_review  | —                            | —                   |
| [CLEW-101](./CLEW-101.md)                                     | v0.10      | in_review  | —                            | —                   |
| [CLEW-102](./CLEW-102.md)                                     | v0.10      | in_review  | CLEW-101                     | v0.10-keyboard-ui   |
| [CLEW-103](./CLEW-103.md)                                     | v0.10      | in_review  | CLEW-101                     | v0.10-keyboard-ui   |
| [CLEW-104](./CLEW-104.md)                                     | v0.10      | in_review  | 099, 102, 103                | —                   |
| [CLEW-105](./CLEW-105.md)                                     | unassigned | planned    | —                            | —                   |
| [CLEW-106](./CLEW-106.md)                                     | unassigned | planned    | 105                          | —                   |
| [CLEW-107](./CLEW-107.md)                                     | unassigned | planned    | 105                          | —                   |
| [CLEW-108](./CLEW-108.md)                                     | unassigned | planned    | 107                          | —                   |
| [CLEW-109](./CLEW-109.md)                                     | unassigned | planned    | 105, 107                     | —                   |
| [CLEW-110](./CLEW-110.md)                                     | unassigned | planned    | 106, 109                     | —                   |
| [CLEW-111](./CLEW-111.md)                                     | unassigned | planned    | 105, 109                     | —                   |
| [CLEW-112](./CLEW-112.md)                                     | unassigned | planned    | 111                          | —                   |
| [CLEW-113](./CLEW-113.md)                                     | unassigned | planned    | 111                          | —                   |
| [CLEW-114](./CLEW-114.md)                                     | unassigned | planned    | 105, 107, 109, 126           | —                   |
| [CLEW-115](./CLEW-115.md)                                     | unassigned | planned    | 108, 114                     | —                   |
| [CLEW-116](./CLEW-116.md)                                     | unassigned | planned    | 106, 113, 115                | —                   |
| [CLEW-117](./CLEW-117.md)                                     | unassigned | planned    | 116, 107                     | —                   |
| [CLEW-118](./CLEW-118.md)                                     | unassigned | planned    | 117                          | —                   |
| [CLEW-119](./CLEW-119.md)                                     | unassigned | planned    | 108, 114                     | —                   |
| [CLEW-120](./CLEW-120.md)                                     | unassigned | planned    | 109, 111, 119                | —                   |
| [CLEW-121](./CLEW-121.md)                                     | unassigned | planned    | 106, 112, 113, 117           | —                   |
| [CLEW-122](./CLEW-122.md)                                     | unassigned | planned    | 110, 115, 118, 119, 120, 121 | —                   |
| [CLEW-123](./CLEW-123.md)                                     | unassigned | planned    | —                            | —                   |
| [CLEW-124](./CLEW-124.md)                                     | unassigned | planned    | 123                          | —                   |
| [CLEW-125](./CLEW-125.md)                                     | unassigned | planned    | 124                          | —                   |
| [CLEW-126](./CLEW-126.md)                                     | unassigned | planned    | 125                          | —                   |
| [CLEW-127-plugins-contracts](./CLEW-127-plugins-contracts.md) | unassigned | planned    | —                            | —                   |
| [CLEW-128-plugins-codex](./CLEW-128-plugins-codex.md)         | unassigned | planned    | 127                          | plugins-runtime     |
| [CLEW-129-plugins-opencode](./CLEW-129-plugins-opencode.md)   | unassigned | planned    | 127                          | plugins-runtime     |
| [CLEW-130-plugins-routing](./CLEW-130-plugins-routing.md)     | unassigned | planned    | 128, 129                     | —                   |
| [CLEW-131-plugins-paired](./CLEW-131-plugins-paired.md)       | unassigned | planned    | 130                          | —                   |
| [CLEW-132-plugins-telemetry](./CLEW-132-plugins-telemetry.md) | unassigned | planned    | 127                          | plugins-sink        |
| [CLEW-133-plugins-release](./CLEW-133-plugins-release.md)     | unassigned | planned    | 130, 131, 132                | —                   |

`release: unassigned` marks scoped implementation work whose release has not been selected. CLEW-105–122 form the [Task data lifecycle queue](../docs/TASK-DATA-LIFECYCLE.md); they remain planned while v0.10 keyboard controls are the active target. Card sizes are S/M; exact dependencies are in frontmatter.

Scout v0 is the first context experiment: [CLEW-123](./CLEW-123.md) → 124 → 125 → 126. CLEW-114 requires the pilot CLEW-126, and CLEW-115 follows 114; storage work CLEW-105–113 stays independent. The [scout document](../docs/SCOUT.md) records later extensions separately.

Plugins epic runs in parallel with Scout/storage (release unassigned): [CLEW-127-plugins-contracts](./CLEW-127-plugins-contracts.md) → (128 + 129) → 130 → 131, with 132 from 127, then 133. Scope: Codex/OpenCode only, no Claude, no live smoke, no marketplace, traces-only telemetry, no workflow constructor. Filenames carry `[epic][shorttitle]` as dash-suffix (`CLEW-127-plugins-contracts.md`) to keep `CLEW-*` tooling working; literal `[...]` brackets are avoided because they break glob.

## Execution waves

```text
Wave 0: CLEW-067
Wave 1: CLEW-068
Wave 2: CLEW-069 + 070 + 071 + 072 + 073
Wave 3: CLEW-074
Completed v0.6: CLEW-075
Wave 4: CLEW-082 (done)
Wave 5: CLEW-083 + CLEW-084 (done)
Wave 6: CLEW-085 (done)
Wave 7: CLEW-086 (done)
Next v0.7: CLEW-080 → CLEW-076 → CLEW-081
Completed interactive response slice: CLEW-078 → CLEW-079 → CLEW-077
Completed v0.8: CLEW-087 → (CLEW-088 + CLEW-089) → CLEW-092 → CLEW-091; CLEW-090 superseded
Completed v0.9: CLEW-093 (lifecycle → finalization gate → Git integration → Task Screen v3 → responsive acceptance)
Next v0.10 mini-release: CLEW-099 + (CLEW-101 → CLEW-102 + CLEW-103) → CLEW-104
Then context experiment (release unassigned): CLEW-123 → CLEW-124 → CLEW-125 → CLEW-126 → CLEW-114 → CLEW-115
Independent storage (release unassigned): CLEW-105 → CLEW-106 / CLEW-107 → later storage cards; see card dependencies
Parallel plugins (release unassigned): CLEW-127 → (128 + 129) → 130 → 131 → 133; 132 from 127 → 133
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
