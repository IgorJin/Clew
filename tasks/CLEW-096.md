---
id: CLEW-096
title: Project shell, switcher, and project-scoped routes
status: done
release: v0.7
priority: P0
size: L
depends_on: [CLEW-095]
parallel_group: null
owner: null
updated: 2026-09-08
evidence_policy: v1
---

# CLEW-096 — Project shell, switcher, and project-scoped routes

## Objective

Make Project the permanent global context in the Web UI: a compact project switcher in the top bar, project-scoped routes (`/projects/:projectId/...`), persisted selection, and a minimal in-project navigation (Overview / Tasks) that scopes every Task list to the selected Project. Switching is navigation only.

## User outcome

The user always sees which Project they are inside, can switch Projects in one click, and—after reloads—lands back in the last used Project with its last opened Task. Non-Git sidebar content disappears; only the selected Project's Tasks render.

## Context

`CLEW-095` owns the Project domain and API contracts. This task converts those contracts into a stable shell that every later screen (`CLEW-097`) and awareness surface (`CLEW-098`) builds on. Project switch must never be a control-plane action.

## Scope

- top-bar Project switcher (dropdown: Projects + `Add project`), visually lightweight and always available;
- history-safe routes such as `/projects/:projectId/tasks/:taskId`, with project context in URL (deep links and back/forward work);
- persisted `currentProjectId` and per-Project `lastOpenedTaskId` (UI preference storage);
- minimal in-project sidebar navigation (Overview / Tasks; optionally Attention/Settings deferred);
- empty states: no Project yet → Add project; Project selected but no Tasks → New task entry point;
- selecting a Project never touches daemon execution, terminals, or worktrees.

## Out of scope

- Project counts or attention indicators (owned by `CLEW-098`);
- Overview screen contents (owned by `CLEW-097`);
- Task screen changes (owned by `CLEW-097`);
- keyboard palette (owned by `CLEW-098`);
- in-browser folder picking; `Add project` flow delegates to the `CLEW-095` path entry/validation surface.

## Deliverables

- shell components, routing, and persistence;
- sidebar restructure;
- accessibility-reviewed focus/escape behavior of the switcher;
- UI tests covering selection, deep links, and reload retention.

## Acceptance criteria

1. The switcher always shows the currently selected Project name.
2. Switching re-scopes Task lists immediately without a full reload.
3. Selection survives page reloads.
4. Project-scoped URLs resolve directly (deep link) and update on selection.
5. No-Project and no-Tasks empty states render exactly once decision point each.
6. Switching does not change any Task state or running agent behavior (verified against the daemon API surface).

## Acceptance evidence

| Criterion | Automated evidence                    | Logical scenarios                                                 | Result |
| --------- | ------------------------------------- | ----------------------------------------------------------------- | ------ |
| AC-1      | `ui/src/App.test.tsx` (project shell) | multiple Projects; switcher shows current name                    | pass   |
| AC-2      | `ui/src/App.test.tsx`                 | rapid switch; scoped task list swaps                              | pass   |
| AC-3      | `ui/src/App.test.tsx`                 | reload retention; last-opened task per project                    | pass   |
| AC-4      | `ui/src/App.test.tsx`                 | deep link `/projects/:id/tasks/:id`; legacy `/tasks/:id` redirect | pass   |
| AC-5      | `ui/src/App.test.tsx`                 | no-projects welcome; no-tasks scoped empty state                  | pass   |
| AC-6      | `ui/src/App.test.tsx`                 | navigation issues zero `execute()` daemon commands                | pass   |

## Verification

- run UI component tests for switcher and routing;
- verify persisted storage keys are versioned and safely migrated;
- cross-check navigation calls against daemon API mocks to prove no mutation calls are issued;
- run the full release quality gate.

## Review record

- Verdict: pass
- Reviewer: Muse Spark review, 2026-09-04
- Findings: Shell routing (`/projects/:id[/overview|/tasks/:taskId]`, legacy `/tasks/:id` redirect), switcher, `clew.v1.*` persistence, scoped sidebar, empty states, and the no-daemon-commands-on-navigation invariant reviewed. One blocking finding was found and fixed during review: a rejected `project add` left the AddProject dialog stuck in `busy` forever (App swallowed the error while Cancel stayed disabled) — fixed by rethrowing, covered by the "recovers the add-project dialog" regression test, which fails without the fix and passes with it. Non-blocking notes: (1) legacy tasks with null `projectId` stay visible in every project scope — a deliberate, code-documented upgrade tradeoff; recommend a one-time backfill in a later slice; (2) Escape closes the switcher but focus is not returned to the trigger. No other blocking findings remain. `done` still requires merge to `main`.

## Dependencies and parallelization

Depends on `CLEW-095` contract shape; can start from UI fixtures immediately. `CLEW-097` and `CLEW-098` consume this shell.

## Risks

- URL migrations for existing users (old `/tasks/:id` links need redirect handling);
- per-Project storage can leak between sessions if keyed without a project dimension.

## Blockers

None.

## Completion record

- Merged to `main` in commit `1dd6eb1`, 2026-09-08.
- Full release quality gate passes: backend 224/224, UI 51/51, eslint clean.
- Note: the original "zero daemon commands on navigation" invariant is now refined to "zero control-plane commands on navigation"; `task changes` data loads triggered by task selection are allowed.
