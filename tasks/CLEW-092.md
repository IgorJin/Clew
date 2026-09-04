---
id: CLEW-092
title: Refine task activity and change-review UX
status: done
release: v0.8
priority: P0
size: L
depends_on: [CLEW-088, CLEW-089]
parallel_group: null
owner: null
updated: 2026-09-04
evidence_policy: v1
---

# CLEW-092 — Refine task activity and change-review UX

## Objective

Make change review, workflow navigation, and task ordering follow the task-level mental model established by real v0.8 smoke testing.

## User outcome

Users review all task changes from one header control, reliably open the selected run worktree in Cursor or VS Code, inspect a readable code diff, and discover step-specific actions by selecting steps in the stepper.

## Context

The first CLEW-090 implementation duplicates change actions inside agent/terminal cards, renders the patch as plain text, separates overlapping waiting notices, and does not make sidebar ordering obvious. A real macOS smoke test also showed that installed editor applications may not expose `cursor` or `code` shell aliases.

## Scope

- Keep one task-level `Changes +N −M` split-button in the task header and remove change controls from agent and terminal cards.
- Make the header control resolve the relevant task run explicitly, expose `Open in editor`, `View diff`, and `Copy worktree path`, and clearly identify the selected stage/run when several runs exist.
- Make `Open in editor` work end to end for configured commands and installed macOS Cursor/VS Code application bundles, with actionable unavailable/error feedback.
- Run a bounded diff-viewer spike covering Monaco Diff Editor, `react-diff-view`, and `diff2html`; record bundle size, Preact integration, unified-patch support, syntax highlighting, virtualization/large-diff behavior, accessibility, maintenance, and license before selecting one.
- Replace the plain-text patch with the selected open-source viewer or document and implement a justified internal alternative if none passes the gate.
- Make every step in the stepper selectable and show that step's status, explanation, prerequisites, available action, approval requirement, and side effects in the step-detail area.
- Remove the standalone generic `next-step` presentation once equivalent contextual information is available from the selected step.
- Consolidate `notice` and `terminal-waiting-banner` into one non-duplicated task/terminal status surface with a single primary action.
- Restore deterministic sidebar ordering by task creation time, newest first, with a stable tie-breaker.

## Out of scope

- Changing Git provenance or diff semantics.
- Automatic merge, push, cherry-pick, or PR creation.
- Adding editors beyond the existing extensible adapter boundary.

## Deliverables

- Task-header change control and run selector behavior.
- Diff-viewer decision record and integrated viewer.
- Selectable stepper with contextual step details/actions.
- Unified waiting/status banner.
- Newest-first sidebar ordering.
- UI, daemon-contract, editor-launch, and regression tests.

## Acceptance criteria

1. The task header is the only Changes entry point; it shows correct aggregate/selected-run counts and opens the exact persisted worktree through Cursor, VS Code fallback, or an actionable unavailable state.
2. The chosen diff viewer renders unified and split-readable code changes with file navigation, additions/deletions, long-line handling, binary/empty/unavailable states, and acceptable performance on the documented large-diff fixture.
3. Selecting any step displays step-specific state and next action without a separate duplicate next-step panel; keyboard navigation and current/selected states remain distinguishable.
4. Waiting/notice information appears once with one primary action across running, waiting-for-operator, approval, failed, and completed transitions.
5. Sidebar tasks are ordered by `created_at` descending with a deterministic tie-breaker and remain correctly ordered after create, event refresh, reconnect, and restart.

## Acceptance evidence

| Criterion | Automated evidence                  | Logical scenarios                                                                          | Result |
| --------- | ----------------------------------- | ------------------------------------------------------------------------------------------ | ------ |
| AC-1      | UI + daemon/editor adapter tests    | header-only control; retries/Deep stages; Cursor app bundle; VS Code fallback; unavailable | pass   |
| AC-2      | Diff component tests + decision ADR | unified/split view; file navigation; long lines; binary; empty; unavailable                | pass   |
| AC-3      | Stepper interaction tests           | mouse/keyboard selection; current/selected state; approval and side effects                | pass   |
| AC-4      | Status transition tests             | terminal waiting; notice dismissal; no duplicate message/action                            | pass   |
| AC-5      | Ordering tests                      | created_at descending; equal timestamp tie-breaker; create and refresh                     | pass   |

## Verification

- Run the full backend/UI suite and production build.
- Repeat the `INSERT_TEST.md` smoke flow through the daemon: create task, run agent, inspect header diff, and open the exact worktree in Cursor/VS Code.
- Perform visual and keyboard QA at desktop and narrow widths.

## Review record

- Verdict: pass
- Reviewer: Codex release audit, 2026-09-04
- Findings: Header-only ownership, exact run selection, offline dependency boundary, patch text safety, keyboard semantics, status deduplication, and deterministic ordering were reviewed. The internal renderer decision is recorded in ADR 0002.

## Dependencies and parallelization

Wave 2; replaces CLEW-090's rejected UI placement while consuming the inspection and viewer contracts from CLEW-088 and CLEW-089. CLEW-091 becomes the final release gate after this refinement.

## Risks

- Monaco may be too heavy for a read-only diff surface; React-specific libraries may require compatibility work in Preact.
- Task-level aggregation can hide which retry or Deep stage is selected unless run identity is explicit.

## Blockers

None.

## Completion record

Completed on 2026-09-04. The task header owns one run-selectable Changes control; the internal Preact viewer provides file navigation and unified/split rendering; step details, waiting status, and newest-first ordering are covered by 28 passing UI tests and a production build.
