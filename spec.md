# Clew — Product and Technical Specification

**Implementation baseline:** current `main`

**Package version:** `0.2.0` with unreleased v0.3 work already present on `main`

**Product type:** local, task-centric control plane for native coding harnesses

**Positioning:** _Bring your harness. Clew keeps the thread._

This document describes behavior implemented on `main`. Future product direction belongs in [`VISION.md`](./VISION.md); release sequencing belongs in [`ROADMAP.md`](./ROADMAP.md).

## 1. Summary

Clew coordinates a software-development Task across native coding harnesses, Git workspaces, plans, stages, retries, review, verification records, operator decisions, result export, optional telemetry, and usage accounting.

The primary product object is a **Task**, not an agent session. A Task keeps a durable relationship between its contract, native sessions and turns, worktrees, runs, revisions, observed checks, reviews, interruptions, operator actions, and completion decision.

Clew does not implement a coding agent or LLM tool loop. Codex and OpenCode retain control of their native tools, context, shell behavior, browser behavior, approvals, sandbox, and code-editing strategy.

## 2. Current product boundary

Clew currently owns:

- durable Task contracts and lifecycle state;
- Quick, Standard, and Deep execution profiles;
- native Codex and OpenCode adapter boundaries;
- structured harness lifecycle events;
- Git worktree creation, status, integration, retention, and safe cleanup;
- Deep planning, approval-gated DAG execution, bounded parallelism, and integration;
- native reviewer execution and bounded correction attempts;
- recorded verification commands and structured worker rationale;
- explicit interruption, retry, re-verification, export, and human completion;
- append-only event history and restart reconciliation;
- optional OpenTelemetry trace export;
- provider-reported usage capture and pricing-based cost summaries.

Clew does not currently provide:

- a daemon, HTTP API, or Web UI;
- remote or multi-host runners;
- an interactive native-session launcher;
- formal QA orchestration or a claim that recorded checks prove product correctness;
- a general Evidence Graph or quality-policy engine;
- task memory or RAG;
- cross-repository Tasks;
- autonomous task intake or merge;
- PR creation, CI control, or release orchestration.

Final acceptance belongs to a human operator. `READY` is a mechanical Clew state; it is not a guarantee that independent QA has passed.

## 3. Core principles

### 3.1 Task-centric lifecycle

The durable source of truth is a Task contract and its records, not conversation history. Sessions and turns are execution details linked to the Task.

### 3.2 Preserve native harnesses

Execution intelligence remains inside the selected harness:

```text
execution intelligence → native harness
task lifecycle          → Clew
```

`harness` and `model` are separate routing dimensions. Running a model through Codex is not equivalent to running it through OpenCode or a generic model API.

### 3.3 Minimum necessary workflow

Small Tasks use Quick. Standard adds isolation and review. Deep adds architecture, an approval-gated plan, a DAG, parallel worktrees, integration, and review.

### 3.4 Durable history over hidden state

Task transitions, stage transitions, attempts, approvals, findings, checks, revisions, interruptions, retries, exports, and completion are persisted. Restart recovery operates from durable state.

### 3.5 Human acceptance

Only an explicit operator action moves a Task from `READY` to `COMPLETED`. Completion pins a known result revision and is immutable in the current state machine.

## 4. Current architecture

```text
Clew CLI
   │
   ▼
Scheduler / application layer
   ├── SQLite Store and append-only events
   ├── GitWorktreeManager
   ├── CodexHarness
   ├── OpenCodeHarness
   ├── Architect and Reviewer adapters
   ├── optional OpenTelemetry observer
   └── usage and pricing accounting
```

The implementation is a local Node.js ECMAScript-module application. SQLite state lives under `.clew/`; owned worktrees live under `.clew/worktrees/` unless configured otherwise.

Harness protocol objects remain inside adapters. The scheduler and Store consume normalized Clew records.

## 5. Domain model

```text
Task
├── Contract
├── State
├── Plan and approval decisions
├── Stage[]
│   └── Run[]
│       ├── attempt number
│       ├── harness session and turn
│       ├── workspace and runtime namespace
│       ├── result revision
│       └── verification report
├── Review[]
├── OperatorAction[]
├── Completion
├── UsageRecord[] and CostRecord[]
├── optional trace correlation
└── Event[]
```

A Run is the current durable representation of one Stage attempt. Attempt is not a separate entity.

Stable identifiers include, where available:

- `task_id`;
- `stage_id`;
- `run_id`;
- `attempt`;
- `session_id`;
- `turn_id`;
- `commit_sha`;
- runtime namespace;
- trace and span identifiers.

## 6. Task contract

A normalized contract requires `id`, `title`, `goal`, `profile`, and at least one acceptance criterion. It materializes `risk` and `base_ref` defaults before persistence.

```yaml
id: AUTH-142
title: Refresh token rotation
goal: Add refresh-token rotation without changing existing login behavior.
acceptance:
  - id: AC-1
    criterion: A successful refresh issues a new refresh token.
  - id: AC-2
    criterion: The previous token becomes invalid.
risk: high
profile: deep
base_ref: main
verification:
  - command: npm test
    args: []
```

Acceptance IDs are stable references for worker reports and reviewer findings. Clew currently records their coverage but does not implement a general acceptance-policy or QA engine.

## 7. Execution profiles

Profiles express workflow depth. Execution mode is an internal policy dimension, so Parallel is not a separate user-facing profile.

### 7.1 Quick

```text
Task → direct worker → targeted checks → READY
```

Defaults:

- Codex worker;
- direct execution mode;
- one worker;
- no architecture stage;
- no independent review;
- at most three worker attempts.

### 7.2 Standard

```text
Task → isolated worktree → worker → targeted checks → reviewer
     → correction when requested → READY or FAILED
```

Defaults:

- Codex worker and reviewer;
- isolated execution mode;
- one worker at a time;
- no architecture stage;
- structured independent review;
- at most three worker attempts in total.

Blocking review findings are returned to the worker while the attempt limit permits another run.

### 7.3 Deep

```text
Task → read-only architect → schema-valid plan → human approval
     → bounded parallel stage runs → integration → broad checks
     → reviewer → READY or routed failure
```

Defaults:

- Codex architect, workers, and reviewer;
- parallel execution mode with at most three workers;
- a validated acyclic DAG;
- explicit plan approval;
- isolated worktrees and commit integration;
- broad verification scope;
- independent review.

## 8. Lifecycle

Implemented Task states:

```text
DRAFT
PLAN_READY
QUEUED
RECOVERING
EXECUTING
VERIFYING
REVIEWING
WAITING_FOR_HUMAN
READY
COMPLETED
FAILED
CANCELLED
BLOCKED
```

The common successful path is:

```text
DRAFT → QUEUED → EXECUTING → VERIFYING
      → REVIEWING when configured
      → READY → COMPLETED
```

Deep planning may pass through `PLAN_READY` and `WAITING_FOR_HUMAN` before execution. Restart reconciliation uses `RECOVERING`.

`READY` currently means the configured automated execution path produced passing recorded verification and any configured review passed. It means the result is ready for operator inspection; it is not independent QA certification.

`COMPLETED` requires an explicit operator, a known current result revision, and a completion record. `COMPLETED` has no outgoing transition.

Implemented Stage states are `QUEUED`, `RUNNING`, `COMPLETED`, `FAILED`, `BLOCKED`, and `CANCELLED`. Implemented Run states are `RUNNING`, `COMPLETED`, `FAILED`, and `INTERRUPTED`.

## 9. Harness integrations

### 9.1 Codex

Codex runs through `codex app-server` over its structured protocol. Clew starts or resumes a thread, starts a turn, handles native approvals, consumes item and lifecycle events, requests interruption through the protocol, and persists thread/turn identity.

`turn/completed` means one harness turn finished. It does not mean the Task is completed.

### 9.2 OpenCode

OpenCode runs through its HTTP server and event stream. Clew creates or resumes a session, submits a prompt, consumes session/tool/permission events, handles abort, and persists session/message identity.

### 9.3 Normalized events

The adapter boundary emits normalized events such as:

```text
SESSION_STARTED
SESSION_RESUMED
TURN_STARTED
TOOL_STARTED
TOOL_COMPLETED
VERIFICATION_DETECTED
APPROVAL_REQUIRED
APPROVAL_DECIDED
HARNESS_COMPLETED
HARNESS_INTERRUPTED
HARNESS_TIMED_OUT
HARNESS_FAILED
```

Secret redaction occurs before durable event persistence.

## 10. Plans, scheduling, and retries

Deep plans are schema-validated for required fields, safe and unique Stage IDs, existing dependencies, acyclicity, supported harness routing, and an integration path.

A queued Stage is runnable when its dependencies have completed. Independent Stages may execute concurrently up to `maxWorkers`. Their commits are integrated deterministically before final review.

Retries create new Runs and increment the Stage attempt number; prior Runs are never overwritten. Clew supports automatic bounded retries for configured failures and blocking review findings, plus explicit operator retry from supported states.

On restart, abandoned `RUNNING` records are marked interrupted. Clew rebuilds runnable state from durable records and resumes a native session when the adapter and retry path allow it.

## 11. Native review

Standard and Deep may run a separate native reviewer. The reviewer returns a structured verdict and findings containing severity, criterion, and reason.

Blocking findings route back into worker correction while attempts remain. A passing review allows the Task to proceed toward `READY`. The reviewer is an execution aid, not the final acceptance authority; the operator controls `COMPLETED`.

## 12. Verification boundary

Workers execute checks through their native harness. Clew records observed command/tool results and a structured verification rationale. A run cannot reach `READY` without at least one passing verification item.

Clew can also rerun configured commands explicitly against a pinned known revision with `clew verify`. Records carry revision and environment identity so changed code or environment can invalidate reuse.

These records answer what ran and against which revision. They do not replace independent CI, Playwright testing, manual QA, or operator judgment. A richer Evidence Graph and quality-policy model are future research, not part of the current product contract.

## 13. Human control

Implemented human actions include:

- approve or reject a Deep plan;
- accept or decline a native harness approval request;
- request interruption;
- explicitly retry a Task/Stage;
- rerun verification against a pinned revision;
- inspect result and history;
- complete a `READY` Task at a pinned revision.

Operator actions and completion decisions are durable and auditable. A completed Task is immutable in the current implementation.

## 14. Workspace management

`GitWorktreeManager` uses native Git commands with argument arrays. It validates refs and paths, records base/current revisions, and creates isolated task/stage worktrees.

Cleanup is ownership-aware:

- active worktrees are retained;
- dirty worktrees are retained by default;
- safe prune removes only inactive, clean, Clew-owned worktrees;
- force removal is explicit.

Clew does not implement Git internals or automatic conflict resolution. Integration conflicts become explicit failures with inspectable workspaces.

## 15. Persistence and result projection

SQLite is the local source of truth. Schema migrations are transactional and versioned. The Store persists Tasks, Stages, Plans, Runs, Events, approvals, operator actions, completion, telemetry correlation, usage records, pricing snapshots, and cost projections.

`task result` projects the durable result, including contract, attempts, revision, workspace, observed verification, review, completion, runtime namespace, and usage summary.

Export writes a manifest, checksum, patch, and Git bundle outside the primary checkout. Completion and export pin a known result revision.

## 16. Optional observability

Tracing is disabled by default and must not affect Task correctness or state.

```sh
clew telemetry install
CLEW_TELEMETRY_ENABLED=true clew telemetry status
```

The core package has no required OpenTelemetry runtime dependency. The install command places the official trace runtime under `.clew/telemetry`. When enabled, Clew exports allowlisted lifecycle spans through OTLP and persists correlation identifiers. Raw prompts, completions, source files, environment values, and tool payloads are excluded from span attributes.

Missing runtime or collector failure remains diagnostic and does not change execution behavior.

## 17. Usage and cost accounting

Each completed native turn receives one idempotent usage record. Clew stores provider-reported input, output, cache, and reasoning token counts when available. Missing data remains `unknown` or `partial`; Clew does not estimate tokens.

```sh
clew pricing sync --url https://pricing.example/catalog.json --source provider-catalog
clew task usage TASK --human
```

Pricing sync stores immutable catalog snapshots. Decimal cost projection links usage to a snapshot and aggregates the complete Task lifecycle across attempts and Stages. Mixed currencies remain separate.

## 18. CLI surface

The implemented CLI includes:

```text
init
task create | list | show | result | history | usage
plan
approve | reject
approve-run | reject-run
run | retry | verify | interrupt
status | events
complete | export | cleanup
worktree list | remove | prune
telemetry install | status
pricing sync
doctor
```

There is currently no `continue` command; operator continuation uses the implemented retry/session-resume paths. A dedicated continuation workflow is planned in `ROADMAP.md`.

## 19. Configuration and security

Configuration precedence is command flag, environment, project `.clew.json`, user config, then defaults.

Role-specific model configuration exists for worker, architect, reviewer, and optional plan-defined roles. Project config rejects secret-like keys and absolute worktree roots. Credentials remain in native harness or user-level configuration.

Security requirements include:

- no shell interpolation for user-controlled Git arguments;
- path and ref validation;
- event redaction before persistence;
- no credential capture in telemetry;
- explicit approvals for native privileged actions;
- bounded cleanup and interruption behavior;
- no external service required for the default fake/local acceptance path.

## 20. Current guarantees and intentional limits

The maintained acceptance suite covers Quick, Standard, and Deep flows; native adapter protocol fixtures; plan approval; bounded parallel DAG execution; retry and restart; worktree integration; review; verification trust; explicit completion; export; cleanup; optional telemetry isolation; and usage idempotency.

Current limitations:

- single local process and SQLite;
- no daemon or browser UI;
- no remote Runner;
- live terminal attachment is local Codex-only and requires a compatible App Server/CLI pair;
- no cross-repository transaction;
- no team identity or RBAC;
- no formal QA/evidence-policy product surface;
- Node's built-in SQLite API remains experimental.

For future direction and release order, see [`VISION.md`](./VISION.md) and [`ROADMAP.md`](./ROADMAP.md).
