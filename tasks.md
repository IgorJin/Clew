# Clew — implementation backlog

**Status:** Draft 0.1

**Source:** [`spec.md`](./spec.md)

**Target:** Clew v0.1

This backlog is ordered by risk reduction and vertical product value. A task is complete only when its acceptance criteria are automated where practical and its user-visible or protocol behavior is documented.

## Conventions

- **P0** blocks the first usable flow or validates a critical assumption.
- **P1** is required for v0.1.
- **P2** is intentionally deferred until the core is proven.
- Sizes are relative: **S** (small), **M** (medium), **L** (large/spike with uncertainty).
- A spike produces a reproducible fixture, findings, and a go/change/stop decision; throwaway code alone is not a result.
- Tasks should land as independently reviewable changes. IDs are stable and may later become GitHub issue identifiers.

## Milestone 0 — Repository foundation

Exit condition: the project installs and runs locally, quality checks run with one command, and versioned domain contracts can be imported without infrastructure dependencies.

| ID | Pri | Size | Task | Depends on | Done when |
| --- | --- | --- | --- | --- | --- |
| CLEW-001 | P0 | S | Record the initial toolchain ADR | — | Runtime, package manager, project layout, test stack, CLI approach, and SQLite migration strategy are selected with rationale. |
| CLEW-002 | P0 | M | Scaffold the TypeScript project | 001 | Install, build, test, lint, type-check, and a placeholder `clew --help` work from a clean checkout. |
| CLEW-003 | P1 | S | Add repository quality gates | 002 | CI runs formatting/lint, type-check, unit tests, and build; local commands match CI. |
| CLEW-004 | P0 | M | Define versioned core schemas | 002 | Task contract, profile, plan, review result, verification report, and normalized event schemas have runtime validation and fixtures. |
| CLEW-005 | P1 | S | Implement config and local path resolution | 002 | CLI flags/project/user/default precedence works; local state and worktree roots are resolved safely; secrets are excluded from project config. |

## Milestone 1 — Integration feasibility

Exit condition: the three critical external boundaries have reproducible proof, known supported versions, captured fixtures, and explicit adapter requirements.

| ID | Pri | Size | Task | Depends on | Done when |
| --- | --- | --- | --- | --- | --- |
| CLEW-006 | P0 | L | Codex app-server protocol spike | 002 | A script initializes app-server, starts a thread and turn in a fixture repo, observes tool/lifecycle events and `turn/completed`, and records protocol/version findings. |
| CLEW-007 | P0 | L | OpenCode SDK/server protocol spike | 002 | A pinned version can create a session, run/abort a turn, stream tool/permission/completion events, and record compatibility findings. |
| CLEW-008 | P0 | M | Git worktree isolation spike | 002 | A fixture creates a worktree/branch from a base SHA, runs a modifying process with that `cwd`, proves the primary checkout is unchanged, and safely cleans up. |
| CLEW-009 | P1 | M | Build the harness adapter conformance kit | 004, 006, 007 | Shared tests define session, run, send, subscribe, interrupt, failure, approval, and event-correlation behavior for every adapter. |

Decision gate: if either harness lacks a sufficiently stable machine-facing lifecycle, revise that adapter's scope before building the scheduler. Do not replace it with a generic model loop.

## Milestone 2 — Durable task engine

Exit condition: a fake harness can execute a persisted task DAG exactly once, including failure and restart scenarios, without Git or a real coding harness.

| ID | Pri | Size | Task | Depends on | Done when |
| --- | --- | --- | --- | --- | --- |
| CLEW-010 | P0 | M | Implement the domain model and transition rules | 004 | Task, stage, stage run, attempt, session, workspace, verification, review, approval, and decision invariants are unit-tested. |
| CLEW-011 | P0 | M | Add SQLite schema and migrations | 004 | A fresh store and upgrades work transactionally; foreign keys and unique constraints enforce correlation/idempotency rules. |
| CLEW-012 | P0 | M | Implement the append-only task event log | 010, 011 | Every state transition emits a versioned immutable event and current task projections can be rebuilt from persisted data. |
| CLEW-013 | P0 | L | Implement the local DAG scheduler | 010, 012 | Runnable stages honor dependencies, gates, concurrency, terminal states, and cannot be double-started. |
| CLEW-014 | P1 | L | Reconcile work after process restart | 013 | On restart, Clew classifies persisted non-terminal runs, reconnects or marks them for explicit recovery, and never silently duplicates work. |
| CLEW-015 | P1 | M | Add a deterministic fake harness/workspace | 009, 013 | Tests can script events, approvals, delays, failures, verification, and retries without real external processes. |

## Milestone 3 — First usable vertical slice: Quick

Exit condition: a developer can create, run, inspect, interrupt, and resume a small task through native Codex in an isolated worktree; the result reaches `READY` only through completion policy.

| ID | Pri | Size | Task | Depends on | Done when |
| --- | --- | --- | --- | --- | --- |
| CLEW-016 | P0 | L | Implement `CodexHarness` | 006, 009, 012 | Production adapter passes conformance tests, persists session/thread identity, normalizes events, preserves approvals, and distinguishes turn completion from task completion. |
| CLEW-017 | P0 | M | Implement `GitWorktreeManager` | 005, 008, 010 | Create/status/remove use argument arrays, validate paths/refs, record base/current SHAs, and refuse unsafe dirty removal. |
| CLEW-018 | P0 | M | Implement task CRUD CLI | 004, 012 | `clew init`, `task create`, `task list`, and `task show` validate input and support human-readable and JSON output. |
| CLEW-019 | P0 | L | Orchestrate the Quick profile | 013, 016, 017, 018 | `clew run <id> --profile quick` allocates a run/workspace, starts Codex, records events, applies completion policy, and ends in a truthful state. |
| CLEW-020 | P0 | L | Extract verification evidence | 004, 016, 019 | Observed commands/tool results become evidence linked to task, stage, attempt, workspace, revision, scope, and acceptance criteria where available. |
| CLEW-021 | P1 | M | Add operational task commands | 014, 019 | `status --watch`, `events`, and `interrupt` behave consistently across running, waiting, failed, and terminal tasks. |
| CLEW-022 | P0 | M | Add the Quick end-to-end acceptance fixture | 019, 020, 021 | A fixture task makes a real change in a worktree, emits real evidence, leaves the primary checkout untouched, and reaches `READY`; failure paths do not. |

## Milestone 4 — Standard flow, review, and retries

Exit condition: an isolated worker can be independently reviewed, receive structured blocking feedback in the native session, retry under policy, and retain complete attempt history.

| ID | Pri | Size | Task | Depends on | Done when |
| --- | --- | --- | --- | --- | --- |
| CLEW-023 | P1 | M | Implement profile and policy resolution | 004, 010 | Quick/Standard/Deep defaults and overrides resolve deterministically; the effective policy is stored with each run. |
| CLEW-024 | P1 | M | Validate structured worker reports | 004, 020 | Verification rationale and skipped-check reasons are schema-valid and displayed separately from observed evidence. |
| CLEW-025 | P1 | L | Implement native reviewer execution | 016, 023, 024 | A separate read-only Codex review produces a schema-valid verdict/findings linked to criteria and evidence. |
| CLEW-026 | P1 | L | Implement failure classification and retry routing | 013, 016, 025 | Failures route by class; simple retries reuse a session, repeated failures use a fresh session, maximum attempts are enforced, and all feedback/history is retained. |
| CLEW-027 | P1 | M | Implement human approval gates | 012, 013, 023 | Required gates put tasks in `WAITING_FOR_HUMAN`; approve/reject actions are audited and gates cannot be silently bypassed. |
| CLEW-028 | P1 | M | Add the Standard end-to-end acceptance fixture | 022, 025, 026, 027 | A blocking review finding causes a second native attempt; a passing review reaches `READY`; exhausted retries and human gates remain truthful. |

## Milestone 5 — OpenCode and Deep/parallel flow

Exit condition: a schema-approved plan runs at least two independent workers, integrates their outputs, performs broad verification and independent review, then reaches `READY` or a routed retry.

| ID | Pri | Size | Task | Depends on | Done when |
| --- | --- | --- | --- | --- | --- |
| CLEW-029 | P1 | L | Implement `OpenCodeHarness` | 007, 009, 012 | Pinned production adapter passes conformance tests and normalizes session, tool, permission, idle, completion, failure, and interrupt behavior. |
| CLEW-030 | P1 | L | Implement architect execution and plan validation | 004, 016, 023 | Native Codex runs read-only, produces a schema-valid acyclic plan with unique stages/dependencies, and cannot mutate the workspace. |
| CLEW-031 | P1 | M | Add plan inspection and approval CLI | 027, 030 | `clew plan` exposes the validated plan; execution cannot begin before a required approval and plan version is recorded. |
| CLEW-032 | P1 | L | Add parallel allocation and concurrency controls | 013, 017, 023, 031 | Independent stages receive unique worktrees/branches, run within limits, and cancellation/failure does not corrupt sibling state. |
| CLEW-033 | P1 | L | Define and implement commit integration strategy | 017, 032 | Stage outputs are collected deterministically, conflicts become explicit states, provenance is retained, and no destructive Git fallback is automatic. |
| CLEW-034 | P1 | L | Implement the integration stage | 020, 025, 033 | Integrated revisions run broader configured verification before final review; parallel tasks cannot bypass integration. |
| CLEW-035 | P1 | M | Route optional QA to OpenCode | 024, 029, 032 | A Deep profile can assign a QA/scout stage to OpenCode while the dashboard/domain remains harness-agnostic. |
| CLEW-036 | P0 | L | Add the Deep end-to-end acceptance fixture | 026, 030, 031, 032, 034, 035 | Architect → approval → two isolated workers → integration → review completes reproducibly, including one routed failure/retry scenario. |

## Milestone 6 — v0.1 hardening and release

Exit condition: all v0.1 acceptance criteria in `spec.md` pass from a clean checkout, failure/recovery behavior is documented, and a developer can install and diagnose Clew locally.

| ID | Pri | Size | Task | Depends on | Done when |
| --- | --- | --- | --- | --- | --- |
| CLEW-037 | P1 | M | Harden input, path, Git, and secret handling | 017, 029, 034 | Invalid IDs/refs/path escapes are rejected, secrets are redacted, raw events remain local, and security regression tests cover boundaries. |
| CLEW-038 | P1 | M | Add adapter diagnostics and compatibility checks | 016, 029 | `clew doctor` detects binaries/auth/config/version mismatches and gives actionable results without exposing secrets. |
| CLEW-039 | P1 | M | Add cancellation, timeout, and signal hardening | 014, 016, 029, 032 | Process signals and timeouts do not orphan owned processes/worktrees or falsify task state. |
| CLEW-040 | P1 | M | Build the v0.1 acceptance suite | 022, 028, 036, 037, 039 | The ten v0.1 criteria in `spec.md` map to automated or explicitly documented acceptance checks. |
| CLEW-041 | P1 | M | Package and document v0.1 | 038, 040 | Clean install, quick-start, configuration, supported versions, architecture, troubleshooting, and limitations are reproducible on a supported platform. |

## Post-v0.1 backlog

These items should not enter the critical path until real task usage demonstrates the need.

| ID | Pri | Task | Trigger |
| --- | --- | --- | --- |
| CLEW-042 | P2 | OpenTelemetry/Phoenix integration and trace links | Core event history is useful and low-level debugging is the next bottleneck. |
| CLEW-043 | P2 | Cost/token aggregation | Both adapters expose sufficiently reliable usage metadata. |
| CLEW-044 | P2 | Runtime namespace isolation | Parallel tests need independent ports, databases, queues, or Compose projects. |
| CLEW-045 | P2 | Task dashboard | A 5–10 task friction log identifies the views and attention signals users actually need. |
| CLEW-046 | P2 | Pull request and merge integration | Local `READY` flow is stable and a provider/merge policy is selected. |
| CLEW-047 | P2 | Remote or multi-process scheduler | Local single-process scheduling becomes a measured constraint. |
| CLEW-048 | P2 | Optional external workspace/orchestration adapters | A concrete workflow gap justifies Orca, Beads, OpenHands, or another dependency. |

## Critical path

```text
CLEW-001 → 002 → 006 → 009 → 016 ─┐
                  008 → 017 ───────┼→ 019 → 020 → 022
002 → 004 → 010 → 011 → 012 → 013 ┘

022 → 023 → 025 → 026 → 028
028 → 030 → 031 → 032 → 033 → 034 → 036 → 040 → 041
```

OpenCode (`007 → 009 → 029 → 035`) runs alongside the Codex/core path and joins before the Deep acceptance fixture.

## Recommended first work batch

Start with these tasks, in this order:

1. **CLEW-001:** make the minimum toolchain decisions needed to write executable POCs.
2. **CLEW-002:** establish a runnable TypeScript skeleton.
3. **CLEW-004:** define stable contracts before adapters leak protocol concepts upward.
4. **CLEW-006:** prove the highest-value native harness boundary.
5. **CLEW-008:** prove workspace isolation independently of the harness.
6. **CLEW-007:** prove the second harness boundary and pin its compatibility surface.

After the three spikes, review their evidence before estimating or decomposing production adapters. Unknown protocol behavior should become explicit follow-up tasks rather than being hidden inside large implementation tickets.
