# Clew — Product Roadmap

**Baseline:** current `main`

This document contains planned release outcomes. Implemented guarantees live in [`spec.md`](./spec.md); long-term hypotheses live in [`VISION.md`](./VISION.md).

## Planning rules

- Keep releases centered on a user-visible outcome.
- Prefer a small number of substantial, well-described work packages.
- Preserve native coding harnesses.
- Keep local-first operation independent of hosted services.
- Treat `READY` as execution handoff and `COMPLETED` as explicit human acceptance.
- Do not add formal QA/evidence policy before dedicated research.
- Move a capability into `spec.md` only after it is implemented on `main`.

## Current baseline

Released:

- `v0.1.0`: native harness integration and durable local task engine;
- `v0.2.0`: result inspection, explicit control, completion, export, cleanup, runtime isolation, and role routing;
- cumulative `v0.5.0`: telemetry and usage accounting, local daemon/API, Task Thread, Web UI, continuation, and interactive Codex terminal lifecycle.

Next target:

- Scout v0: a bounded read-only repository context experiment for one Task (`CLEW-123` → `CLEW-126`).

## v0.3 — Explainable execution economics

**Outcome:** a developer can correlate a Task with optional traces and inspect an honest lifecycle usage/cost summary without making observability a runtime dependency.

### Included

- optional OpenTelemetry runtime and OTLP export;
- stable Task/Run trace correlation;
- collector failure isolation;
- idempotent native-turn usage records;
- explicit complete, partial, and unknown usage;
- immutable pricing snapshots and decimal cost projection;
- complete lifecycle totals across Stages and attempts;
- lossless v0.2 database upgrade;
- installed-package and tarball acceptance;
- release documentation and `v0.3.0` tag.

### Excluded

- daemon and Web UI;
- remote Runner;
- Task Thread UX;
- formal QA/evidence policies;
- memory, cross-repository coordination, and autonomous intake.

### Release gate

1. `CLEW-042`, `CLEW-043`, and `CLEW-067` acceptance criteria pass.
2. Existing v0.2 lifecycle tests remain green.
3. Telemetry-disabled execution requires no OpenTelemetry packages or collector.
4. Collector failure cannot alter Task state or accepted revision.
5. Usage remains idempotent and missing data remains explicit.
6. A clean v0.2 database upgrades losslessly.
7. A clean tarball exposes the documented version and commands.
8. CI passes on `main` and the release tag.

Detailed release evidence remains in [`RELEASE-0.3.md`](./RELEASE-0.3.md).

## v0.4 — Local control plane UX

**Outcome:** Clew becomes a local background service with a Task-oriented UI while native coding sessions remain directly accessible in the user's terminal.

The release starts with one contract-first package. After it lands, daemon, Thread projection, Web UI, native sessions, and continuation can be developed in parallel.

```text
CLEW-067
    ↓
CLEW-068
    ├── CLEW-069  Local daemon
    ├── CLEW-070  Task Thread projection
    ├── CLEW-071  Web UI
    ├── CLEW-072  Native Session Surface
    └── CLEW-073  Continue and review handoff
              ↓
          CLEW-074  v0.4 release
```

### [CLEW-068](./tasks/done/CLEW-068.md) — Local control plane contracts

Define stable boundaries before parallel runtime and UI work begins.

Scope:

- versioned HTTP and WebSocket API schemas;
- command, query, response, and error envelopes;
- event-stream cursor, ordering, reconnect, and replay semantics;
- daemon identity and exclusive scheduler ownership contract;
- Task Thread item and pagination schemas;
- operator-message, continuation, review-exhaustion, and operator-override records;
- capability-based Session Surface contract;
- migration for new durable records;
- secret-safe JSON fixtures for Quick, retrying Standard, parallel Deep, interruption, and human handoff.

Out of scope: daemon runtime, UI, terminal launch, and changing existing Task behavior.

Done when:

- schemas and runtime validators agree;
- fixtures cover every v0.4 command and projection boundary;
- compatibility and unknown-field behavior are documented;
- downstream packages can build against fixtures without importing each other's implementation.

### [CLEW-069](./tasks/done/CLEW-069.md) — Local daemon and API server

Build a single-user local Controller with an in-process Runner.

Scope:

- explicit `clew daemon start`, `status`, and `stop` lifecycle;
- loopback-only `127.0.0.1` HTTP and WebSocket server;
- generated local bearer token stored outside project config;
- exclusive SQLite and Scheduler ownership;
- command/query handlers for existing CLI operations;
- live event streaming with reconnect cursors;
- API-backed CLI client and clear daemon-unavailable diagnostics;
- restart reconciliation without duplicate Runs or turns;
- migration path from direct CLI operation;
- no account, Docker, remote service, or Runner registration.

Done when:

- existing Quick, Standard, and Deep acceptance passes through the API-backed CLI;
- only one daemon can own a state directory;
- non-loopback binding is rejected;
- unauthenticated local requests are rejected;
- daemon restart preserves Task state and does not duplicate native execution.

### [CLEW-070](./tasks/done/CLEW-070.md) — Task Thread projection

Build a deterministic causal read model over the existing append-only event log.

Scope:

- curated Thread items for contracts, plans, decisions, Runs, retries, findings, structured summaries, operator actions, revisions, readiness, and completion;
- causal links back to source events and records;
- full redacted operator messages;
- separate diagnostic event query;
- stable ordering, pagination, and reconnect cursors;
- projection rebuild after restart or migration;
- query API independent of presentation technology;
- no native chat copy, Evidence Graph, or QA verdict.

Done when:

- a retrying Standard Task and parallel Deep Task produce deterministic Threads;
- rebuilding from the same event log produces byte-equivalent ordered items;
- every Thread item identifies its durable source;
- projection failure cannot mutate execution state.

### [CLEW-071](./tasks/done/CLEW-071.md) — React Web UI

Build the first Task-oriented UI against `CLEW-068` fixtures while backend packages proceed independently.

Technology:

- React;
- TypeScript;
- Vite;
- production assets served by the local daemon;
- no server-side rendering requirement.

Scope:

- Task list and attention state;
- Task Thread;
- contract, plan, Stages, Runs, attempts, revisions, and structured summaries;
- reviewer findings and exhausted-attempt explanation;
- result inspection and operator completion;
- controls for Continue and Open Session;
- authenticated API client and WebSocket reconnect;
- loading, disconnected, empty, failed, `READY`, and `WAITING_FOR_HUMAN` states;
- no embedded terminal, native chat transcript, or formal QA dashboard.

Done when:

- fixture-driven UI development runs without daemon implementation;
- final integration consumes the `CLEW-070` query API without schema changes;
- reload/reconnect preserves Thread order and selected Task;
- operator actions show confirmation, attribution, and resulting durable state.

### [CLEW-072](./tasks/done/CLEW-072.md) — Native Session Surface

Open the native coding session behind Architect, Worker, or Reviewer without replacing its terminal UX.

Scope:

- capability-based `SessionSurface` interface;
- required plain-terminal implementation;
- required Codex `resume` integration spike and supported path;
- correct session ID and workspace selection;
- opening a session does not pause or steal scheduler ownership;
- native process exit/interruption detection where the harness exposes it;
- `NoneSurface` fallback and explicit unsupported capability;
- OpenCode attach, cmux, and Agent Deck remain optional follow-ups behind the same interface.

Done when:

- a user can open the correct Codex Architect, Worker, or Reviewer session in a normal terminal;
- opening a session does not duplicate a turn;
- unsupported surfaces degrade explicitly;
- conformance fixtures cover attach/resume, detach, stale session, and process interruption.

### [CLEW-073](./tasks/done/CLEW-073.md) — Continue and review exhaustion handoff

Make operator continuation a first-class durable workflow independent of the Web UI.

Scope:

- `clew continue TASK --message ...` from `READY` or `WAITING_FOR_HUMAN`;
- full redacted operator message with actor, target Stage/session, and causal link;
- one new Run/attempt per continuation;
- native session resume when supported and a fresh session otherwise;
- at most three automatic Worker attempts: initial implementation plus two corrections;
- reviewer pass after each correction;
- exhausted correction limit transitions to `WAITING_FOR_HUMAN` with remaining findings and explanation;
- each explicit continuation grants one additional correction and one reviewer pass;
- operator completion with unresolved findings records an override and immutable finding snapshot.

Done when:

- continuation survives restart without duplicate attempts;
- exhausted retries never loop automatically;
- human feedback reaches the intended worker context;
- `READY`, `WAITING_FOR_HUMAN`, and completion override semantics are covered in CLI and scheduler tests.

### [CLEW-074](./tasks/CLEW-074.md) — v0.4 upgrade, acceptance, and release

Integrate the parallel packages and publish the local control plane.

Scope:

- upgrade fixture from v0.3;
- installed-package acceptance;
- API-backed Quick, Standard, and Deep workflows;
- daemon ownership, restart, and WebSocket reconnect matrix;
- Task Thread rebuild and UI production build;
- continuation, review exhaustion, interruption, and operator override flows;
- optional live Codex native-session smoke;
- documentation, tarball, CI, release notes, and `v0.4.0` tag.

Done when every v0.4 release gate is reproducible from a clean installed package.

### v0.4 release gate

1. Local daemon installation requires no hosted service.
2. Existing CLI workflows operate through the daemon without semantic regression.
3. Task Thread is a deterministic projection, not a second event store.
4. Web UI explains current work and human attention without reproducing the native terminal.
5. Codex native-session opening is acceptance-tested; unsupported harness/surface combinations degrade explicitly.
6. Review exhaustion reliably returns control to a human.
7. `READY` remains execution handoff; only an operator creates `COMPLETED`.

## v0.5 — Interactive Codex terminal

**Outcome:** daemon-run Codex workers remain directly interactive while Clew observes completed turns, projects safe responses into Task Thread, and waits for an explicit operator finish before verification.

Included work:

- [`CLEW-078`](./tasks/done/CLEW-078.md): read-only native turn monitoring;
- [`CLEW-079`](./tasks/done/CLEW-079.md): durable worker responses and live operator-attention UI;
- [`CLEW-077`](./tasks/done/CLEW-077.md): integrated terminal lifecycle acceptance and release sign-off.

### v0.5 release gate

1. The Codex TUI remains the sole writer for the native worker thread.
2. Completed turns appear once in Task Thread without terminal escape sequences or hidden reasoning.
3. Follow-up turns clear and restore operator-waiting state correctly.
4. `Finish worker` remains the only handoff to verification.
5. Restart, reconnect, duplicate suppression, package installation, and the production UI build pass.

## v0.6 — Controller/Runner transport and leases

**Outcome:** Controller and one Runner operate as separate authenticated processes with durable leased execution, while local-first mode remains unchanged. This release proves the distributed correctness boundary without Docker or pairing UX.

The v0.6 Runner uses one preconfigured identity and pre-shared credential. Terminal processes stay local to the Runner host; Clew does not proxy PTY bytes through Controller.

```text
CLEW-082  protocol contracts
    ├── CLEW-083  Runner process + outbound transport
    └── CLEW-084  Controller gateway + lease authority
                 ↓
             CLEW-085  paired delivery + recovery
                 ↓
             CLEW-086  v0.6 acceptance + release
```

### [CLEW-075](./tasks/done/CLEW-075.md) — v0.6 work package

The parent work package defines ownership, protocol guarantees, lease semantics, security boundaries, complete acceptance criteria, and release scope. It is complete only when `CLEW-082`–`086` pass.

### [CLEW-082](./tasks/done/CLEW-082.md) — Protocol contracts

Freeze versioned envelopes, identities, compatibility, lease transitions, fencing, transport security, payload bounds, and the Controller/Runner data allowlist.

### [CLEW-083](./tasks/done/CLEW-083.md) — Runner process and outbound transport

Build the Runner service, authenticated outbound WebSocket, registration, heartbeat, reconnect, durable outbox, inbound idempotency, and local execution/session ownership.

### [CLEW-084](./tasks/done/CLEW-084.md) — Controller gateway and lease authority

Build the authenticated Runner gateway, durable lease/epoch state, fencing, health projection, restart reconciliation, and local-or-paired Scheduler execution port.

### [CLEW-085](./tasks/done/CLEW-085.md) — Paired execution delivery and recovery

Integrate separate Controller and Runner processes through Quick, Standard, and Deep flows, cancellation, duplicate/reordered delivery, restart, reconnect, explicit ambiguous-loss recovery, and Runner-local terminal capability.

### [CLEW-086](./tasks/done/CLEW-086.md) — v0.6 transport release acceptance

Own the v0.5 migration, clean installed paired acceptance, fault matrix, security/package inspection, local regression proof, optional Runner-host Codex smoke, release notes, CI, tag, and publication.

### v0.6 release gate

1. One authenticated Runner registers outbound with stable identity, compatible versions, capabilities, and workspace mappings.
2. Local and paired fake-harness Quick, Standard, and Deep produce equivalent canonical outcomes.
3. Every remote Stage has one durable lease identity and epoch; stale or replayed messages cannot mutate canonical state.
4. Disconnect and restart at every lease boundary never cause automatic duplicate execution.
5. Ambiguous Runner loss becomes an explicit recovery state rather than silent reassignment.
6. Controller receives no Runner/harness credentials, arbitrary repository files, environment values, or PTY bytes.
7. Local-first mode remains the default and its existing release gates stay green.
8. The release explicitly documents pre-shared credentials, one Runner, Runner-local terminal access, no Docker, and no failover.

## v0.7 — Pairing operations and self-hosted packaging

**Outcome:** a user can deploy Controller/UI with Docker, pair one local Runner through an operator-friendly credential lifecycle, and preserve history across upgrades and backup/restore.

### [CLEW-080](./tasks/CLEW-080.md) — Runner pairing and credential operations

Add single-use pairing codes, pair/status/rotate/revoke/replace operations, CLI/UI health views, restrictive credential storage, and restart-safe revocation.

### [CLEW-076](./tasks/CLEW-076.md) — Docker packaging and deployment operations

Add the Controller/UI image, Compose, persistent volumes, pairing integration, TLS/reverse-proxy guidance, backup/restore, installed Runner guidance, and deployment diagnostics.

### [CLEW-081](./tasks/CLEW-081.md) — v0.7 self-hosted acceptance and release

Own the v0.6 migration, clean Docker deployment, pairing/revocation, upgrade, backup/restore, image/package inspection, release notes, CI, and publication.

### v0.7 release gate

1. Local-first and preconfigured paired modes remain supported.
2. Docker deployment is reproducible from published artifacts.
3. Pairing credentials are single-use, rotatable, revocable, and secret-safe.
4. Controller replacement with restored data preserves history and Runner trust state.
5. No privileged host mount, Docker socket, repository root, or harness credential is required by Controller.
6. One-Runner scope remains explicit; multi-Runner scheduling stays deferred.

## v0.8 — Agent Change Visibility (completed 2026-09-04)

**Outcome:** Operators can inspect exactly what each agent changed in its persisted worktree, open that worktree in an editor, or review a run-scoped unified diff without implicit merge or push behavior.

### [CLEW-087](./tasks/CLEW-087.md) — Persist immutable run Git provenance

Store each run's base SHA and branch with safe migration and explicit unavailable recovery for legacy runs.

### [CLEW-088](./tasks/CLEW-088.md) — Implement Git change inspection service

Provide read-only summary, file list, and patch inspection relative to the persisted run baseline, including committed, staged, unstaged, untracked, binary, rename, empty-diff, remote-worktree, and runner-local cases.

### [CLEW-089](./tasks/CLEW-089.md) — Add extensible change-viewer adapters

Add `task open-changes --run` with explicit viewer configuration, Cursor-first then VS Code fallback, and worktree-path copying. No merge or push is performed.

### [CLEW-090](./tasks/CLEW-090.md) — Show per-agent Changes in the Web UI

Superseded by CLEW-092 after workflow review rejected per-agent placement in favor of one task-level Changes control.

### [CLEW-092](./tasks/CLEW-092.md) — Refine task activity and change-review UX

Consolidate Changes in the task header, use the ADR-selected dependency-free diff surface, move next-step details into the selectable stepper, remove duplicate waiting notices, fix editor launching, and restore newest-first task ordering.

### [CLEW-091](./tasks/CLEW-091.md) — v0.8 acceptance and release

Complete migration, Git change matrix, viewer fallback, retry/restart, worktree/runner-local, no-auto-merge, documentation, and installed-package acceptance for v0.8.

### v0.8 execution order and release gate

```text
CLEW-087 → (CLEW-088 + CLEW-089) → CLEW-092 → CLEW-091
```

The v0.7 scope remains unchanged. Worktree results are transferred to the target branch manually through merge, cherry-pick, or PR; `Complete` does not merge or push automatically.

## v0.9 — Task Finalization Workflow (completed 2026-09-08)

**Outcome:** Operators can move a task from agent completion through verification and review into an explicit, auditable finalization gate, then integrate local Git changes and record release evidence without implicit merge or deployment side effects.

### [CLEW-093](./tasks/CLEW-093.md) — Task screen v3 and finalization workflow

Delivered the prototype-based Task Screen v3, task-level actions, current-stage and agent-runtime surfaces, responsive mobile action bar, Finalization Gate, lifecycle states, local Git integration, conflict handling, cleanup eligibility, and `MERGED → RELEASED` separation.

### v0.9 execution order and release gate

```text
lifecycle contracts → Finalization Gate → Git integration → Task Screen v3 → responsive acceptance → release sign-off
```

Release evidence is recorded in [`RELEASE-0.9.md`](./RELEASE-0.9.md). External deployment detection, cloud PR providers, and automatic merge/push remain outside the release boundary.

## v0.10 — Keyboard-first controls

**Outcome:** An operator can switch among the first ten visible Tasks, continue work, inspect changes, and reach embedded or external terminals without leaving the keyboard. Holding Command reveals the shortcuts available in the current context.

This is a focused UI mini-release. The existing UI-only Agent settings slice ships with it but does not connect plugins to execution.

### [CLEW-099](./tasks/done/CLEW-099.md) — Settings modal with Agent chapter

Complete review of the existing UI-only connection preference and preserve its explicit unverified/not-applied boundary.

### [CLEW-101](./tasks/done/CLEW-101.md) — Shortcut registry and numbered task navigation

Create one scoped shortcut registry and map `Cmd/Option+1…0` to the first ten Tasks in the current rendered sidebar order, including browser-conflict handling and input/terminal scope rules.

### [CLEW-102](./tasks/done/CLEW-102.md) — Contextual task, changes, and terminal shortcuts

Add `Cmd+Enter`, internal/external Changes shortcuts, and embedded/external terminal shortcuts through the existing action handlers. Present one Continue action while keeping Finish worker explicit.

### [CLEW-103](./tasks/done/CLEW-103.md) — Command key hints and shortcut discovery

Show accessible key badges while Command is held, reset the overlay safely, and expose the same registry through shortcut help.

### [CLEW-104](./tasks/done/CLEW-104.md) — v0.10 acceptance and release

Own browser-reserved-key validation, embedded-terminal conflicts, accessibility and layout acceptance, full repository checks, installed-package verification, versioning, and release evidence.

### v0.10 execution order and release gate

```text
CLEW-099 ──────────────────────┐
CLEW-101 → (CLEW-102 + CLEW-103) → CLEW-104
```

Release gate:

1. Number shortcuts always match the visible filtered and sorted Task list; unavailable positions do nothing.
2. Inputs, dialogs, browser behavior, and xterm retain their expected keyboard semantics.
3. Continue chooses resume or fresh execution through existing policy and can never trigger Finish worker, merge, or release.
4. Internal and external Changes target the same selected run; terminal shortcuts target the same selected session and respect Controller/Runner locality.
5. Key hints are discoverable, accessible, responsive, and cannot remain stuck after blur or application switching.
6. UI tests, backend regressions, production build, installed-package acceptance, and release documentation pass.

## Planned first — Minimal Scout

[Scout v0](./docs/SCOUT.md) is the first context experiment after the active keyboard mini-release. One explicit read-only run investigates one repository revision for one Task and saves a bounded source-linked context map. It uses existing harnesses and local JSON files.

- [CLEW-123](./tasks/done/CLEW-123.md), S: RepositoryContext contract and fixtures (complete).
- [CLEW-124](./tasks/done/CLEW-124.md), M: read-only execution, CLI, and local result (complete).
- [CLEW-125](./tasks/done/CLEW-125.md), M: initial architect/worker consumption through existing briefs (done).
- [CLEW-126](./tasks/done/CLEW-126.md), S: pilot on three tasks and contract refinement (done).

Execution order: 123 → 124 → 125 → 126 → 114 → 115. CLEW-123–126 are complete; CLEW-114 also requires its storage dependencies. CLEW-105–113 can proceed independently. The scout release assignment remains unassigned.

Scout is intended to expand later into reusable repository memory, incremental updates and additional requests during execution. The form of that memory remains open; those extensions are not prerequisites for this minimal slice.

## Planned — Bounded Task data and resumable context

Release assignment is pending; v0.10 is signed off locally and Scout v0 is the next selected experiment. [Task data lifecycle](./docs/TASK-DATA-LIFECYCLE.md) defines an implementation queue of 18 S/M cards, all planned:

- CLEW-105–110: storage contracts, measured usage, local artifact writes, compression, normalized events, and diagnostic budgets;
- CLEW-111–113: bounded HTTP queries, WebSocket flow control, and incremental Task Thread;
- CLEW-114–115: versioned checkpoints and bounded role handoff, after the required CLEW-126 scout pilot;
- CLEW-116–118: prune preview, race-safe quarantine/GC, and separate SQLite maintenance;
- CLEW-119–122: consistent export/restore checks, resumable legacy migration, storage UI, and scale/recovery acceptance.

Exact dependencies and acceptance criteria live in the [task index](./tasks/README.md). Canonical facts and evidence remain protected after export. The first backend is local on each execution host; Runner v1 data permissions remain unchanged. Formal QA policy and cross-host blob transfer are separate work.

## Plugin architecture epic

The [Plugin architecture and implementation plan](./docs/PLUGIN-ARCHITECTURE.md) is split into cards [CLEW-127 through CLEW-133](./tasks/README.md), running in parallel with the Scout and storage queues (release unassigned).

Scope decision of 2026-09-11: Codex and OpenCode runtimes only. Claude Code, marketplace/hot reload, metrics and log export, external-CLI live smoke, and the workflow constructor are excluded from this epic; telemetry is limited to extracting the existing OTel traces flow into a `TelemetrySink` plugin. Execution order: `CLEW-127 → (CLEW-128 + CLEW-129) → CLEW-130 → CLEW-131 → CLEW-133`, with `CLEW-132` after `CLEW-127`.

## Research queue after v0.10

The six product directions reviewed on 2026-09-10 are tracked in [Development directions](./docs/DEVELOPMENT-DIRECTIONS.md), with links to the plugin proposal and research placeholders. This records intent without assigning releases or implementation commitments.

These topics require discovery before release commitment:

1. automated testing and QA responsibilities;
2. Evidence Graph, manual artifacts, CI/Playwright ingestion, and quality policies;
3. Task and failure memory beyond the scoped [checkpoint and retention implementation queue](./docs/TASK-DATA-LIFECYCLE.md);
4. cross-repository Tasks and Repository Graph;
5. [Project Inbox V1 and Task Shaping](./docs/TASK-CANVAS.md): project-level text intents, explicit analysis, and confirmed Create / Attach / Mark resolved proposals at the Clew edge; execution begins from a validated Task Contract. Free-form canvas, attachments, and autonomous intake remain later extensions;
6. harness analytics and empirical routing;
7. WIP limits, backpressure, critical path, and attention scheduling;
8. GitHub Checks and public verification surfaces;
9. multi-runner and team mode.

## Explicitly deferred

- automatic merge;
- autonomous completion;
- a Clew-owned QA verdict;
- a proprietary PR reviewer;
- a custom coding-agent loop;
- terminal emulation;
- general-purpose RAG;
- RBAC and organization analytics before single-user self-hosting is stable.
