---
id: CLEW-098
title: Cross-project awareness, global attention, keyboard switching
status: done
release: v0.7
priority: P1
size: M
depends_on: [CLEW-095, CLEW-096]
parallel_group: null
owner: null
updated: 2026-09-08
evidence_policy: v1
---

# CLEW-098 — Cross-project awareness, global attention, keyboard switching

## Objective

Give the user lightweight, always-visible awareness of work outside the current Project: per-Project indicators in the switcher, a global attention entry point in the top bar, and keyboard-first switching (`Cmd/Ctrl+K` palette), so nothing needing human input is forgotten in another Project.

## User outcome

While working in one Project, the user can see at a glance that another Project has running or waiting work, jump straight to the specific waiting Task from a global attention dropdown in one action, and switch Projects/tasks entirely from the keyboard.

## Context

Builds on `CLEW-095` contracts and `CLEW-096` shell. Awareness must stay muted and secondary; it informs navigation only and never triggers control-plane actions.

## Scope

- Project switcher shows compact per-Project state (e.g., `2 running`, `1 needs you`);
- top-bar global attention indicator with a dropdown grouping waiting Tasks by Project;
- one-action jump: select an attention item → switch Project and open that Task;
- keyboard palette (`Cmd/Ctrl+K`): switch Project and open Task without a mouse;
- awareness derives from snapshot data already scoped per Project; no new polling channel.

## Out of scope

- sound, OS notifications, or toasts;
- cross-repository aggregation beyond Projects;
- detailed drill-down inside indicators (dropdown lists the waiting Task only);
- project-level settings or management from these surfaces.

## Deliverables

- switcher indicators and top-bar attention UI;
- keyboard palette with shortcut handling and focus management;
- snapshot-derived awareness selectors;
- UI tests including keyboard flows.

## Acceptance criteria

1. Switcher entries reflect running/waiting counts from live snapshot data.
2. Global attention count equals the sum of Tasks requiring the user across all Projects.
3. Choosing an attention item navigates to the correct Project and Task in one action.
4. `Cmd/Ctrl+K` opens the palette, and keyboard selection performs the same navigation as pointer actions.
5. Indicators stay muted: no layout shift, no noise when counts are zero.

## Acceptance evidence

| Criterion | Automated evidence                        | Logical scenarios                                         | Result |
| --------- | ----------------------------------------- | --------------------------------------------------------- | ------ |
| AC-1      | `ui/src/App.test.tsx` (project awareness) | multi-Project fixtures with mixed states; switcher badges | pass   |
| AC-2      | `ui/src/App.test.tsx` (attention count)   | cross-Project aggregation; waiting-only; deduped by task  | pass   |
| AC-3      | `ui/src/App.test.tsx` (attention jump)    | attention dropdown → project switch → task focus          | pass   |
| AC-4      | `ui/src/App.test.tsx` (palette)           | Cmd+K open/close, arrow/Enter selection, pointer select   | pass   |
| AC-5      | `ui/src/App.test.tsx` (muted zero)        | zero-count render; no badges/bell; no re-render churn     | pass   |

## Verification

- run UI tests for indicators, dropdown, palette;
- verify snapshot selectors are memoized and do not re-render outside scoped updates;
- run the full release quality gate.

## Review record

- Verdict: pass
- Reviewer: Muse Spark review, 2026-09-08
- Findings: Counterexample-oriented review performed. One blocking issue was found and fixed: the palette's global `keydown` listener was re-registered on every query change (deps included `items`/`activeIndex`/`onSelect`), which could drop keystrokes while typing and wasted work. Fixed by reading mutable state through refs so the listener is registered once and removed on unmount. Non-blocking notes: (1) palette focus is not returned to the trigger on close; (2) palette does not trap Tab focus; (3) `Cmd/Ctrl+K` is captured app-globally — consistent with the keyboard-first requirement but documented as a scope rule for embedded-terminal conflicts. AC-1 through AC-5 are covered by automated tests; selectors are memoized and recompute only on `tasks`/`projects` changes. `done` still requires merge to `main`.

## Dependencies and parallelization

Depends on `CLEW-095` contracts and `CLEW-096` shell. Overlaps `CLEW-097` on fixtures only.

## Risks

- attention semantics drifting from Task state mapping (requires one shared selector);
- global shortcuts conflicting with browser or embedded terminal handling (needs explicit scope rules).

## Blockers

None.

## Completion record

- Merged to `main` in commit `1dd6eb1`, 2026-09-08.
- Full release quality gate passes: backend 224/224, UI 51/51, eslint clean.
