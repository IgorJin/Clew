---
id: CLEW-091
title: v0.8 acceptance and release
status: planned
release: v0.8
priority: P0
size: M
depends_on: [CLEW-087, CLEW-088, CLEW-089, CLEW-092]
parallel_group: null
owner: null
updated: 2026-09-03
evidence_policy: v1
---

# CLEW-091 — v0.8 acceptance and release

## Objective

Prove and package the complete v0.8 Agent Change Visibility release.

## User outcome

The installed release reliably preserves run provenance, reports changes, opens worktrees, and documents the manual handoff workflow.

## Context

Release acceptance covers local and paired execution boundaries without silently changing the existing v0.7 contract.

## Scope

- Add a populated v0.7 migration fixture.
- Test Quick, Standard, Deep, all Git change classes, Cursor-first and VS Code fallback.
- Test retries, restarts, remote worktrees, runner-local limits, and no-auto-merge behavior.
- Prepare `RELEASE-0.8.md`, Git workflow documentation, CI evidence, and installed-package acceptance.

## Out of scope

- Automatic merge, push, or changing the v0.7 scope.

## Deliverables

- Release document, Git workflow docs, migration fixture, acceptance suite, and installed-package evidence.

## Acceptance criteria

1. All dependent cards pass their criterion-specific evidence and independent review.
2. Installed-package acceptance passes across profiles, Git states, viewer fallback, retries/restarts, and execution modes.
3. `Complete` and change viewing do not merge or push; manual merge/cherry-pick/PR workflow is documented.

## Acceptance evidence

| Criterion | Automated evidence                        | Logical scenarios                                                  | Result  |
| --------- | ----------------------------------------- | ------------------------------------------------------------------ | ------- |
| AC-1      | Full v0.8 CI and migration suite          | populated v0.7 database; clean install/upgrade                     | pending |
| AC-2      | Installed acceptance report               | Quick/Standard/Deep; Git matrix; viewer fallback; retries/restarts | pending |
| AC-3      | Git-state safety and documentation review | Complete; remote and runner-local boundaries; manual handoff       | pending |

## Verification

- Run the full backend/UI suite and installed-package acceptance from a clean artifact.
- Record release, migration, security, and documentation evidence before marking done.

## Review record

- Verdict: pending
- Reviewer: unassigned
- Findings: Not reviewed.

## Dependencies and parallelization

Wave 3; final gate for CLEW-087 through CLEW-089, CLEW-092, and v0.8 publication. CLEW-090 is superseded.

## Risks

- Installed environments may differ in editor availability and worktree topology.

## Blockers

None.

## Completion record

Not completed.
