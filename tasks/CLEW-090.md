---
id: CLEW-090
title: Show per-agent Changes in the Web UI
status: superseded
release: v0.8
priority: P0
size: L
depends_on: [CLEW-088, CLEW-089]
parallel_group: null
owner: null
updated: 2026-09-03
evidence_policy: v1
---

# CLEW-090 — Show per-agent Changes in the Web UI

## Objective

Make each agent's run changes visible and actionable from its agent card.

## User outcome

Users see `Changes +N −M`, open the selected worktree in an editor, inspect a built-in diff, or copy its path, including while the agent is running.

## Context

The UI needs a run-aware view rather than task-wide guesses, especially for retries and multiple Deep stages.

## Scope

- Add a split-button to every agent card with `Open in editor`, `View diff`, and `Copy worktree path`.
- Embed file list and unified diff for the selected run.
- Poll active-run summaries every two seconds; refresh completed runs through events or manual refresh.
- Show clear unavailable states for missing worktrees and runner-local execution.

## Out of scope

- Merge, push, PR creation, or changing the primary checkout.

## Deliverables

- API client, agent-card controls, diff viewer, polling/event refresh, and UI tests.

## Acceptance criteria

1. Every agent card shows accurate additions/deletions and actions for the correct run.
2. The embedded viewer displays files and unified diff with binary, empty, and unavailable states.
3. Active runs poll every two seconds and retries/Deep stages do not display another run's changes.

## Acceptance evidence

| Criterion | Automated evidence    | Logical scenarios                                                            | Result |
| --------- | --------------------- | ---------------------------------------------------------------------------- | ------ |
| AC-1      | `ui/src/App.test.tsx` | worker/internal agents; latest retry; multiple Deep stages                   | pass   |
| AC-2      | `ui/src/App.test.tsx` | unified patch; binary; empty diff; runner-local unavailable                  | pass   |
| AC-3      | `ui/src/App.test.tsx` | two-second active polling; cleanup; stale-response rejection; manual refresh | pass   |

## Verification

- Verify keyboard/menu behavior, long paths, narrow cards, and terminal coexistence.
- Verify polling cleanup and stale-response rejection during run changes.

## Review record

- Verdict: superseded
- Reviewer: product owner
- Findings: Real workflow review rejected per-agent placement. Changes belong to the task header, and the surrounding activity UX requires the consolidated replacement defined by CLEW-092.

## Dependencies and parallelization

Wave 2; consumes CLEW-088's inspection contract and CLEW-089's viewer result.

## Risks

- Frequent polling can amplify load if inactive runs are not stopped promptly.

## Blockers

Superseded by CLEW-092; do not complete the rejected per-agent interaction model.

## Completion record

Not completed. Replaced by CLEW-092 on 2026-09-03.
