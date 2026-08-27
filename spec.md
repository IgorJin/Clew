# Clew — Product and Technical Specification

**Status:** v0.1 final

**Product type:** local, task-centric control plane for AI-assisted software development

**Positioning:** _Bring your harness. Clew keeps the thread._

## 1. Summary

Clew coordinates the lifecycle of a software-development task across native AI coding harnesses, Git workspaces, verification, review, retries, and human approvals.

Clew is not an AI coding agent and does not implement its own agent loop. Codex, OpenCode, and future harnesses retain control of their native tools, context management, shell and browser behavior, approvals, sandboxing, and verification. Clew supplies the layer above them: one durable task thread that explains what is running, where it is running, what evidence was produced, why a retry occurred, and whether a human action is required.

The primary product object is a **Task**, not an agent session.

## 2. Problem

AI-assisted development is currently session-centric. A single feature or fix may span:

- one or more Codex/OpenCode sessions;
- branches and Git worktrees;
- planning and architecture decisions;
- test, type-check, build, and browser evidence;
- retries and reviewer feedback;
- CI, pull request, and human approval state.

These artifacts do not form a coherent lifecycle. Developers must manually remember which session belongs to which requirement, which attempt failed, whether checks actually ran, and what currently needs attention.

Clew turns those disconnected artifacts into one inspectable development task.

## 3. Product goals

Clew must:

1. Preserve the native behavior of every supported coding harness.
2. Represent a development task as a durable contract and lifecycle.
3. Route stages to an appropriate harness and model independently.
4. Support direct, isolated, and parallel execution profiles.
5. Allocate and track native Git worktrees and branches.
6. Normalize harness lifecycle and tool events into a common event model.
7. Aggregate verification evidence without needlessly repeating harness work.
8. Distinguish harness completion from task completion.
9. Route failures and reviewer findings into explicit retry paths.
10. Make human approvals policy-driven and visible.
11. Preserve an auditable history of stages, sessions, attempts, evidence, decisions, and reviews.

## 4. Non-goals

Clew must not become:

- a custom LLM coding loop;
- a replacement for Codex, OpenCode, or their native tools;
- a browser, shell, or Git implementation;
- a stdout parser for interactive agent TUIs;
- a general-purpose tracing UI;
- a proprietary PR review engine;
- a general RAG, memory, or issue-tracking platform;
- an orchestration ceremony imposed on every small change.

Third-party systems such as Phoenix, OpenChamber, OpenHands, Orca, and Beads may become optional integrations, but none is a critical dependency of v0.1.

## 5. Core principles

### 5.1 Task-centric lifecycle

The source of truth is a task contract, not conversation history. Harness sessions, workspaces, attempts, commits, checks, reviews, and traces are related records within the task.

### 5.2 Preserve native harnesses

`model` and `harness` are separate routing dimensions. A model used through a generic runtime is not equivalent to the same model used through Codex or OpenCode.

Initial integrations:

- Codex through `codex app-server` and its structured lifecycle protocol;
- OpenCode through its SDK/server API and event stream;
- Git through non-interactive native Git commands.

No harness-specific protocol object may escape its adapter into the Clew domain.

### 5.3 Minimum necessary workflow

Small tasks use a small pipeline. Architecture, scouting, parallel workers, independent completion judging, and mandatory review are enabled only by profile or policy.

### 5.4 Evidence over claims

Harness tool events are the authoritative record of what actually ran. An agent's structured verification report explains why it considers the evidence sufficient. Review decides whether that evidence satisfies the task contract.

### 5.5 Human control by policy

Approvals are explicit task states produced by policy, not ad hoc prompt conventions. Risky architecture decisions, dependency changes, and merges can require human gates.

## 6. Users and primary use cases

The initial user is a developer working locally with one or more AI coding harnesses.

Primary use cases:

1. Run a small change through one native Codex session and retain its task history.
2. Run a normal feature in an isolated worktree, verify it, and optionally review it with a separate session/model.
3. Plan a large task, approve a structured DAG, run independent stages in parallel worktrees, integrate them, and review the result.
4. See why a stage retried and continue the correct native session with reviewer feedback.
5. Determine at a glance whether the task is progressing, blocked, ready, or waiting for a human.

## 7. Conceptual architecture

```text
                            Clew
                              │
                     Task contract/policy
                              │
                         Task scheduler
                              │
             ┌────────────────┴────────────────┐
             │                                 │
       Workspace layer                   Harness layer
             │                                 │
     GitWorktreeManager          ┌─────────────┴─────────────┐
                                 │                           │
                           CodexHarness                OpenCodeHarness
                                 │                           │
                         codex app-server             OpenCode SDK/server
                                 └─────────────┬─────────────┘
                                               │
                                      normalized events
                                               │
                                  verification and review
                                               │
                                        task readiness
```

The initial implementation is a local Node.js ECMAScript-module application with runtime-validated boundaries, composed of:

- a domain and application layer;
- a small persistent scheduler;
- a SQLite state store;
- `CodexHarness` and `OpenCodeHarness` adapters;
- `GitWorktreeManager`;
- a CLI;
- structured logs and an append-only task event history.

A web dashboard is intentionally deferred until real usage reveals which task views are essential.

## 8. Domain model

```text
Project
└── Task
    ├── Contract
    ├── Profile and Policy
    ├── Plan
    │   └── Stage[]
    ├── StageRun[]
    │   ├── HarnessSession
    │   ├── Workspace
    │   ├── Attempt[]
    │   └── VerificationRun[]
    ├── Decision[]
    ├── HumanApproval[]
    ├── Review[]
    └── Event[]
```

Required correlation identifiers:

- `project_id`
- `task_id`
- `stage_id`
- `stage_run_id`
- `attempt_id`
- `harness_session_id`
- `workspace_id`
- `trace_id`, when available
- `commit_sha`, when available

Identifiers are stable and never inferred from display names.

## 9. Task contract

A task contract is the durable, versioned source of truth for execution and completion.

```yaml
id: AUTH-142
title: Refresh token rotation
goal: Add refresh-token rotation without changing existing login behavior.
acceptance:
  - id: AC-1
    criterion: A successful refresh issues a new refresh token.
  - id: AC-2
    criterion: The previous token becomes invalid.
  - id: AC-3
    criterion: Replaying the previous token returns HTTP 401.
  - id: AC-4
    criterion: Existing login behavior remains unchanged.
risk: high
profile: deep
base_ref: main
```

Minimum input fields are `id`, `title`, `goal`, at least one acceptance criterion, and `profile`. Normalization always materializes `risk` (default `medium`) and `base_ref` (default `HEAD`) before persistence.

Acceptance criteria have stable IDs so verification evidence and reviewer findings can reference them.

## 10. Plans and stages

For deep tasks, an architect runs through a native harness in read-only mode and produces a plan conforming to a versioned JSON Schema.

```json
{
  "parallelizable": true,
  "stages": [
    {
      "id": "backend",
      "goal": "Implement refresh-token persistence and rotation",
      "dependsOn": []
    },
    {
      "id": "api",
      "goal": "Update the refresh endpoint",
      "dependsOn": ["backend"]
    },
    {
      "id": "integration",
      "goal": "Integrate changes and run broad verification",
      "dependsOn": ["api"]
    }
  ]
}
```

Clew validates the schema, unique stage IDs, existing dependencies, and acyclicity before the plan can become runnable. A queued stage is runnable when all its dependencies have completed successfully and all applicable human gates are approved.

Every parallel plan must end in an integration stage before final review.

## 11. Task profiles

### 11.1 Quick

For small, local, low-risk work in a known area.

```yaml
profile: quick
scout: false
architecture: false
execution:
  mode: direct
  harness: codex
  model: luna
review: optional
```

Flow: task → branch or current workspace → worker → targeted verification → ready/human review.

### 11.2 Standard

For a normal feature or bug fix that benefits from workspace isolation.

```yaml
profile: standard
scout: auto
architecture: false
execution:
  mode: isolated
  harness: codex
  model: luna
review:
  required: true
  harness: codex
  model: sol
```

Flow: task → isolated worktree → worker → verification → review → ready.

### 11.3 Deep

For large, cross-cutting, uncertain, or high-risk work.

```yaml
profile: deep
scout: auto
architecture:
  required: true
  harness: codex
  model: sol
  read_only: true
  human_approval: true
execution:
  mode: parallel
  max_workers: 3
  harness: codex
  model: luna
qa:
  harness: opencode
  model: qwen-local
integration:
  required: true
review:
  required: true
  harness: codex
  model: sol
```

Flow: task → optional scout → architecture → plan approval → DAG workers → integration → review → ready.

`scout: auto` enables discovery for an unknown repository area, unclear blast radius, legacy code, a bug without a known cause, or a cross-service change. It remains off for known, local changes.

## 12. Lifecycle and state machines

### 12.1 Task state

```text
DRAFT → PLANNING → PLAN_READY → QUEUED → EXECUTING
                                      → VERIFYING
                                      → REVIEWING
                                      → READY
                                      → COMPLETED
```

Additional terminal or waiting states:

- `FAILED`
- `CANCELLED`
- `WAITING_FOR_HUMAN`
- `BLOCKED`

`READY` means all automated completion policy has passed and the task is ready for its configured final human action. `COMPLETED` means that final action has occurred or the profile does not require one.

### 12.2 Stage run state

```text
QUEUED
  → RUNNING
  → HARNESS_FINISHED
  → VERIFYING
  → REVIEWING
  → COMPLETED
```

Feedback paths:

```text
VERIFYING → RETRYING → RUNNING
REVIEWING → CHANGES_REQUESTED → RETRYING → RUNNING
```

`HARNESS_FINISHED` only means the native harness completed its turn. It never implies that the stage or task satisfies the contract.

All state changes are validated domain transitions and emit immutable task events.

## 13. Harness abstraction

```ts
interface CodingHarness {
  startSession(options: SessionOptions): Promise<HarnessSession>;
  run(sessionId: string, input: HarnessInput): Promise<HarnessTurn>;
  send(sessionId: string, message: string): Promise<void>;
  subscribe(sessionId: string): AsyncIterable<ClewHarnessEvent>;
  interrupt(sessionId: string): Promise<void>;
}
```

The adapter owns protocol initialization, version compatibility, lifecycle mapping, approval handling, reconnection, and raw event persistence where needed for diagnostics.

### 13.1 Codex adapter

The Codex integration must:

- launch or connect to `codex app-server`;
- initialize its structured protocol;
- create or resume threads and start turns;
- consume lifecycle, item, tool, approval, and completion events;
- treat `turn/completed` as harness completion only;
- continue an existing thread for eligible retries;
- preserve native sandbox and approval behavior;
- never scrape the Codex TUI or replace Codex with a generic model API.

### 13.2 OpenCode adapter

The OpenCode integration must:

- use the official SDK/server API;
- create, send to, abort, and inspect sessions;
- subscribe to its event stream;
- translate session, tool, permission, idle, failure, and completion events;
- pin the supported SDK/server version exactly;
- isolate all version-sensitive code inside the adapter.

### 13.3 Normalized events

At minimum, adapters emit:

```ts
type ClewHarnessEvent =
  | SessionStarted
  | TurnStarted
  | ToolStarted
  | ToolCompleted
  | VerificationDetected
  | ApprovalRequired
  | HarnessIdle
  | HarnessCompleted
  | HarnessFailed;
```

Every event carries its task, stage-run, attempt, session, source-harness, timestamp, and source-event identifiers.

## 14. Workspace management

```ts
interface WorkspaceManager {
  create(input: { taskId: string; stageId: string; baseSha: string }): Promise<Workspace>;

  remove(id: string): Promise<void>;
  status(id: string): Promise<WorkspaceStatus>;
}
```

The initial implementation, `GitWorktreeManager`, uses `spawn`/`execFile` with argument arrays and never interpolates user-controlled values into a shell command.

Default conventions:

```text
worktree: ~/.clew/worktrees/<project>/<task>/<stage>
branch:   ai/<task>/<stage>
```

Clew records the base SHA, worktree path, branch, current SHA, dirty state, and lifecycle. Removal must refuse a dirty worktree unless an explicit force policy is applied. The primary checkout must never be modified by an isolated or parallel stage.

Git worktrees isolate files and branches but not ports, databases, queues, containers, or other runtime resources. Runtime namespace isolation is deferred beyond v0.1 and must be addressed before reliable parallel integration testing.

## 15. Verification

Clew uses progressive verification:

1. **Worker iteration:** the smallest relevant check, such as one test or affected package.
2. **Worker completion:** affected tests, type-check/build scope, and task-specific browser path.
3. **Integration:** broader unit/integration suite, build, and smoke paths.
4. **Release/nightly:** full suites and expensive quality checks.

Clew should not automatically rerun a command when fresh, trustworthy evidence from the same revision and environment already satisfies the configured policy.

A verification evidence record contains:

- evidence type and scope;
- command/tool identity;
- start/end time and exit status;
- working directory/workspace;
- commit SHA and attempt ID;
- parsed result counts when available;
- related acceptance criteria;
- source event/session;
- freshness and trust status.

The agent may also return a structured verification report describing why the evidence is sufficient and why checks were skipped. This report supplements but does not replace observed tool evidence.

Interactive browser verification demonstrates current behavior. Durable Playwright tests provide regression protection. Task runs use related scenarios; smoke suites belong at integration; full E2E belongs in release/nightly policy unless explicitly required by the contract.

## 16. Review and completion policy

A reviewer evaluates:

- acceptance-criteria compliance;
- architectural correctness and invariants;
- regression and security risk;
- scope creep;
- test quality and missing evidence.

The reviewer returns a schema-validated result:

```json
{
  "verdict": "request_changes",
  "findings": [
    {
      "severity": "blocking",
      "criterion": "AC-3",
      "reason": "The previous refresh token remains valid",
      "evidence": "The replay test returned HTTP 200",
      "target": "implementation"
    }
  ]
}
```

Allowed verdicts are `pass`, `request_changes`, and `needs_human`. Blocking findings prevent completion. A separate independent completion judge is optional and reserved for critical profiles.

## 17. Failures and retries

Failures use an explicit classification:

- `IMPLEMENTATION_FAILURE`
- `TEST_FAILURE`
- `ARCHITECTURE_FAILURE`
- `ENVIRONMENT_FAILURE`
- `CONTRACT_AMBIGUITY`
- `AGENT_STUCK`
- `TOOL_FAILURE`

Default routing:

| Failure                    | Default target                |
| -------------------------- | ----------------------------- |
| Implementation             | same worker/session retry     |
| Test defect or missing QA  | QA stage                      |
| Architecture               | architect                     |
| Environment/tool transient | infrastructure retry          |
| Contract ambiguity         | human                         |
| Repeated or stuck worker   | fresh worker session or human |

Default retry policy:

```yaml
retry:
  max_attempts: 3
  simple_failure:
    reuse_session: true
  repeated_failure:
    fresh_session: true
```

Reviewer feedback is sent back through the native harness. Retrying by directly invoking the underlying model outside the harness is forbidden.

## 18. Human gates

Example policy:

```yaml
human_gates:
  architecture:
    when:
      - database_migration
      - breaking_api
      - security_tradeoff
  dependency_change:
    enabled: true
  merge:
    always: true
```

An approval records the policy trigger, proposed action, relevant diff/decision, requester, approver, timestamp, and outcome. Clew must not silently downgrade a required gate.

## 19. Scheduler and persistence

The v0.1 scheduler is local and intentionally small. It must:

- identify runnable stages from dependency and approval state;
- enforce profile concurrency limits;
- create a stage run and workspace before starting a harness;
- recover persisted non-terminal tasks after process restart;
- avoid starting the same stage run twice;
- route completion, failure, retry, and cancellation deterministically;
- serialize state changes transactionally.

SQLite stores the current projections and task event log. Minimum tables/collections correspond to the domain entities in section 8. Event payloads and schemas are versioned to allow future migration.

An external queue such as BullMQ is out of scope until multi-process or remote execution is required.

## 20. CLI v0.1

The first usable interface is a CLI.

```text
clew init
clew task create [--file task.yaml]
clew task show <task-id>
clew task list
clew plan <task-id>
clew approve <task-id> [gate-id]
clew run <task-id> [--profile quick|standard|deep]
clew status <task-id> [--watch]
clew events <task-id>
clew retry <task-id> <stage-id>
clew interrupt <task-id> [stage-id]
```

Commands that start work print the task, stage, attempt, harness session, workspace, branch, and current attention state. Machine-readable JSON output should be available for automation.

## 21. Configuration

Configuration precedence:

1. CLI flags;
2. task contract/profile overrides;
3. project configuration;
4. user configuration;
5. built-in defaults.

Project configuration must be safe to commit. Credentials, auth tokens, and user-specific absolute paths must remain outside it. Exact adapter compatibility versions are recorded and diagnosed at startup.

## 22. Safety and security requirements

- Preserve native harness sandbox and approval semantics.
- Never execute worktree operations through shell-string interpolation.
- Validate task IDs, stage IDs, branch names, refs, and filesystem paths.
- Prevent workspace paths from escaping the configured Clew worktree root.
- Never remove a dirty workspace without explicit authorization.
- Redact secrets from persisted normalized events and structured logs.
- Treat harness output and repository content as untrusted input.
- Require explicit policy approval for destructive Git operations, dependency changes when configured, and merge.
- Keep raw protocol events local by default.

## 23. Observability

The task event history is a product feature and remains inside Clew. Low-level traces are delegated to an observability backend when configured.

Correlation follows:

```text
Task → Stage → StageRun → Attempt → HarnessSession → Trace
```

Clew records duration, result, retry count, token/cost metadata when exposed, and an optional trace link. Phoenix/OpenTelemetry integration is deferred until core execution works.

## 24. v0.1 scope and acceptance criteria

v0.1 proves the architecture through two end-to-end flows.

### 24.1 Quick flow

```text
task contract
→ isolated Git worktree
→ native Codex worker turn
→ normalized lifecycle/tool events
→ captured verification evidence
→ completion policy
→ READY
```

### 24.2 Parallel flow

```text
task contract
→ native Codex architect in read-only mode
→ schema-valid plan and human approval
→ at least two independent worktrees/workers
→ integration stage
→ native Codex review
→ READY or routed retry
```

v0.1 is accepted when:

1. Codex app-server can be initialized, a thread/turn started, tool events observed, and turn completion recorded.
2. OpenCode can create a session, run a turn, stream normalized events, and report completion/failure.
3. A harness runs with its working directory set to a Clew-created worktree and does not modify the primary checkout.
4. An architect plan is validated against a versioned schema before execution.
5. The scheduler runs a dependency DAG without double-starting stages.
6. Observed verification commands are linked to the correct task, stage, attempt, workspace, and revision.
7. Harness completion cannot directly mark a task completed.
8. A blocking review finding creates a new attempt through the configured retry route.
9. Restarting Clew preserves task state and can reconcile in-flight work.
10. Every task can be explained from its persisted event history without relying on chat history.

## 25. Delivery sequence

1. **POC 1 — Codex:** app-server protocol and lifecycle events.
2. **POC 2 — OpenCode:** SDK/server session and event stream.
3. **POC 3 — Workspace:** native Git worktree lifecycle and harness `cwd` isolation.
4. **POC 4 — Architect:** read-only native harness and schema-valid plan.
5. **POC 5 — First parallel run:** plan, two workers, integration, review, retry.
6. **v0.2:** task history, richer attempts/retries, human gates, local Qwen roles.
7. **v0.3:** OpenTelemetry/Phoenix and cost/token metadata.
8. **v0.4:** task dashboard derived from real workflow friction.

## 26. Deferred decisions

The following remain deliberately open beyond v0.1:

- runtime isolation for ports, databases, queues, and containers;
- exact verification freshness/trust rules;
- PR provider and merge automation;
- dashboard technology and information architecture;
- packaging and distribution (`brew`, npm, standalone binary, or other).

The v0.1 POCs resolved the local toolchain, supported adapter versions, session resume behavior, deterministic commit integration, and retention-based worktree cleanup; those decisions are recorded in ADR/release/compatibility documents.

These decisions must not weaken the core boundary: Clew owns the task lifecycle; native harnesses own coding intelligence.
