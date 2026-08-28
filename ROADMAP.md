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
- `v0.2.0`: result inspection, explicit control, completion, export, cleanup, runtime isolation, and role routing.

Implemented on `main` after `v0.2.0`:

- [`CLEW-042`](./tasks/CLEW-042.md): optional OpenTelemetry tracing;
- [`CLEW-043`](./tasks/CLEW-043.md): provider-reported usage and cost accounting.

Remaining before `v0.3.0`:

- [`CLEW-067`](./tasks/CLEW-067.md): upgrade, installed-package acceptance, packaging, release notes, and release publication.

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

### [CLEW-068](./tasks/CLEW-068.md) — Local control plane contracts

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

### [CLEW-069](./tasks/CLEW-069.md) — Local daemon and API server

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

### [CLEW-070](./tasks/CLEW-070.md) — Task Thread projection

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

### [CLEW-071](./tasks/CLEW-071.md) — React Web UI

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

### [CLEW-072](./tasks/CLEW-072.md) — Native Session Surface

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

### [CLEW-073](./tasks/CLEW-073.md) — Continue and review exhaustion handoff

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

## v0.5 — Self-hosted Controller and paired Runner

**Outcome:** a user can run the Clew Controller and Web UI in Docker while code, Git, credentials, native harnesses, and terminal access remain on one paired execution machine.

### [CLEW-075](./tasks/CLEW-075.md) — Controller/Runner split

Extract the local Runner boundary without changing Task semantics.

Scope:

- one Runner per Controller;
- outbound authenticated WebSocket connection;
- one-time pairing token and durable Runner credentials;
- capability registration;
- leased Stage assignment, heartbeat, cancellation, and result upload;
- stable `runner_id` on execution records;
- reconnect and duplicate-delivery idempotency;
- no direct Controller access to host filesystem, Docker socket, or harness credentials.

Done when:

- the same acceptance Task produces equivalent results through local in-process and remote paired Runner modes;
- disconnect cannot create a second logical Run;
- revoked credentials prevent reconnect;
- secrets and repository contents stay on the Runner unless explicitly included in a normalized result.

### [CLEW-076](./tasks/CLEW-076.md) — Docker packaging and self-hosted acceptance

Package and document the self-hosted topology.

Scope:

- Docker image and Compose example for Controller/UI;
- persistent storage and upgrade procedure;
- pairing UX in Web UI and CLI;
- TLS/reverse-proxy guidance;
- backup and restore documentation;
- installed Runner package;
- degraded network and reconnect acceptance;
- self-hosted release notes and troubleshooting.

Done when:

- a clean Docker deployment pairs one local Runner and completes a Task;
- Controller replacement with restored persistent data preserves history;
- Runner disconnect/reconnect is recoverable and auditable;
- no privileged host mount is required by the Controller container.

### v0.5 release gate

1. Local-first mode remains supported and simpler than self-hosting.
2. Docker deployment is reproducible from published artifacts.
3. Pairing credentials are rotatable and revocable.
4. Controller/Runner transport survives reconnect and duplicate delivery.
5. A Controller compromise does not automatically expose host credentials or arbitrary filesystem access.
6. One-Runner scope is explicit; multi-runner scheduling remains deferred.

## Research queue after v0.5

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
