# Clew — Product Vision

**Horizon:** long-term product direction

**Positioning:** _Bring your harness. Clew keeps the thread._

This document describes intended direction, not current guarantees. Implemented behavior is defined in [`spec.md`](./spec.md); release commitments are defined in [`ROADMAP.md`](./ROADMAP.md).

## 1. Thesis

Coding agents have sessions. Software development has Tasks. Clew connects native harness execution into one durable development thread.

As coding agents become more autonomous, the valuable coordination layer shifts above the individual agent loop:

```text
How should this agent execute?         → native coding harness
What should happen across the Task?    → Clew
```

The long-term product is a task-intelligence and flow-control layer for agentic software development.

## 2. Durable product principles

### Preserve native harnesses

Codex work runs through the native Codex harness. OpenCode work runs through the native OpenCode harness. Future adapters follow the same rule.

Clew does not replace native tool selection, context management, shell/browser behavior, approvals, sandbox, editing strategy, or session semantics.

### Task is the primary object

A Task owns the durable goal, causal history, execution attempts, human decisions, and final acceptance. Harness sessions are related execution records.

### Execution and acceptance are different

Clew may produce a result and mark it `READY`; a human decides whether it is `COMPLETED`.

Before completion, operator feedback continues the same Task. After completion, the Task is immutable and newly discovered work becomes a linked follow-up Task.

### Local-first before team mode

Clew starts as a tool a developer can run on one machine without a cloud account. Networked and team deployments extend the same model rather than replacing it.

### Integrate instead of rebuilding

Clew should integrate with native terminals, Git, CI, browsers, issue trackers, and observability backends. It should not build its own coding agent, terminal emulator, Git implementation, browser agent, trace viewer, or general RAG platform.

## 3. Target product layers

```text
Task Intelligence
Contract / causal history / memory / repository context
                    ↓
Flow Control
Planning / DAG / WIP / critical path / routing
                    ↓
Execution
Codex / OpenCode / future harnesses / local models
                    ↓
Result
Diff / revision / checks / review / operator attention
                    ↓
Human Acceptance
Continue / complete / create follow-up
                    ↓
Learning
Outcomes / failures / decisions / analytics
```

## 4. Target deployment architecture

The target architecture separates durable control from host execution while preserving a zero-service local mode.

### 4.1 Logical components

```d2
direction: right

clients: Clients {
  cli: Clew CLI
  ui: Web UI
  integrations: Integrations
}

controller: Clew Controller {
  api: HTTP / WebSocket API
  scheduler: Task Flow Engine
  thread: Task Thread Projection
  policies: Execution Policies
}

storage: Durable Storage {
  events: Append-only Events
  projections: Task Projections
  artifacts: Result Metadata
}

runner: Clew Runner {
  executor: Stage Executor
  workspace: Workspace Manager
  harnesses: Harness Manager
  sessions: Session Surface
}

native: Native Harnesses {
  codex: Codex app-server
  opencode: OpenCode server
  future: Future adapters
}

host: Host Resources {
  repositories: Git repositories
  terminals: Terminal / cmux / Agent Deck
  credentials: Harness credentials
}

clients -> controller.api: commands / queries
controller.api -> controller.scheduler
controller.scheduler -> runner.executor: stage assignment
runner.executor -> controller.api: events / heartbeats / results
controller -> storage
runner.workspace -> host.repositories
runner.harnesses -> native
runner.sessions -> host.terminals
native -> host.credentials
```

### 4.2 Local-first mode

Controller and Runner are installed together. SQLite remains the durable store and no registration flow is required.

```d2
direction: down

machine: Developer Machine {
  clew: Clew {
    controller: Controller {
      api: Local HTTP API
      scheduler: Scheduler
      thread: Task Thread Projection
    }

    runner: Built-in Runner {
      executor: Stage Executor
      workspace: GitWorktreeManager
      surface: Native Session Surface
    }

    database: SQLite
  }

  repositories: Local Repositories
  codex: Codex app-server
  opencode: OpenCode server
  terminal: Terminal / cmux / Agent Deck
}

machine.clew.controller -> machine.clew.database
machine.clew.controller -> machine.clew.runner: in-process jobs
machine.clew.runner -> machine.repositories
machine.clew.runner -> machine.codex
machine.clew.runner -> machine.opencode
machine.clew.runner -> machine.terminal: open native session
```

### 4.3 Self-hosted mode

The Controller and Web UI run in Docker. One paired Runner runs on the machine that owns repositories, native harnesses, terminal access, and credentials.

```d2
direction: right

server: Self-hosted Server {
  docker: Docker Compose {
    controller: Clew Controller {
      api: HTTP / WebSocket API
      scheduler: Scheduler
      thread: Task Thread
    }

    ui: Clew Web UI
    storage: Persistent Volume
  }
}

host: Developer Machine {
  runner: Clew Runner {
    connection: Outbound Controller Connection
    executor: Stage Executor
    workspace: Workspace Manager
    surface: Session Surface
  }

  repositories: Git Repositories
  codex: Codex app-server
  opencode: OpenCode server
  terminal: Terminal / cmux / Agent Deck
  credentials: Local Credentials
}

server.docker.ui -> server.docker.controller.api
server.docker.controller -> server.docker.storage
host.runner.connection -> server.docker.controller.api: authenticated outbound WSS
server.docker.controller.scheduler -> host.runner.executor: leased stage
host.runner.executor -> server.docker.controller.api: events / heartbeat / result
host.runner.workspace -> host.repositories
host.runner.executor -> host.codex
host.runner.executor -> host.opencode
host.runner.surface -> host.terminal
```

The first self-hosted version supports one Runner per Controller. Durable records still carry `runner_id` so a later multi-runner model does not require a data-contract break.

Pairing uses a one-time token:

```sh
clew runner register \
  --controller https://clew.example \
  --token <pairing-token>
```

The Controller does not receive the host Docker socket, arbitrary filesystem access, or harness credentials.

## 5. Target Task lifecycle

```text
DRAFT → EXECUTING → READY → COMPLETED
             │          │
             │          └── operator feedback → EXECUTING
             └── interruption → WAITING_FOR_HUMAN
```

Target semantics:

- `READY`: Clew finished the configured execution and handed the result to a human;
- `COMPLETED`: the operator accepted the result;
- `COMPLETED` is immutable;
- a post-completion problem creates another Task linked with `follow_up_of`;
- explicit operator feedback before completion continues the same Task.

Task relationships may later use typed links such as `follow_up_of`, `caused_by`, `duplicates`, `blocks`, and `related_to`.

## 6. Profiles and execution modes

Profiles describe workflow depth:

- Quick;
- Standard;
- Deep.

Execution modes describe mechanics:

- direct;
- isolated;
- parallel.

Parallel is not a profile. A Deep plan can be sequential or parallel depending on its DAG and useful parallelism.

No dedicated QA stage is planned until separate research establishes a credible testing and QA contract. During implementation, the native coding agent runs relevant checks. Human acceptance remains outside automated execution.

Native Review Bot remains part of Standard and Deep. Blocking findings route back to a worker for at most two automatic corrections after the initial implementation. Exhaustion returns the Task to a human.

Each explicit operator continuation after exhaustion grants one additional worker correction and one reviewer pass. An operator may complete despite unresolved reviewer findings; the override remains durable.

## 7. Task Thread

Task Thread is a causal projection of the append-only event log, not a second source of truth and not a copy of native chat history.

The default Thread shows meaningful events:

- Task creation and contract changes;
- plans and decisions;
- Stage and Run boundaries;
- interruptions and retries;
- structured worker summaries;
- reviewer findings;
- operator messages;
- result revisions;
- readiness and completion.

Full technical events remain available in a diagnostic view.

Operator messages are stored as full redacted text with actor, timestamp, target session/Stage, and causal links. Agent output enters the Thread only through structured plans, findings, verification summaries, and completion summaries.

## 8. Native Session UX

Clew tells the user what is happening; the native session shows how it is happening.

```text
Architect Sol       RUNNING   [Open Session]
Worker Luna         RUNNING   [Open Session]
Reviewer Sol        WAITING   [Open Session]
```

Opening a terminal is observational and interactive; it does not pause the scheduler by itself. The Session Surface capability decides whether a harness supports attach, resume, focus, or only opening a related terminal.

If the operator interrupts a native process, Clew detects the terminal harness outcome, records the interrupted Run, moves the Task to `WAITING_FOR_HUMAN`, and offers continuation.

```d2
direction: right

running: Stage RUNNING
open: Operator opens terminal
attached: Native session visible
interrupted: Native process interrupted
waiting: Task WAITING_FOR_HUMAN
continue: Operator chooses Continue
resumed: New Run / attempt

running -> open: Open Session
open -> attached: attach / resume
attached -> running: scheduler continues
attached -> interrupted: Ctrl-C / abort / process exit
interrupted -> waiting: persist interruption
waiting -> continue
continue -> resumed: resume when supported
resumed -> running
```

## 9. Future strategic capabilities

The following directions remain product hypotheses until promoted into a versioned release plan.

### Task and failure memory

Completed Tasks may produce structured outcome, failure, decision, and verification memory. Retrieval should supply relevant engineering outcomes to Scout or Architect without turning Clew into a general RAG platform.

### Cross-repository Tasks

A future Task may coordinate contract, backend, frontend, and integration Stages across several repositories. A Repository Graph may describe APIs, schemas, events, packages, and consumers.

### Task intake and autonomy

Connectors may discover candidate work from GitHub, Jira, Linear, Sentry, CI, or other sources. Discovery, deduplication, enrichment, suitability scoring, WIP limits, and human policy must precede automatic execution.

### Analytics and smart routing

Clew may compare real Task outcomes across harnesses and models: first-pass success, retries, review rejection, duration, cost, and human intervention. Smart routing should follow empirical history rather than generic benchmarks.

### Flow control

Future scheduling may consider WIP limits, review backpressure, critical path, maximum useful parallelism, queue age, bottlenecks, cost budgets, and developer attention.

### Evidence and QA research

Evidence Graphs, CI/Playwright ingestion, manual artifacts, quality policies, stale-evidence semantics, GitHub Checks, and a `Clew Verified` claim require separate research. Until that work exists, Clew must not claim automated QA authority.

### Team mode

Shared Tasks, identity, RBAC, governance, organization memory, budgets, notifications, and manager analytics are later-stage capabilities built after local and self-hosted single-user modes are stable.

## 10. Strategic differentiation

Potential long-term differentiation comes from:

1. neutral cross-harness control;
2. durable Task Thread;
3. cross-repository lifecycle coordination;
4. Task and failure memory;
5. repository-specific harness analytics;
6. smart routing and flow control;
7. carefully researched quality and evidence policies;
8. selective autonomous intake.

Worktrees, terminal panes, basic planning, browser automation, parallel agents, and PR creation are implementation capabilities or integrations, not the primary moat.

## 11. Product evolution rule

A capability moves from Vision to Roadmap only when its user outcome and boundary are understood. It moves from Roadmap to `spec.md` only after implementation and acceptance land on `main`.
