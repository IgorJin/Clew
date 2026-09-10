---
id: CLEW-101
title: Shortcut registry and numbered task navigation
status: in_review
release: v0.10
priority: P0
size: M
depends_on: []
parallel_group: null
owner: codex
updated: 2026-09-10
evidence_policy: v1
---

# CLEW-101 — Shortcut registry and numbered task navigation

## Objective

Introduce one scoped keyboard-command registry and use it to open the first ten visible Tasks with `Cmd+1…9`, `Cmd+0`, plus a browser-safe `Option+1…0` fallback, without duplicating navigation logic or interfering with text entry and the embedded terminal.

## User outcome

An operator can switch directly to any of the first ten Tasks shown in the current Project sidebar. The numbered shortcuts always correspond to the list currently on screen after filtering and sorting.

## Context

Clew already provides `Cmd/Ctrl+K` through an app-global listener, but keyboard behavior is otherwise distributed among modal and popover handlers. [`docs/KEYBOARD-CONTROLS.md`](../docs/KEYBOARD-CONTROLS.md) defines the intended complete model. Browser-reserved `Cmd+1…9` and `Cmd+0` behavior requires a working fallback and explicit acceptance evidence.

## Scope

- define a single UI shortcut registry with stable action ID, displayed chord, scope, availability predicate, disabled reason, and handler;
- keep one global listener lifecycle and reuse existing Project/Task navigation functions;
- map positions 1–9 and 10 to `Cmd+1…9` and `Cmd+0` when the browser delivers the event;
- support `Option+1…0` as the browser-safe fallback on macOS and an equivalent documented fallback where required on other platforms;
- derive positions from the rendered current-Project Task list after active filters and deterministic sorting;
- define precedence for modal, text-input/contenteditable, embedded-terminal, task-screen, and global scopes;
- preserve the existing `Cmd/Ctrl+K` palette behavior through the same registry or a compatibility wrapper over it;
- expose registry metadata for CLEW-103 key hints and help.

## Out of scope

- task action, Changes, and terminal shortcuts owned by CLEW-102;
- visual key-hint overlay owned by CLEW-103;
- a desktop application wrapper;
- changing Task ordering, filtering, Project scoping, or command-palette search semantics.

## Deliverables

- shortcut registry and scoped dispatcher;
- numbered Task navigation and browser fallback;
- migration of `Cmd/Ctrl+K` to the shared boundary without behavioral regression;
- focused UI tests and keyboard documentation updates.

## Acceptance criteria

1. Positions `1…9, 0` open exactly the corresponding 1st–10th rendered Task, including after filter, Project, ordering, creation, and snapshot refresh changes.
2. A position beyond the visible list is a no-op and neither changes selection nor prevents unrelated input.
3. Registry dispatch respects modal/input/contenteditable/xterm scope and does not fire during IME composition or unintended key repeat.
4. `Cmd/Ctrl+K`, palette arrow navigation, Enter selection, Escape close, and focus behavior remain equivalent to the current UI.
5. `Cmd+1…0` is supported when delivered by the host and the documented fallback works in the supported browser surface.
6. One keystroke invokes one navigation handler even across rerenders, reconnects, and Strict Mode test lifecycles.

## Acceptance evidence

| Criterion | Automated evidence                                        | Logical scenarios                                                             | Result |
| --------- | --------------------------------------------------------- | ----------------------------------------------------------------------------- | ------ |
| AC-1      | `ui/src/App.test.tsx` numbered-navigation tests           | 1st–10th order; filter recompute; newest-first                                | pass   |
| AC-2      | `ui/src/App.test.tsx` unavailable-position tests          | empty list; fewer than ten; selected Task unchanged                           | pass   |
| AC-3      | `ui/src/App.test.tsx` scope tests + `ui/src/shortcuts.ts` | input; textarea; contenteditable; modal; xterm; composition; repeat           | pass   |
| AC-4      | existing and expanded command-palette tests               | open/close; arrows; Enter; Escape; focus; listener stability                  | pass   |
| AC-5      | `ui/src/App.test.tsx` chord/fallback tests                | Meta/Command primary; Option fallback; host behavior reserved for CLEW-104    | pass   |
| AC-6      | lifecycle/registry tests + `listShortcuts()` metadata     | rerender; unmount; one handler per keystroke; registry metadata for key hints | pass   |

## Verification

- run focused UI tests for registry, palette, sidebar ordering, filters, and Project switching;
- exercise the current embedded terminal and every input/modal scope;
- record host behavior for reserved shortcuts for the CLEW-104 browser matrix;
- run `npm run ui:check` and the full repository lint before review.

## Review record

- Verdict: pass (author review; independent third-party review still outstanding, tracked in CLEW-104)
- Reviewer: implementation author, 2026-09-10
- Findings: Four issues found and fixed. (1) Out-of-range numbered positions resolved to a disabled action but shared the disabled-explanation path, risking consumed input; resolution now prefers the first enabled match and leaves unmatched/disabled number keys to default behavior since digit actions carry no `onDisabled`. (2) The singleton registry snapshot used for hints/help could lag one render behind task transitions; badges and help are now derived from the current shortcut definitions via `indexShortcuts`/`describeShortcut`, and the per-task binding ref is reset outside the task view. (3) Chord labels were macOS-only (`⌘…`, `⌥…`) while matching also accepts Ctrl/Alt; chord and fallback labels are now platform-aware via `primaryModifierLabel`/`optionModifierLabel`. (4) `resolveShortcut` returned the first disabled match even if an enabled action shared the chord; it now scans for an enabled match first and reports the earliest disabled one only as fallback. Verified: `npm run check` green (240 backend, 99 UI), `tsc --noEmit` and eslint clean, installed acceptance passed for the packed artifact.

## Dependencies and parallelization

No undone dependency. This is the shared contract for CLEW-102 and CLEW-103, which may proceed in parallel after the registry lands.

## Risks

- browsers may consume Command-number shortcuts before page JavaScript receives them;
- global capture can steal keystrokes from xterm or form controls;
- computing indices from raw snapshot order instead of rendered order can open the wrong Task.

## Blockers

None.

## Completion record

Not completed.
