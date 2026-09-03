---
id: CLEW-088
title: Implement Git change inspection service
status: in_review
release: v0.8
priority: P0
size: L
depends_on: [CLEW-087]
parallel_group: v0.8-change-data
owner: null
updated: 2026-09-03
evidence_policy: v1
---

# CLEW-088 — Implement Git change inspection service

## Objective

Provide a read-only, run-scoped service that explains the current Git changes produced by an agent.

## User outcome

Users can request a run's summary, changed files, and unified patch with reliable counts and explicit unavailable reasons.

## Context

The service compares against the persisted run baseline and never trusts a caller-supplied path.

## Scope

- Inspect committed, staged, unstaged, and untracked changes relative to `base_sha`.
- Return additions, deletions, statuses, binary markers, dirty state, and revisions.
- Handle remote worktrees, binary/rename/empty diffs, and runner-local unavailable cases.
- Support inspection while a worker is running and keep the API read-only.

## Out of scope

- Editor/viewer adapter behavior and UI presentation.

## Deliverables

- Service/API, normalized response contract, Git fixtures, and failure handling.

## Acceptance criteria

1. A concrete run returns summary, file list, and unified patch relative to its persisted baseline.
2. All Git change classes and unavailable states are represented without accepting arbitrary paths.
3. Inspection works outside the worker queue while the worker remains active.

## Acceptance evidence

| Criterion | Automated evidence               | Logical scenarios                                          | Result |
| --------- | -------------------------------- | ---------------------------------------------------------- | ------ |
| AC-1      | `test/change-inspection.test.js` | committed, staged, unstaged, untracked, empty diff         | pass   |
| AC-2      | `test/change-inspection.test.js` | binary, rename, deleted worktree, runner-local unavailable | pass   |
| AC-3      | daemon bypass and service tests  | inspection does not enqueue or mutate worker execution     | pass   |

## Verification

- Test run authorization and persisted-workspace resolution.
- Test retries, multiple Deep stages, restart, remote worktree, and malformed/missing baseline cases.

## Review record

- Verdict: pending independent review
- Reviewer: unassigned
- Findings: Not reviewed.

## Dependencies and parallelization

Wave 1 with CLEW-089 after CLEW-087. Own the read-only Git inspection contract and implementation.

## Risks

- Git diff semantics for untracked and partially staged files need stable normalization.

## Blockers

None.

## Completion record

Not completed.
