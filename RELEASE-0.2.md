# Clew v0.2 release plan — Ready to Delivered

**Status:** `v0.2.0` released on 2026-08-28

**Target:** `v0.2.0`

## Product outcome

Clew v0.2 closes the local lifecycle after implementation. A developer can inspect exactly what is ready, retry or verify a pinned revision deliberately, understand whether evidence is still trustworthy, export a reproducible result, accept that exact revision as complete, and safely retire its worktrees.

The release does not make Clew a hosted scheduler, dashboard, PR bot, or observability platform.

## Release boundaries

Included:

- explicit manual retry and verification commands;
- human-readable and stable JSON result/history views;
- verification environment fingerprinting, freshness, and trust policy;
- deterministic `READY` invalidation;
- versioned result manifests and patch/Git-bundle export;
- explicit human completion of a pinned revision;
- completed-task retention and safe cleanup;
- runtime namespaces for parallel local stages;
- per-role Codex/OpenCode model configuration and one local-model proof;
- lossless v0.1 database upgrade and release acceptance.

Not included:

- automatic merge, pull-request creation, or provider-specific review automation;
- modification of the primary checkout during task execution or export;
- dashboard UI;
- remote or multi-process scheduling;
- OpenTelemetry/Phoenix and cost aggregation;
- automatic installation or lifecycle management of model servers;
- automatic resolution of merge conflicts.

## Candidate sequence

### v0.2.0-alpha.1 — control and visibility

Tasks: `CLEW-049`–`054`.

Exit gate:

1. `task result` explains the current result without raw event or database inspection.
2. Manual retry creates one auditable attempt and cannot bypass policy.
3. Manual verification runs against an explicit revision without rerunning implementation.
4. All new commands have stable JSON and meaningful non-zero exit codes.

### v0.2.0-beta.1 — trusted completion

Tasks: `CLEW-055`–`061`.

Exit gate:

1. Evidence reuse decisions are deterministic and explainable.
2. A changed revision/environment/policy invalidates stale readiness.
3. Exported artifacts are reproducible and checksum-protected.
4. `complete` accepts only the expected fresh revision and persists the actor/decision atomically.
5. Cleanup cannot remove active, dirty, unaccepted, or unexported work.

### v0.2.0-rc.1 — isolation, models, and upgrade

Tasks: `CLEW-044`, `CLEW-062`–`066`.

Exit gate:

1. Parallel stages receive collision-free runtime namespaces.
2. Worker/architect/reviewer/QA model selection follows one validated precedence model.
3. A local or explicitly selected OpenCode model passes a documented role smoke, or the optional hardware gate records why it cannot run.
4. A real v0.1 database upgrades without losing task history or explainability.
5. The installed-package acceptance flow reaches `COMPLETED`, exports its result, restarts safely, and cleans up owned worktrees.

## Final v0.2.0 gate

The final tag may be created only when:

1. Every task selected in [`tasks.md`](./tasks.md) is complete.
2. All schemas and migrations have upgrade fixtures and runtime validation.
3. `READY` cannot survive stale or untrusted evidence.
4. `COMPLETED` identifies one immutable accepted revision and actor.
5. Export and cleanup never mutate the primary checkout or silently discard dirty work.
6. Quick, Standard, and Deep flows pass both fresh-run and v0.1-upgrade acceptance.
7. Supported Codex/OpenCode versions and live smoke evidence are recorded.
8. A clean tarball install exposes the documented version and commands.
9. GitHub Actions passes on `main` and the release tag.

## Decisions fixed for this release

- `COMPLETED` means a human accepted a specific fresh `READY` revision; it does not imply merge or deployment.
- Delivery is patch/Git-bundle export. PR and merge automation remain separate future work.
- Freshness is based on revision, environment fingerprint, policy, and configurable age; agent claims alone never make evidence trusted.
- Runtime isolation starts with deterministic namespace values and collision-proof fixture coverage, not infrastructure provisioning.
- Existing SQLite/event-log architecture remains; v0.2 does not introduce a queue or remote coordinator.

## Risks to retire first

1. Define completion/freshness contracts before adding commands or migrations.
2. Prove manual retry does not double-start attempts after restart.
3. Prove stale evidence cannot complete a changed revision.
4. Prove v0.1 database upgrade before accumulating v0.2-only data.
5. Keep local-model support behind the harness boundary and do not couple the domain to provider-specific model names.
