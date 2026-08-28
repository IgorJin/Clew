# Clew — implementation backlog

**Status:** v0.2.0 implementation complete

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

## v0.1 completion record

| Range          | Status   | Release evidence                                                                                          |
| -------------- | -------- | --------------------------------------------------------------------------------------------------------- |
| `CLEW-001–005` | Complete | Toolchain ADR, Node.js project gates, versioned schemas/fixtures, runtime validators, config precedence   |
| `CLEW-006`     | Complete | Codex fixture conformance plus successful real `0.148.0` worktree/evidence/commit smoke                   |
| `CLEW-007`     | Complete | OpenCode `1.18.23` live session/SSE/tool/command-evidence path reached `READY`; failure path also proven  |
| `CLEW-008–022` | Complete | Worktree isolation, durable engine, Quick CLI/acceptance, verification correlation, recovery and watch    |
| `CLEW-023–028` | Complete | Persisted policy, native reviewer smoke, feedback/session retry routing, human gates, Standard acceptance |
| `CLEW-029–036` | Complete | OpenCode adapter, native architect smoke, Deep DAG/routing/integration/review and routed retry            |
| `CLEW-037–041` | Complete | Security hardening, diagnostics, cancellation/cleanup, acceptance matrix, packaging documentation         |

All implementation work and release sign-off through `CLEW-041` are complete.

## Milestone 0 — Repository foundation

Exit condition: the project installs and runs locally, quality checks run with one command, and versioned domain contracts can be imported without infrastructure dependencies.

| ID       | Pri | Size | Task                                       | Depends on | Done when                                                                                                                                      |
| -------- | --- | ---- | ------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| CLEW-001 | P0  | S    | Record the initial toolchain ADR           | —          | Runtime, package manager, project layout, test stack, CLI approach, and SQLite migration strategy are selected with rationale.                 |
| CLEW-002 | P0  | M    | Scaffold the Node.js project               | 001        | Install, syntax-check, test, lint, and `clew --help` work from a clean checkout.                                                               |
| CLEW-003 | P1  | S    | Add repository quality gates               | 002        | CI runs formatting/lint, syntax checks and unit tests; local commands match CI.                                                                |
| CLEW-004 | P0  | M    | Define versioned core schemas              | 002        | Task contract, profile, plan, review result, verification report, and normalized event schemas have runtime validation and fixtures.           |
| CLEW-005 | P1  | S    | Implement config and local path resolution | 002        | CLI flags/project/user/default precedence works; local state and worktree roots are resolved safely; secrets are excluded from project config. |

## Milestone 1 — Integration feasibility

Exit condition: the three critical external boundaries have reproducible proof, known supported versions, captured fixtures, and explicit adapter requirements.

| ID       | Pri | Size | Task                                      | Depends on    | Done when                                                                                                                                                                |
| -------- | --- | ---- | ----------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CLEW-006 | P0  | L    | Codex app-server protocol spike           | 002           | A script initializes app-server, starts a thread and turn in a fixture repo, observes tool/lifecycle events and `turn/completed`, and records protocol/version findings. |
| CLEW-007 | P0  | L    | OpenCode SDK/server protocol spike        | 002           | A pinned version can create a session, run/abort a turn, stream tool/permission/completion events, and record compatibility findings.                                    |
| CLEW-008 | P0  | M    | Git worktree isolation spike              | 002           | A fixture creates a worktree/branch from a base SHA, runs a modifying process with that `cwd`, proves the primary checkout is unchanged, and safely cleans up.           |
| CLEW-009 | P1  | M    | Build the harness adapter conformance kit | 004, 006, 007 | Shared tests define session, run, send, subscribe, interrupt, failure, approval, and event-correlation behavior for every adapter.                                       |

Decision gate: if either harness lacks a sufficiently stable machine-facing lifecycle, revise that adapter's scope before building the scheduler. Do not replace it with a generic model loop.

## Milestone 2 — Durable task engine

Exit condition: a fake harness can execute a persisted task DAG exactly once, including failure and restart scenarios, without Git or a real coding harness.

| ID       | Pri | Size | Task                                            | Depends on | Done when                                                                                                                                    |
| -------- | --- | ---- | ----------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| CLEW-010 | P0  | M    | Implement the domain model and transition rules | 004        | Task, stage, stage run, attempt, session, workspace, verification, review, approval, and decision invariants are unit-tested.                |
| CLEW-011 | P0  | M    | Add SQLite schema and migrations                | 004        | A fresh store and upgrades work transactionally; foreign keys and unique constraints enforce correlation/idempotency rules.                  |
| CLEW-012 | P0  | M    | Implement the append-only task event log        | 010, 011   | Every state transition emits a versioned immutable event and current task projections can be rebuilt from persisted data.                    |
| CLEW-013 | P0  | L    | Implement the local DAG scheduler               | 010, 012   | Runnable stages honor dependencies, gates, concurrency, terminal states, and cannot be double-started.                                       |
| CLEW-014 | P1  | L    | Reconcile work after process restart            | 013        | On restart, Clew classifies persisted non-terminal runs, reconnects or marks them for explicit recovery, and never silently duplicates work. |
| CLEW-015 | P1  | M    | Add a deterministic fake harness/workspace      | 009, 013   | Tests can script events, approvals, delays, failures, verification, and retries without real external processes.                             |

## Milestone 3 — First usable vertical slice: Quick

Exit condition: a developer can create, run, inspect, interrupt, and resume a small task through native Codex in an isolated worktree; the result reaches `READY` only through completion policy.

| ID       | Pri | Size | Task                                        | Depends on         | Done when                                                                                                                                                                      |
| -------- | --- | ---- | ------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CLEW-016 | P0  | L    | Implement `CodexHarness`                    | 006, 009, 012      | Production adapter passes conformance tests, persists session/thread identity, normalizes events, preserves approvals, and distinguishes turn completion from task completion. |
| CLEW-017 | P0  | M    | Implement `GitWorktreeManager`              | 005, 008, 010      | Create/status/remove use argument arrays, validate paths/refs, record base/current SHAs, and refuse unsafe dirty removal.                                                      |
| CLEW-018 | P0  | M    | Implement task CRUD CLI                     | 004, 012           | `clew init`, `task create`, `task list`, and `task show` validate input and support human-readable and JSON output.                                                            |
| CLEW-019 | P0  | L    | Orchestrate the Quick profile               | 013, 016, 017, 018 | `clew run <id> --profile quick` allocates a run/workspace, starts Codex, records events, applies completion policy, and ends in a truthful state.                              |
| CLEW-020 | P0  | L    | Extract verification evidence               | 004, 016, 019      | Observed commands/tool results become evidence linked to task, stage, attempt, workspace, revision, scope, and acceptance criteria where available.                            |
| CLEW-021 | P1  | M    | Add operational task commands               | 014, 019           | `status --watch`, `events`, and `interrupt` behave consistently across running, waiting, failed, and terminal tasks.                                                           |
| CLEW-022 | P0  | M    | Add the Quick end-to-end acceptance fixture | 019, 020, 021      | A fixture task makes a real change in a worktree, emits real evidence, leaves the primary checkout untouched, and reaches `READY`; failure paths do not.                       |

## Milestone 4 — Standard flow, review, and retries

Exit condition: an isolated worker can be independently reviewed, receive structured blocking feedback in the native session, retry under policy, and retain complete attempt history.

| ID       | Pri | Size | Task                                               | Depends on         | Done when                                                                                                                                                            |
| -------- | --- | ---- | -------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLEW-023 | P1  | M    | Implement profile and policy resolution            | 004, 010           | Quick/Standard/Deep defaults and overrides resolve deterministically; the effective policy is stored with each run.                                                  |
| CLEW-024 | P1  | M    | Validate structured worker reports                 | 004, 020           | Verification rationale and skipped-check reasons are schema-valid and displayed separately from observed evidence.                                                   |
| CLEW-025 | P1  | L    | Implement native reviewer execution                | 016, 023, 024      | A separate read-only Codex review produces a schema-valid verdict/findings linked to criteria and evidence.                                                          |
| CLEW-026 | P1  | L    | Implement failure classification and retry routing | 013, 016, 025      | Failures route by class; simple retries reuse a session, repeated failures use a fresh session, maximum attempts are enforced, and all feedback/history is retained. |
| CLEW-027 | P1  | M    | Implement human approval gates                     | 012, 013, 023      | Required gates put tasks in `WAITING_FOR_HUMAN`; approve/reject actions are audited and gates cannot be silently bypassed.                                           |
| CLEW-028 | P1  | M    | Add the Standard end-to-end acceptance fixture     | 022, 025, 026, 027 | A blocking review finding causes a second native attempt; a passing review reaches `READY`; exhausted retries and human gates remain truthful.                       |

## Milestone 5 — OpenCode and Deep/parallel flow

Exit condition: a schema-approved plan runs at least two independent workers, integrates their outputs, performs broad verification and independent review, then reaches `READY` or a routed retry.

| ID       | Pri | Size | Task                                              | Depends on                   | Done when                                                                                                                                              |
| -------- | --- | ---- | ------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CLEW-029 | P1  | L    | Implement `OpenCodeHarness`                       | 007, 009, 012                | Pinned production adapter passes conformance tests and normalizes session, tool, permission, idle, completion, failure, and interrupt behavior.        |
| CLEW-030 | P1  | L    | Implement architect execution and plan validation | 004, 016, 023                | Native Codex runs read-only, produces a schema-valid acyclic plan with unique stages/dependencies, and cannot mutate the workspace.                    |
| CLEW-031 | P1  | M    | Add plan inspection and approval CLI              | 027, 030                     | `clew plan` exposes the validated plan; execution cannot begin before a required approval and plan version is recorded.                                |
| CLEW-032 | P1  | L    | Add parallel allocation and concurrency controls  | 013, 017, 023, 031           | Independent stages receive unique worktrees/branches, run within limits, and cancellation/failure does not corrupt sibling state.                      |
| CLEW-033 | P1  | L    | Define and implement commit integration strategy  | 017, 032                     | Stage outputs are collected deterministically, conflicts become explicit states, provenance is retained, and no destructive Git fallback is automatic. |
| CLEW-034 | P1  | L    | Implement the integration stage                   | 020, 025, 033                | Integrated revisions run broader configured verification before final review; parallel tasks cannot bypass integration.                                |
| CLEW-035 | P1  | M    | Route optional QA to OpenCode                     | 024, 029, 032                | A Deep profile can assign a QA/scout stage to OpenCode while the dashboard/domain remains harness-agnostic.                                            |
| CLEW-036 | P0  | L    | Add the Deep end-to-end acceptance fixture        | 026, 030, 031, 032, 034, 035 | Architect → approval → two isolated workers → integration → review completes reproducibly, including one routed failure/retry scenario.                |

## Milestone 6 — v0.1 hardening and release

Exit condition: all v0.1 acceptance criteria in `spec.md` pass from a clean checkout, failure/recovery behavior is documented, and a developer can install and diagnose Clew locally.

| ID       | Pri | Size | Task                                             | Depends on              | Done when                                                                                                                                               |
| -------- | --- | ---- | ------------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLEW-037 | P1  | M    | Harden input, path, Git, and secret handling     | 017, 029, 034           | Invalid IDs/refs/path escapes are rejected, secrets are redacted, raw events remain local, and security regression tests cover boundaries.              |
| CLEW-038 | P1  | M    | Add adapter diagnostics and compatibility checks | 016, 029                | `clew doctor` detects binaries/auth/config/version mismatches and gives actionable results without exposing secrets.                                    |
| CLEW-039 | P1  | M    | Add cancellation, timeout, and signal hardening  | 014, 016, 029, 032      | Process signals and timeouts do not orphan owned processes/worktrees or falsify task state.                                                             |
| CLEW-040 | P1  | M    | Build the v0.1 acceptance suite                  | 022, 028, 036, 037, 039 | The ten v0.1 criteria in `spec.md` map to automated or explicitly documented acceptance checks.                                                         |
| CLEW-041 | P1  | M    | Package and document v0.1                        | 038, 040                | Clean install, quick-start, configuration, supported versions, architecture, troubleshooting, and limitations are reproducible on a supported platform. |

## v0.2 completion record

| Range                      | Status   | Release evidence                                                                                            |
| -------------------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `CLEW-049–061`             | Complete | Versioned contracts, durable control commands, trust evaluation, pinned completion, export and safe cleanup |
| `CLEW-044`, `CLEW-062–063` | Complete | Deterministic runtime namespaces, role model precedence, optional OpenCode model boundary                   |
| `CLEW-064–066`             | Complete | Upgrade migration coverage, local lifecycle acceptance, package/documentation release checks                |

## v0.2 plan — Ready to Delivered

The next release closes the local lifecycle after `READY`. A developer must be able to inspect the exact result, retry or reverify deliberately, distinguish fresh evidence from stale evidence, accept a pinned revision as `COMPLETED`, export it without mutating the primary checkout, and clean up safely.

### Milestone 7 — Control and result visibility

| ID       | Pri | Size | Task                                          | Depends on | Done when                                                                                                                                                  |
| -------- | --- | ---- | --------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLEW-049 | P0  | M    | Define v0.2 lifecycle and versioned contracts | 041        | Completion decision, result manifest, evidence trust/freshness, retry request, and runtime namespace contracts have schemas, invariants, and examples.     |
| CLEW-050 | P0  | M    | Persist completion and operator actions       | 049        | Migrations store actor, expected revision, decision, note, timestamps, and append-only events atomically; v0.1 databases upgrade without data loss.        |
| CLEW-051 | P1  | M    | Add `task result` human and JSON views        | 049        | One command shows contract, attention, plan, attempts, final revision, evidence coverage, review verdict, workspace, and base-to-result diff summary.      |
| CLEW-052 | P1  | M    | Add attempt and stage history filters         | 051        | CLI can select a task/stage/attempt and returns stable JSON plus documented exit codes without requiring raw SQLite inspection.                            |
| CLEW-053 | P0  | L    | Implement explicit `retry` command            | 049, 038   | `clew retry TASK STAGE` validates state/policy, creates exactly one new attempt, chooses resume/fresh session deterministically, and records actor/reason. |
| CLEW-054 | P0  | L    | Implement explicit `verify` command           | 049, 020   | A user can rerun configured verification against a pinned workspace revision without rerunning implementation; evidence remains attempt/revision linked.   |

### Milestone 8 — Evidence trust and completion

| ID       | Pri | Size | Task                                           | Depends on    | Done when                                                                                                                                              |
| -------- | --- | ---- | ---------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CLEW-055 | P0  | M    | Record verification environment fingerprints   | 049           | Evidence includes normalized platform, runtime, command, relevant config, workspace, and revision identity with secret-safe deterministic hashing.     |
| CLEW-056 | P0  | L    | Implement freshness and trust evaluation       | 055           | Policy explains whether evidence is reusable, stale, skipped, or untrusted; same-revision trustworthy evidence is not rerun unnecessarily.             |
| CLEW-057 | P0  | L    | Guard and invalidate `READY` deterministically | 050, 056      | Revision, environment, policy, or blocking-review changes invalidate readiness with an explicit event; stale evidence can never authorize completion.  |
| CLEW-058 | P1  | M    | Produce a versioned final result manifest      | 051, 057      | Manifest pins task contract, base/result SHAs, included stage revisions, evidence coverage, review, decisions, skipped checks, and known limitations.  |
| CLEW-059 | P1  | L    | Export patch and Git bundle artifacts          | 058           | Export is reproducible from pinned SHAs, includes the manifest and checksum, refuses dirty/ambiguous state, and never modifies the primary checkout.   |
| CLEW-060 | P0  | M    | Implement explicit `complete` command          | 050, 057, 058 | `clew complete TASK --revision SHA --actor ACTOR` only transitions fresh `READY` work to `COMPLETED` and records the human acceptance transactionally. |
| CLEW-061 | P1  | M    | Add completed-task retention and cleanup       | 060           | Completed task worktrees can be archived/pruned by policy; active, dirty, unexported, or unaccepted work is protected and every removal is auditable.  |

### Milestone 9 — Parallel runtime and local model routing

| ID       | Pri | Size | Task                                         | Depends on | Done when                                                                                                                                                |
| -------- | --- | ---- | -------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLEW-044 | P1  | L    | Add runtime namespace isolation              | 049        | Every run receives stable namespace/port/database/container identifiers; parallel fixture stages prove they cannot collide and cleanup is deterministic. |
| CLEW-062 | P1  | L    | Add per-role harness and model configuration | 049        | Worker, architect, reviewer, and QA roles resolve validated Codex/OpenCode model settings through the documented config precedence without hardcoding.   |
| CLEW-063 | P1  | M    | Prove an OpenCode local-model role           | 062        | A pinned local or user-selected OpenCode model passes a documented role smoke; unavailable hardware/provider becomes an explicit optional-gate result.   |

### Milestone 10 — Upgrade and release

| ID       | Pri | Size | Task                                      | Depends on                   | Done when                                                                                                                                       |
| -------- | --- | ---- | ----------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| CLEW-064 | P0  | L    | Build v0.1 → v0.2 upgrade acceptance      | 050, 055                     | A copied v0.1 database migrates, projections rebuild, existing tasks/events remain explainable, and downgrade limitations are documented.       |
| CLEW-065 | P0  | L    | Build the v0.2 end-to-end acceptance flow | 053, 054, 057, 059, 060, 061 | Installed CLI runs failure → manual retry → READY → stale evidence → reverify → export → complete → cleanup with restart checks between phases. |
| CLEW-066 | P1  | M    | Package and document v0.2.0               | 044, 063, 064, 065           | Clean install, upgrade, command reference, schemas, migrations, live adapter checks, limitations, and release evidence are reproducible.        |

### v0.2 critical path

```text
CLEW-049 → 050 ────────────────┐
         → 055 → 056 → 057 ───┼→ 058 → 059 ─┐
         → 053 ────────────────┤             ├→ 065 → 066
         → 054 ────────────────┤    060 → 061┘
         → 051 → 052           │
         → 044                 │
         → 062 → 063           │
               050 → 064 ──────┘
```

Recommended first batch: `CLEW-049`, `CLEW-053`, and `CLEW-055`. The lifecycle contract prevents incompatible persistence work, manual retry closes an explicit CLI gap, and environment fingerprinting retires the largest completion-policy uncertainty early.

## Later backlog

These items stay outside v0.2 until usage provides a concrete trigger.

| ID       | Pri | Task                                               | Trigger                                                                                  |
| -------- | --- | -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| CLEW-042 | P2  | OpenTelemetry/Phoenix integration and trace links  | Core event history is useful and low-level debugging is the next bottleneck.             |
| CLEW-043 | P2  | Cost/token aggregation                             | Both adapters expose sufficiently reliable usage metadata.                               |
| CLEW-045 | P2  | Task dashboard                                     | A 5–10 task friction log identifies the views and attention signals users actually need. |
| CLEW-046 | P2  | Pull request and merge integration                 | Export/complete flow is stable and a provider/merge policy is selected.                  |
| CLEW-047 | P2  | Remote or multi-process scheduler                  | Local single-process scheduling becomes a measured constraint.                           |
| CLEW-048 | P2  | Optional external workspace/orchestration adapters | A concrete workflow gap justifies Orca, Beads, OpenHands, or another dependency.         |

## v0.1 historical critical path

```text
CLEW-001 → 002 → 006 → 009 → 016 ─┐
                  008 → 017 ───────┼→ 019 → 020 → 022
002 → 004 → 010 → 011 → 012 → 013 ┘

022 → 023 → 025 → 026 → 028
028 → 030 → 031 → 032 → 033 → 034 → 036 → 040 → 041
```

OpenCode (`007 → 009 → 029 → 035`) runs alongside the Codex/core path and joins before the Deep acceptance fixture.

## v0.1 historical first work batch

Start with these tasks, in this order:

1. **CLEW-001:** make the minimum toolchain decisions needed to write executable POCs.
2. **CLEW-002:** establish the runnable dependency-free Node.js skeleton selected by ADR-0001.
3. **CLEW-004:** define stable contracts before adapters leak protocol concepts upward.
4. **CLEW-006:** prove the highest-value native harness boundary.
5. **CLEW-008:** prove workspace isolation independently of the harness.
6. **CLEW-007:** prove the second harness boundary and pin its compatibility surface.

After the three spikes, review their evidence before estimating or decomposing production adapters. Unknown protocol behavior should become explicit follow-up tasks rather than being hidden inside large implementation tickets.
