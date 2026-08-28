---
id: CLEW-067
title: v0.3 upgrade, acceptance, and release
status: done
release: v0.3
priority: P0
size: L
depends_on: [CLEW-042, CLEW-043]
parallel_group: null
owner: null
updated: 2026-08-28
---

# CLEW-067 — v0.3 upgrade, acceptance, and release

## Objective

Prove that optional telemetry and usage accounting can ship as `v0.3.0` without regressing the released v0.2 lifecycle or requiring external infrastructure.

## User outcome

A user can upgrade an existing v0.2 installation, install a clean v0.3 package, run normal Tasks with telemetry disabled, optionally enable traces, inspect honest usage/cost output, and rely on the same completion semantics.

## Context

`CLEW-042` and `CLEW-043` are implemented on `main`. The package still reports `0.2.0`; migration, installed-package acceptance, release notes, and publication remain.

## Scope

- real populated v0.2 → v0.3 migration fixture;
- preservation of Tasks, Runs, events, verification, completion, and manifests;
- observability disabled, enabled with fake collector, and degraded collector matrices;
- complete, partial, missing, cached, and reasoning usage fixtures;
- Quick, Standard, and Deep installed-package acceptance;
- retry, resume, restart, export, complete, and cleanup regression coverage;
- package version, changelog, release notes, compatibility, and troubleshooting updates;
- clean tarball inspection and smoke;
- CI and `v0.3.0` release/tag evidence.

## Out of scope

- daemon, HTTP API, Web UI, and Runner work;
- new tracing or pricing features beyond defects required to meet existing contracts;
- formal QA/evidence policy.

## Deliverables

- migration fixture and tests;
- installed-package acceptance script/evidence;
- final `RELEASE-0.3.md` sign-off;
- updated package metadata and changelog;
- published `v0.3.0` tag and artifact.

## Acceptance criteria

1. A populated v0.2 database upgrades losslessly.
2. Enabled, disabled, and degraded telemetry produce identical lifecycle outcomes.
3. A clean installed CLI traces and summarizes a Task without source-checkout assumptions.
4. Missing usage remains explicit and historical pricing stays reproducible.
5. Package contents contain required schemas/migrations and no credentials/generated telemetry.
6. Quick, Standard, and Deep acceptance remains green.
7. CI passes on `main` and `v0.3.0`.

## Verification

- `npm run check`;
- clean `npm pack` install in an isolated temporary project;
- v0.2 migration fixture;
- fake OTLP collector matrix;
- optional live adapter/collector smoke with explicit environmental skip reasons.

## Dependencies and parallelization

All dependencies are done. This is the only ready release task and must complete before `CLEW-068` begins.

## Risks

- installed-package behavior may differ from source checkout;
- optional runtime resolution and process shutdown need clean-environment coverage;
- package version and tag can drift if release steps are not atomic.

## Blockers

None.

## Completion record

- Implementation: migration fixture coverage, installed-package acceptance script, v0.3 package metadata, changelog, and release sign-off.
- Verification: `npm run check` and `npm run acceptance:installed` passed on 2026-08-28.
- Release artifact: package version `0.3.0`; tag publication remains an operator-controlled repository release action.
