---
id: CLEW-089
title: Add extensible change-viewer adapters
status: in_review
release: v0.8
priority: P1
size: M
depends_on: [CLEW-087]
parallel_group: v0.8-change-viewers
owner: null
updated: 2026-09-03
evidence_policy: v1
---

# CLEW-089 — Add extensible change-viewer adapters

## Objective

Create a viewer registry that opens a persisted run's worktree through a user-selected integration without mutating Git state.

## User outcome

`task open-changes --run` opens the right worktree in the configured editor, falls back from Cursor to VS Code, or lets the user copy its path.

## Context

Change viewing is separate from merge and push. The adapter contract allows future JetBrains, GitHub, GitLab, and remote Runner viewers.

## Scope

- Add `--run` and a common adapter result of `opened` or `unavailable`.
- Resolve viewer priority as explicit setting, Cursor, then VS Code.
- Add a worktree-path copy adapter and extension points for future viewers.

## Out of scope

- Automatic merge, push, PR creation, or primary checkout changes.

## Deliverables

- Registry, CLI integration, editor adapters, path-copy adapter, and documentation.

## Acceptance criteria

1. A run-scoped command opens the persisted worktree using configured editor, Cursor, or VS Code fallback.
2. Unsupported or missing integrations return structured `unavailable` results.
3. The command never merges, pushes, or changes the primary checkout.

## Acceptance evidence

| Criterion | Automated evidence                                           | Logical scenarios                                           | Result |
| --------- | ------------------------------------------------------------ | ----------------------------------------------------------- | ------ |
| AC-1      | `test/change-viewer.test.js`, `test/control-service.test.js` | explicit setting; Cursor-first; VS Code fallback            | pass   |
| AC-2      | Adapter capability tests                                     | missing worktree; runner-local; unsupported viewer          | pass   |
| AC-3      | viewer registry tests                                        | complete/open command leaves branches and remotes unchanged | pass   |

## Verification

- Verify run selection, path safety, exit handling, and copy behavior.
- Verify the registry can accept future adapters without changing the CLI contract.

## Review record

- Verdict: pending independent review
- Reviewer: unassigned
- Findings: Not reviewed.

## Dependencies and parallelization

Wave 1 with CLEW-088 after CLEW-087. Own viewer registry, CLI, and local editor integrations.

## Risks

- Desktop editor launch behavior differs across platforms and installations.

## Blockers

None.

## Completion record

Not completed.
