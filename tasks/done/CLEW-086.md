---
id: CLEW-086
title: v0.6 transport release acceptance
status: done
release: v0.6
priority: P0
size: L
depends_on: [CLEW-082, CLEW-083, CLEW-084, CLEW-085]
parallel_group: null
owner: null
updated: 2026-09-03
evidence_policy: v1
---

# CLEW-086 — v0.6 transport release acceptance

## Objective

Prove and publish the dedicated `v0.6.0` Controller/Runner transport-and-leases release without expanding into pairing UX or Docker packaging.

## User outcome

A developer can install the same version on Controller and Runner hosts, configure one pre-shared Runner identity, execute Tasks through paired transport, and understand every disconnect or recovery state.

## Scope

- populated v0.5 to v0.6 migration fixture;
- clean installed Controller and Runner package acceptance;
- local versus paired Quick, Standard, and Deep parity;
- complete disconnect, duplicate, reorder, restart, cancellation, and stale-epoch matrix;
- protocol/product version-skew acceptance;
- package content and secret-boundary inspection;
- local-first regression proof;
- optional live Codex smoke on the Runner host;
- compatibility, configuration, security, troubleshooting, and known-limit documentation;
- changelog, `RELEASE-0.6.md`, CI, tag, GitHub release, and installable npm-format tarball publication evidence.

## Out of scope

- Docker/Compose artifacts;
- pairing, credential rotation/revocation, or replacement UX;
- multiple Runners;
- remote terminal streaming;
- automatic failover.

## Deliverables

- installed paired-transport acceptance script;
- migration and version-skew fixtures;
- package and secret inspection checks;
- release documentation and sign-off;
- `v0.6.0` release artifacts.

## Acceptance criteria

1. A populated v0.5 state upgrades losslessly and local-first mode remains usable.
2. Clean installed Controller and Runner processes complete paired Quick, Standard, and Deep acceptance.
3. The full fault matrix preserves one logical history and explicit recovery states.
4. Incompatible versions and invalid credentials fail before lease or Task mutation.
5. Package, database, logs, API, and UI inspection find no forbidden Runner or repository data.
6. Local-first quality and installed-package gates remain green.
7. The release documentation clearly states pre-shared credential, one-Runner, Runner-local terminal, no-Docker, and no-failover limitations.
8. CI passes on main and `v0.6.0`; the GitHub release tag and attached npm-format tarball expose matching versions.

## Acceptance evidence

| Criterion | Automated evidence                   | Logical scenarios                                            | Result |
| --------- | ------------------------------------ | ------------------------------------------------------------ | ------ |
| AC-1      | migration and local regression tests | populated schema 16/v0.5; local execution preserved          | pass   |
| AC-2      | installed paired acceptance          | Quick; Standard; Deep; separate Runner process               | pass   |
| AC-3      | release fault matrix                 | disconnect; duplicate; reorder; restart; cancel; stale epoch | pass   |
| AC-4      | auth/version tests                   | wrong token; wrong Runner; protocol skew; product skew       | pass   |
| AC-5      | security/package inspection          | tarball; Controller/Runner DB; API; UI; outbox               | pass   |
| AC-6      | full existing release gates          | 174 backend; 16 UI; installed; live Codex                    | pass   |
| AC-7      | documentation review                 | configuration; topology; limitations; recovery               | pass   |
| AC-8      | CI/tag/publication evidence          | main; `v0.6.0`; GitHub release; attached tarball             | pass   |

## Verification

- run the final matrix from clean installed tarballs;
- execute Controller and Runner as separate processes with isolated state;
- inspect every persisted and published artifact for forbidden data;
- run optional live Codex or record an explicit environmental skip;
- verify tag, package, and documentation versions match.

## Review record

- Verdict: pass
- Reviewer: Codex release audit, 2026-09-03
- Findings: Version alignment, migration, package contents, clean installed dual-process path, fault/restart coverage, security boundary, docs, and live Runner-host Codex were reviewed. No blocking findings remain.

## Dependencies and parallelization

Depends on `CLEW-082` through `CLEW-085`. Release scaffolding may start earlier, but sign-off waits for all component and integration evidence.

## Risks

- packaging can accidentally omit Runner migrations or runtime files;
- a passing fake-harness matrix may not expose native process lifecycle differences;
- publication can overstate self-hosting if Docker and pairing UX limitations are not prominent;
- the public npm name `clew` belongs to an unrelated maintainer, so the tested npm-format tarball must be published as a GitHub Release asset until a distinct package identity is selected.

## Blockers

None. Release publication was explicitly authorized by the operator.

## Completion record

Completed on 2026-09-03. Root and UI packages are versioned `0.6.0`; `npm run check`, unsandboxed 174/174 backend tests, 16/16 UI tests, populated v0.5 migration, real WebSocket paired acceptance, clean installed `clew-0.6.0.tgz` dual-process acceptance, package/DB secret inspection, and live Runner-host Codex smoke pass. Release scope and limitations are recorded in `RELEASE-0.6.md`; commit, tag, GitHub release, and its attached npm-format package form the final publication action. The unrelated public npm namespace is explicitly not used.
