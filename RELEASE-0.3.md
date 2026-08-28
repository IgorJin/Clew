# Clew v0.3 release plan — Explainable execution economics

**Status:** `CLEW-042` in progress

**Target:** `v0.3.0`

## Product outcome

Clew v0.3 makes a completed or failed task observable without replacing Clew's durable event history. A developer can follow one task into an OpenTelemetry-compatible backend, correlate task/stage/run/harness activity, and see an honest token and cost summary using only usage reported by the native harness or provider.

Phoenix is the documented reference backend, while OTLP is the compatibility boundary. Observability remains optional: a missing, slow, or unavailable collector must never change task execution, retry, verification, completion, or cleanup semantics.

## Release boundaries

Included:

- versioned trace-correlation and usage/cost contracts;
- persisted trace identifiers and links back to an optional backend;
- task, stage, run, harness, review, verification, export, and completion spans;
- OTLP export with bounded buffering, timeouts, redaction, and explicit diagnostics;
- a reproducible local Phoenix setup and smoke procedure;
- normalized provider-reported input, output, cache, and reasoning token metadata;
- decimal cost records with currency, source, pricing provenance, and unknown-value handling;
- task/run/role/model aggregation in stable JSON and concise human output;
- lossless v0.2 database upgrade, offline acceptance, installed-package checks, and release evidence.

Not included:

- making Phoenix or any collector a runtime dependency for normal Clew operation;
- storing raw prompts, completions, tool payloads, secrets, or source files in spans;
- estimating token counts when adapters do not report them;
- silently applying current public model prices to historical runs;
- budgets, quotas, alerts, billing, chargeback, or optimization recommendations;
- dashboard UI, remote scheduling, PR automation, or infrastructure provisioning.

## Data and correlation contract

Every exported span uses stable Clew identifiers rather than display names:

```text
Task
└── Stage
    └── Run / Attempt
        ├── Harness session / turn
        ├── Verification
        └── Review
```

The minimum correlation fields are `task_id`, `stage_id`, `run_id`, `attempt`, `profile`, `role`, `harness`, `workspace_id`, `commit_sha`, `session_id`, and `turn_id` when available. Trace and span identifiers are persisted before export so a restart cannot create a second logical trace for the same run.

Usage records distinguish `reported`, `derived`, and `unknown` values. v0.3 permits provider-reported token counts and deterministic arithmetic such as totals; it does not permit guessed tokenization. A cost record must carry the usage record, model identity, currency, decimal amount, pricing source, pricing version/effective date, and calculation timestamp. Unknown model identity, price, or usage produces an explicit unknown cost rather than zero.

## Work packages

### CLEW-042 — Observability contract and OTLP/Phoenix integration

**Objective:** expose a faithful, optional trace of the existing durable lifecycle.

Scope:

- publish versioned trace-context, span-attribute, exporter-status, and trace-link schemas with runtime validators and fixtures;
- add a transactional migration for trace identity/export state without copying the full event log into a second local store;
- instrument lifecycle boundaries for task, stage, run/attempt, harness session/turn, verification, review, retry, export, completion, interruption, and failure;
- persist correlation before sending and restore it after restart;
- implement an OTLP exporter with bounded queue size, flush timeout, retry/backoff limits, and process-exit flush;
- make exporter failures visible through diagnostics and local events while keeping task state unchanged;
- redact attributes through the existing secret boundary and enforce an allowlist that excludes prompts, completions, tool arguments/results, environment values, and repository contents;
- document and test a local Phoenix connection through standard OTLP configuration.

Implementation slice:

1. Keep the Clew core free of OpenTelemetry runtime dependencies and expose a no-op-safe observer boundary from `Store.appendEvent`.
2. Add migration 010 for task trace context, run span context, and bounded exporter bookkeeping.
3. Install the official trace-only runtime into `.clew/telemetry` with `clew telemetry install`; load it only when telemetry is enabled.
4. Convert allowlisted durable lifecycle events into task, stage-run, and short event spans; persist contexts before export.
5. Add `telemetry status`, an optional `doctor` check, redaction tests, missing-runtime tests, and the collector failure matrix.

Out of the implementation slice: custom OTLP encoding, automatic instrumentation of arbitrary Node modules, metrics/logs exporters, raw prompt/tool capture, and making a collector a prerequisite for execution.

Acceptance:

1. A fake collector reconstructs one Quick and one retrying Deep trace with stable parent/child relationships and no duplicate run spans after restart.
2. Collector absence, timeout, malformed responses, queue overflow, and shutdown preserve the same task result as observability-disabled execution.
3. Security fixtures prove secrets and raw content never cross the exporter boundary.
4. `doctor` explains disabled, healthy, degraded, and misconfigured exporter states without exposing credentials.
5. A live optional Phoenix smoke links a Clew task to its trace, or records an explicit environmental skip reason.

### CLEW-043 — Usage, token, and cost accounting

**Objective:** answer "what did this task consume?" without pretending incomplete provider data is exact.

Scope:

- publish a versioned usage/cost schema covering provider, model, harness, role, task/stage/run/attempt, token categories, timestamps, source, and completeness;
- normalize Codex and OpenCode usage only where their supported protocols expose reliable fields, preserving unknown fields and provider diagnostics;
- persist usage records idempotently so event replay, session resume, and restart do not double-count them;
- support decimal multi-currency cost records with explicit pricing provenance; a daily external cron invokes an idempotent pricing-sync command against configured provider/catalog APIs, while credentials and user-specific paths remain outside committed config;
- persist immutable pricing snapshots with source, fetched time, effective time, checksum, and freshness state; a failed sync keeps the last snapshot and marks it stale instead of silently repricing history;
- aggregate by task, stage, run, role, harness, and model while keeping unknown and mixed-currency totals separate;
- add `clew task usage TASK [--stage STAGE] [--attempt N] [--json|--human]` and include a compact usage summary plus trace link in `task result`;
- report one lifecycle total for the task across all attempts, retries, stages, sessions, and turns, with a currency breakdown and an explicit unknown/partial remainder;
- export usage and cost provenance in the final result manifest without changing completion trust rules.

Implementation phases:

1. **Usage capture:** normalize one idempotent record per native turn, linked to task/stage/run/attempt/session/turn, preserving reported, partial, and unknown values without storing raw prompts or completions.
2. **Pricing sync:** add a provider-agnostic catalog source interface and `clew pricing sync`; the caller schedules it daily with cron. Provider-specific APIs are adapters, not hardcoded assumptions. Manual/local catalog input remains the fallback where a provider has no pricing API.
3. **Cost projection:** calculate decimal costs from the usage record plus the immutable price snapshot, aggregate the complete task lifecycle, and expose stable JSON/human output and manifest provenance.

Acceptance:

1. Adapter fixtures cover complete usage, partial usage, missing usage, cached/reasoning tokens, unknown models, changed pricing, and mixed currencies.
2. Aggregates equal the underlying idempotent records across retry, resume, restart, and Deep parallel execution.
3. Missing data renders as unknown/partial and never as a fabricated zero.
4. A scheduled pricing sync is idempotent, records source/freshness/checksum, and preserves the previous snapshot on API failure.
5. Historical cost remains reproducible from its recorded pricing snapshot when a pricing catalog changes later.
6. Human and JSON output agree, show the total for the complete task lifecycle, and require no direct SQLite or backend access.

### CLEW-067 — v0.3 upgrade, acceptance, and release

**Objective:** prove that observability adds insight without becoming a correctness or availability dependency.

Scope:

- build a real v0.2 → v0.3 migration fixture preserving tasks, runs, evidence, completions, manifests, and event explainability;
- run installed-package acceptance with observability disabled, with a fake OTLP collector, with collector failure, and with partial/missing usage;
- cover Quick, Standard, and Deep flows, retry/resume, restart reconciliation, export, completion, and cleanup;
- verify bounded resource behavior under event bursts and process shutdown;
- document configuration precedence, security boundary, data retention, troubleshooting, Phoenix setup, pricing provenance, known adapter limitations, and supported versions;
- produce release notes, a clean tarball smoke, and optional live Codex/OpenCode/Phoenix evidence.

Acceptance:

1. v0.2 data upgrades losslessly and all prior v0.2 acceptance remains green.
2. Enabled and disabled observability produce identical lifecycle states and accepted revisions.
3. The installed CLI can trace and summarize one task without source-checkout assumptions.
4. Package contents contain schemas and migration evidence but no credentials or generated telemetry data.
5. GitHub Actions passes on `main` and `v0.3.0`; the release artifact exposes the documented version and commands.

## Candidate sequence

### v0.3.0-alpha.1 — correlation and failure isolation

Task: `CLEW-042` through schemas, persistence, fake collector, and failure-path acceptance.

Exit gate: traces are restart-stable, secret-safe, structurally valid, and cannot affect task state.

### v0.3.0-beta.1 — honest execution economics

Tasks: remaining `CLEW-042` plus `CLEW-043`.

Exit gate: supported adapters produce idempotent usage records, unknown data stays explicit, aggregates are reproducible, and task result links to traces.

### v0.3.0-rc.1 — upgrade and packaging

Task: `CLEW-067`.

Exit gate: v0.2 upgrade, installed-package acceptance, degraded collector behavior, documentation, and optional live Phoenix smoke are reproducible.

## Final v0.3.0 gate

The final tag may be created only when:

1. All three work packages meet their acceptance criteria.
2. Existing v0.2 lifecycle and security tests remain green.
3. Observability-disabled execution adds no required external service or credential.
4. Exporter failure cannot change task state, accepted revision, or cleanup policy.
5. Trace correlation survives retry, parallel stages, and restart without duplication.
6. Usage aggregation is idempotent and labels incomplete data honestly.
7. Historical costs are reproducible from stored provenance and never silently repriced.
8. A clean v0.2 database upgrades and a clean tarball install passes acceptance.
9. GitHub Actions passes on `main` and the release tag.

## Decisions fixed for this release

- The SQLite event history remains Clew's source of truth; traces are a correlated diagnostic projection.
- OTLP is the integration boundary and Phoenix is the documented reference backend.
- Export is opt-in and best-effort with bounded local resources; task correctness never depends on collector availability.
- Span attributes use an allowlist. Raw prompts, completions, tool payloads, environment values, and repository content are excluded.
- Provider-reported usage is preferred; absent usage remains unknown. v0.3 does not add a tokenizer-based estimator.
- Money uses decimal strings plus ISO currency, never binary floating-point.
- Provider/catalog API pricing sync is opt-in and caller-scheduled; a provider without a usable pricing API can use an explicit local catalog.
- Recorded pricing snapshots freeze historical calculations; a failed daily sync retains the last snapshot and exposes stale freshness.
- The primary cost number is the complete task lifecycle total, with stage/run/attempt/turn breakdowns available for explanation.

## Risks to retire first

1. Prove exporter failure isolation before broad instrumentation.
2. Fix correlation and idempotency contracts before persisting usage.
3. Test redaction at the final exporter boundary, not only at event ingestion.
4. Separate unknown, partial, and zero usage before implementing totals.
5. Prove restart and parallel-stage behavior before connecting a live backend.
