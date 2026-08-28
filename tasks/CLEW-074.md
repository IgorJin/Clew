---
id: CLEW-074
title: v0.4 upgrade, acceptance, and release
status: planned
release: v0.4
priority: P0
size: L
depends_on: [CLEW-069, CLEW-070, CLEW-071, CLEW-072, CLEW-073]
parallel_group: null
owner: null
updated: 2026-08-28
evidence_policy: legacy
---

# CLEW-074 — v0.4 upgrade, acceptance, and release

## Objective

Integrate the parallel local-control-plane packages and publish a reproducible `v0.4.0` without breaking v0.3 data or native execution semantics.

## User outcome

A developer can install Clew, explicitly start the local daemon, use CLI or Web UI to follow a Task, open a Codex session, continue human-blocked work, and complete the result.

## Context

`CLEW-069`–`073` deliberately develop against shared contracts. This package owns their cross-component integration, upgrade proof, installed artifact, and release evidence.

## Scope

- populated v0.3 → v0.4 migration fixture;
- API-backed Quick, Standard, and Deep installed-package acceptance;
- daemon start/stop/crash/restart and exclusive-owner matrix;
- local auth and API version compatibility tests;
- WebSocket disconnect/reconnect/cursor-expiry matrix;
- deterministic Task Thread rebuild;
- React production build and daemon asset serving;
- Continue, review exhaustion, interruption, and operator override flows;
- plain-terminal Session Surface acceptance and optional live Codex smoke;
- documentation, troubleshooting, package contents, changelog, and release notes;
- clean tarball smoke, CI, version bump, tag, and publication.

## Out of scope

- Docker Controller or remote Runner;
- OpenCode attach as a required release gate;
- QA/evidence-policy features;
- new v0.4 product scope after integration begins.

## Deliverables

- upgrade and full-stack acceptance suites;
- production UI bundle in the npm artifact;
- release sign-off document;
- updated package metadata and compatibility docs;
- `v0.4.0` tag and published artifact.

## Acceptance criteria

1. A v0.3 database upgrades with complete Task/Event/Run/Completion history.
2. Existing CLI semantics work through the daemon without regression.
3. Task Thread and UI explain retrying Standard and parallel Deep fixtures.
4. Daemon restart/reconnect does not duplicate execution or omit events.
5. Codex session opening targets the correct session and workspace.
6. Review exhaustion returns control to a human and continuation is auditable.
7. Only an operator creates `COMPLETED`; overrides retain unresolved findings.
8. A clean installed package serves the UI and passes acceptance.
9. CI passes on `main` and the release tag.

## Verification

- full repository check including UI toolchain;
- clean package install and daemon smoke;
- v0.3 migration fixture;
- full local API/UI/WebSocket acceptance matrix;
- optional live Codex smoke with explicit skip evidence;
- package-content and credential-leak inspection.

## Dependencies and parallelization

Depends on every Wave 2 package. Integration should begin only when each dependency's contract tests pass; incomplete implementations may still be integrated behind explicit capabilities.

Primary ownership: cross-component acceptance, release documentation, package configuration, and final compatibility fixes.

## Risks

- independently implemented consumers may reveal contract gaps late;
- UI build packaging can diverge from source development;
- daemon process tests may be flaky without deterministic ports and cleanup;
- live terminal behavior is environment-dependent.

## Blockers

Waiting for `CLEW-069`–`073`.

## Completion record

Not completed.
