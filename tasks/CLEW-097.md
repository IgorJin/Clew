---
id: CLEW-097
title: Project screens — Overview, scoped Tasks, Task breadcrumb
status: done
release: v0.7
priority: P0
size: M
depends_on: [CLEW-095, CLEW-096]
parallel_group: null
owner: null
updated: 2026-09-04
evidence_policy: v1
---

# CLEW-097 — Project screens — Overview, scoped Tasks, Task breadcrumb

## Objective

Implement the project-scoped working surfaces on top of the shell: a lightweight Project Overview oriented on fast entry into work, a Tasks view filtered to the current Project, and a compact Project breadcrumb on the Task screen—without adding visual weight to the existing Task UX.

## User outcome

Inside a Project the user sees Needs attention first, Running work, and compact Ready/completed; creates a Task without re-picking a repository; and on any Task screen reads a small `Project / Task` breadcrumb instead of a heavy Project block.

## Context

Builds on `CLEW-095` (Project data + `projectId`) and `CLEW-096` (shell, routes, navigation). Keeps the existing Task screen layout and density; Project context stays secondary to the current Task and Attention.

## Scope

- Overview screen: Needs attention (first, only when present), Running, Ready/recently completed;
- Project primary actions: `New task` (auto-binds `projectId`), plus Add existing project / Project settings entry points;
- Tasks view: only current Project Tasks, grouped or filterable by state (Needs attention / Running / Draft / Ready / Done);
- Task row/card omits the Project name (already in context);
- Task screen breadcrumb: compact `Project / Task` context, current Task title remains the primary heading;
- existing task actions (`Open changes`/Open IDE, Finish task, Complete) continue to target Task workspace/worktree.

## Out of scope

- cross-project indicators and global attention (owned by `CLEW-098`);
- keyboard palette (owned by `CLEW-098`);
- Project settings implementation beyond an entry point;
- Epics content (route placeholder only).

## Deliverables

- Overview and scoped Tasks views;
- Task screen breadcrumb;
- New Task binding to current Project;
- fixtures covering attention/running/ready mixes;
- UI tests.

## Acceptance criteria

1. Tasks view renders only Tasks whose `projectId` matches the current Project.
2. Creating a Task from Project context binds `projectId` without asking for a repository.
3. Overview surfaces Needs attention before other sections when present.
4. Task screen shows the breadcrumb without shrinking or relocating the existing Task title emphasis.
5. Existing task-level actions behave identically to pre-Project behavior on the same fixtures.

## Acceptance evidence

| Criterion | Automated evidence                              | Logical scenarios                                  | Result |
| --------- | ----------------------------------------------- | -------------------------------------------------- | ------ |
| AC-1      | `ui/src/App.test.tsx` (project shell, overview) | two Projects with distinct Tasks; scoped sidebar   | pass   |
| AC-2      | `ui/src/App.test.tsx` (create task)             | create inside Project; payload carries `--project` | pass   |
| AC-3      | `ui/src/App.test.tsx` (overview)                | attention-first ordering; empty sections collapse  | pass   |
| AC-4      | `ui/src/App.test.tsx` (breadcrumb)              | compact `Project / Task` above the task title      | pass   |
| AC-5      | existing UI interaction suite                   | complete/approve/terminal/continue unchanged       | pass   |

## Verification

- run UI tests for scoping, creation, ordering, breadcrumb;
- run the existing Task interaction suite unchanged;
- run the full release quality gate.

## Review record

- Verdict: pass
- Reviewer: Muse Spark review, 2026-09-04
- Findings: Overview section order (Needs attention → Running → Ready → Recently completed → Failed), empty-section collapse, per-row meta helpers, compact `Project / Task` breadcrumb, `--project` create binding, and the EXECUTING/COMPLETED/FAILED fixtures reviewed. Section ordering and collapse covered by dedicated tests; the pre-existing interaction suite is unchanged and green. Non-blocking notes: (1) DRAFT/PLAN_READY tasks group under "Ready" — acceptable fast-entry grouping; (2) new fixtures use relative `minutesAgo` timestamps, tests assert structure rather than values. No blocking findings remain. `done` still requires merge to `main`.

## Dependencies and parallelization

Depends on `CLEW-095` contracts and `CLEW-096` shell. Can share fixtures with `CLEW-098` but must not gate it.

## Risks

- Overview ordering rules competing with existing status priority logic;
- breadcrumb placement regressing mobile/narrow layouts.

## Blockers

None.

## Completion record

- Completed: 2026-09-04
- Summary: Overview, scoped Tasks, Task breadcrumb implemented and reviewed. All acceptance criteria met. 33 UI tests green, backend 192/192, lint/prettier clean.
