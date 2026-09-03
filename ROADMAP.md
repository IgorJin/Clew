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

- `v0.6.0`: Controller/Runner transport and durable leases with one preconfigured Runner.

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

## v0.8 — Agent Change Visibility

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

Consolidate Changes in the task header, adopt a proven open-source diff surface, move next-step details into the selectable stepper, remove duplicate waiting notices, fix editor launching, and restore newest-first task ordering.

### [CLEW-091](./tasks/CLEW-091.md) — v0.8 acceptance and release

Complete migration, Git change matrix, viewer fallback, retry/restart, worktree/runner-local, no-auto-merge, documentation, and installed-package acceptance for v0.8.

### v0.8 execution order and release gate

```text
CLEW-087 → (CLEW-088 + CLEW-089) → CLEW-092 → CLEW-091
```

The v0.7 scope remains unchanged. Worktree results are transferred to the target branch manually through merge, cherry-pick, or PR; `Complete` does not merge or push automatically.

## Research queue after v0.8

These topics require discovery before release commitment:

1. automated testing and QA responsibilities;
2. Evidence Graph, manual artifacts, CI/Playwright ingestion, and quality policies;
3. Task and failure memory;
4. cross-repository Tasks and Repository Graph;
5. task intake, enrichment, and autonomy scoring;
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
