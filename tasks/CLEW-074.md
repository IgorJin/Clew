---
id: CLEW-074
title: v0.4 upgrade, acceptance, and release
status: superseded
release: v0.4
priority: P0
size: L
depends_on: [CLEW-069, CLEW-070, CLEW-071, CLEW-072, CLEW-073]
parallel_group: null
owner: null
updated: 2026-09-02
evidence_policy: v1
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
- Preact production build and daemon asset serving;
- Continue, review exhaustion, interruption, and operator override flows;
- plain-terminal Session Surface acceptance and optional live Codex smoke;
- documentation, troubleshooting, package contents, changelog, and release notes;
- clean tarball smoke, CI, version bump, and release sign-off. Tag/publication remain an explicit operator action.

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

## Acceptance evidence

| Criterion | Automated evidence                                                                                             | Result  |
| --------- | -------------------------------------------------------------------------------------------------------------- | ------- |
| AC-1      | `test/release-v04.test.js` populated v0.3 fixture; schema 11 → 15; history, completion, usage, integrity check | pass    |
| AC-2      | `test/daemon.test.js`; `test/cli.test.js`; installed Quick/Standard/Deep daemon API acceptance                 | pass    |
| AC-3      | `test/thread.test.js`; `ui/src/*.test.tsx`; production browser and installed Preact smoke                      | pass    |
| AC-4      | daemon replay/origin tests, serialized command queue, installed WebSocket replay, restart acceptance           | pass    |
| AC-5      | `test/session-surface.test.js`; session identity projection in Preact client                                   | pass    |
| AC-6      | `test/continuation.test.js`; exhaustion and explicit continuation scenarios                                    | pass    |
| AC-7      | completion/override tests and immutable manifest assertions                                                    | pass    |
| AC-8      | `scripts/installed-package-acceptance.js`; clean install plus daemon API/UI/WS/restart and package inspection  | pass    |
| AC-9      | Local checks pass; CI on committed `main` and the `v0.4.0` release tag require an operator commit/tag          | pending |

## Review record

- Verdict: pending release-operator gate
- Reviewer: independent Codex review
- Findings: production Task Thread/message integration, daemon parse containment, WebSocket Origin validation, durable UI continuation, migration history, and installed API/UI/WS/restart acceptance pass locally. CI/tag evidence remains pending.

## Blockers

None. The standalone `v0.4.0` publication gate was superseded by the cumulative `v0.5.0` release.

## Completion record

- Implementation: v0.4.0 package integration with Preact UI, daemon static serving/bootstrap, API/Task Thread/WebSocket wiring, migration coverage, and installed-package acceptance.
- Verification: local `npm run check`, production browser smoke, dependency audit, and installed daemon/API/UI/WS/restart acceptance passed on 2026-08-28; live Codex smoke is optional and skipped without explicit provider credentials.
- Release evidence: [RELEASE-0.4.md](../RELEASE-0.4.md).
- Supersession: the implemented v0.4 control-plane scope shipped cumulatively in tagged GitHub release `v0.5.0` on 2026-09-02.
