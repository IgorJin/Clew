---
id: CLEW-102
title: Contextual task, changes, and terminal shortcuts
status: done
release: v0.10
priority: P0
size: M
depends_on: [CLEW-101]
parallel_group: v0.10-keyboard-ui
owner: codex
updated: 2026-09-11
evidence_policy: v1
---

# CLEW-102 — Contextual task, changes, and terminal shortcuts

## Objective

Add context-aware shortcuts for Continue, internal/external change inspection, and embedded/external terminal access by routing keys and pointer controls through the same handlers. Simplify the current overloaded header action so Continue can never accidentally finish a worker.

## User outcome

On a Task screen, an operator can continue work with `Cmd+Enter`, inspect the selected run with `Cmd+E` or `Cmd+Shift+E`, and reach the relevant terminal with `Cmd+'` or `Cmd+Shift+'`. The same state and diagnostics appear whether the action starts from a key or a button.

## Context

The current header button multiplexes next-step approval, worker continuation, and `Finish worker`. The current Task UI auto-expands a controller-local active worker terminal, while external opening remains explicit. Changes already have a run selector, an internal diff modal, and external Cursor/VS Code/worktree-path actions. Keyboard control must reuse these boundaries rather than create parallel command logic.

## Scope

- register `Cmd/Ctrl+Enter` as the Task screen's contextual Continue action;
- when an interactive worker is waiting for text, focus its embedded terminal without sending input;
- from `READY` or correctable `WAITING_FOR_HUMAN`, issue the existing continuation flow and let runtime policy choose resume or fresh session;
- when the next step requires approval, open the existing product confirmation modal; preserve single-submit protection;
- keep `Finish worker`, `Finish work`, merge, and release outside Continue and without the same shortcut;
- register `Cmd/Ctrl+E` for the internal diff modal and `Cmd/Ctrl+Shift+E` for the external viewer, targeting the exact currently selected change run;
- register `Cmd+'` to expand/focus the embedded terminal and `Cmd+Shift+'` to invoke external session opening (`Cmd+\`` is reserved by macOS window management and never reaches the browser, so the terminal chords use the apostrophe key);
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

| Criterion | Automated evidence                            | Logical scenarios                                                                               | Result |
| --------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------ |
| AC-1      | `ui/src/App.test.tsx` Continue shortcut tests | waiting terminal; READY; running without input; disabled reason                                 | pass   |
| AC-2      | command-spy negative tests                    | no finish-worker; no finalize; no merge/release across Cmd+Enter states                         | pass   |
| AC-3      | Changes shortcut and run-selection tests      | selected/latest run; internal diff; external viewer                                             | pass   |
| AC-4      | terminal shortcut and chooser tests           | single target focus; multiple-target chooser; remembered choice; external session; runner-local | pass   |
| AC-5      | shared-handler tests via `tasks/CLEW-101`     | pointer and keyboard share one handler; duplicate requests guarded by the registry              | pass   |
| AC-6      | scope/state regression tests                  | input; command palette; modal; xterm; Task transition; palette parity                           | pass   |

## Verification

- run focused UI tests for all task states, run selection, terminal locality, and duplicate activation;
- manually exercise an active embedded Codex terminal without sending unintended bytes;
- verify external terminal and viewer actions through the existing daemon boundary;
- run `npm run ui:check`, backend regressions, and lint before review.

## Review record

- Verdict: pass
- Reviewer: independent counterexample review, 2026-09-11
- Findings: Five issues found and fixed. (1) Change/terminal keyboard actions ignored `canMutate`, so `Cmd+E`, `` Cmd+` ``, and `Cmd+Shift+\`` could open the diff modal or fire viewer/session commands while the banner says every operator action is disabled; all task bindings now gate on `canMutate`with the disconnected reason. (2) Embedded-terminal focus is restricted to running sessions, while external opening keeps recorded sessions. (3) The terminal chooser is rendered with shared Escape and initial-focus dismissal. (4) Disabled Continue surfaces its reason through`onDisabled`. (5) `AgentGrid`availability is shared through`buildAgentCards`/`agentCardState`/`openSessionArgs`. Independent review found no additional blocking issue. `npm run check`is green and the current result is on`main`.

## Dependencies and parallelization

Depends on CLEW-101's registry and scope contract. May run in parallel with CLEW-103 after that dependency lands. Owns action semantics and handlers; CLEW-103 only renders their metadata.

## Risks

- the overloaded current header button can preserve an accidental Finish path if handlers are not separated first;
- selected run and selected terminal can diverge in Deep or retry flows;
- key handling inside xterm can send input while also dispatching an application action.

## Blockers

None.

## Completion record

Completed on 2026-09-11 in `95710f6`/`98eb104` on `main`. Continue, internal/external Changes, embedded/external terminal shortcuts, chooser behavior, run/session targeting, pointer-handler reuse, and disconnected/Runner-local diagnostics are shipped in v0.10.0.
