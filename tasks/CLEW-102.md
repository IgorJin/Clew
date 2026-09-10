---
id: CLEW-102
title: Contextual task, changes, and terminal shortcuts
status: planned
release: v0.10
priority: P0
size: M
depends_on: [CLEW-101]
parallel_group: v0.10-keyboard-ui
owner: null
updated: 2026-09-10
evidence_policy: v1
---

# CLEW-102 — Contextual task, changes, and terminal shortcuts

## Objective

Add context-aware shortcuts for Continue, internal/external change inspection, and embedded/external terminal access by routing keys and pointer controls through the same handlers. Simplify the current overloaded header action so Continue can never accidentally finish a worker.

## User outcome

On a Task screen, an operator can continue work with `Cmd+Enter`, inspect the selected run with `Cmd+E` or `Cmd+Shift+E`, and reach the relevant terminal with `Cmd+\`` or `Cmd+Shift+\``. The same state and diagnostics appear whether the action starts from a key or a button.

## Context

The current header button multiplexes next-step approval, worker continuation, and `Finish worker`. The current Task UI auto-expands a controller-local active worker terminal, while external opening remains explicit. Changes already have a run selector, an internal diff modal, and external Cursor/VS Code/worktree-path actions. Keyboard control must reuse these boundaries rather than create parallel command logic.

## Scope

- register `Cmd/Ctrl+Enter` as the Task screen's contextual Continue action;
- when an interactive worker is waiting for text, focus its embedded terminal without sending input;
- from `READY` or correctable `WAITING_FOR_HUMAN`, issue the existing continuation flow and let runtime policy choose resume or fresh session;
- when the next step requires approval, open the existing product confirmation modal; preserve single-submit protection;
- keep `Finish worker`, `Finish work`, merge, and release outside Continue and without the same shortcut;
- register `Cmd/Ctrl+E` for the internal diff modal and `Cmd/Ctrl+Shift+E` for the external viewer, targeting the exact currently selected change run;
- register `Cmd/Ctrl+\`` to expand/focus the embedded terminal and `Cmd/Ctrl+Shift+\`` to invoke external session opening;
- use a compact chooser when multiple eligible active sessions exist and remember the last choice per Task for the current UI session;
- return actionable unavailable states for missing changes, session, viewer, controller-local access, and Runner-local access.

## Out of scope

- implementing the plugin interfaces proposed for `TerminalLauncher`, `WorkspaceOpener`, or `ChangeViewer`;
- automatically launching an external terminal;
- adding merge, push, release, destructive Git, or worker-finish shortcuts;
- changing runtime resume/recovery policy.

## Deliverables

- shared pointer/keyboard handlers for the affected Task actions;
- simplified Continue/Start/Focus terminal header behavior and separate Finish worker action;
- multiple-session chooser and session-local selection preference;
- UI regression tests and updated user-facing shortcut documentation.

## Acceptance criteria

1. `Cmd/Ctrl+Enter` focuses a waiting terminal, continues a correctable Task, or opens the existing approval modal according to state; it is a no-op with an explanation when no safe action exists.
2. Continue never calls `finish-worker`, finalization, merge, release, or any other completion command.
3. Internal and external Changes shortcuts use the same selected run as the header control and preserve empty, unavailable, Runner-local, multi-run, and refresh behavior.
4. Embedded and external terminal shortcuts target the correct run/session; multiple eligible sessions use the chooser; Runner-local limitations remain explicit.
5. Pointer and keyboard activation share one handler per action, produce the same notice/error, and are guarded against duplicate requests.
6. Input, modal, palette, and xterm focus rules from CLEW-101 remain intact through every Task state transition.

## Acceptance evidence

| Criterion | Automated evidence                            | Logical scenarios                                                                                      | Result  |
| --------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------- |
| AC-1      | `ui/src/App.test.tsx` Continue shortcut tests | waiting terminal; READY; WAITING; pending approval; running; unavailable                               | pending |
| AC-2      | command-spy negative tests                    | no finish-worker; no finalize; no merge/release across every Cmd+Enter state                           | pending |
| AC-3      | Changes shortcut and run-selection tests      | latest; selected retry/stage; empty; loading; unavailable; runner-local; internal/external             | pending |
| AC-4      | terminal shortcut and chooser tests           | auto-expanded active worker; collapsed; multiple roles/stages; external open; runner-local; no session | pending |
| AC-5      | shared-handler and single-flight tests        | click vs key; double key; key plus click; pending request; identical success/error notice              | pending |
| AC-6      | scope/state regression tests                  | input; confirmation modal; command palette; xterm; refresh; reconnect; Task transition                 | pending |

## Verification

- run focused UI tests for all task states, run selection, terminal locality, and duplicate activation;
- manually exercise an active embedded Codex terminal without sending unintended bytes;
- verify external terminal and viewer actions through the existing daemon boundary;
- run `npm run ui:check`, backend regressions, and lint before review.

## Review record

- Verdict: pending
- Reviewer: unassigned
- Findings: Not reviewed.

## Dependencies and parallelization

Depends on CLEW-101's registry and scope contract. May run in parallel with CLEW-103 after that dependency lands. Owns action semantics and handlers; CLEW-103 only renders their metadata.

## Risks

- the overloaded current header button can preserve an accidental Finish path if handlers are not separated first;
- selected run and selected terminal can diverge in Deep or retry flows;
- key handling inside xterm can send input while also dispatching an application action.

## Blockers

None.

## Completion record

Not completed.
