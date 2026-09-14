# Clew v0.10.0 release sign-off

Date: 2026-09-11

## Release goal

Make the control plane keyboard-first for the common Task loop: an operator can jump to any of the first ten visible Tasks, continue work, inspect changes, and reach embedded or external terminals without leaving the keyboard. Holding Command reveals the shortcuts available in the current context, and the same registry backs a keyboard-shortcut help surface. Pointer behavior, terminal input, Task lifecycle, and the settings modal are unchanged.

## Included

- Scoped UI shortcut registry (`ui/src/shortcuts.ts`) with stable action IDs, chords, scopes, availability predicates, disabled reasons, and a handler metadata surface for key hints and help.
- Numbered task navigation for the first ten rendered Tasks (`Cmd/Ctrl+1…0`) with a browser-safe `Option/Alt+1…0` fallback; positions follow the filtered and sorted sidebar order.
- Contextual `Cmd/Ctrl+Enter` Continue/Focus terminal, `Cmd/Ctrl+E` internal diff, `Cmd/Ctrl+Shift+E` external viewer, `Cmd/Ctrl+\`` embedded terminal, and `Cmd/Ctrl+Shift+\`` external session opening, all routed through the existing pointer handlers.
- Multi-target terminal chooser with per-task remembered selection and a separate explicit `Finish worker` action, so Continue can never finish a worker.
- Command-hold key-hint badges driven by registry metadata (180 ms threshold, flicker guard) plus a `Keyboard shortcuts` help surface reachable from the command palette.
- `Cmd/Ctrl+K` command-palette control migrated to the shared registry without behavioral regression.
- Keyboard control documentation in `docs/KEYBOARD-CONTROLS.md`.

## Required checks

| Gate                               | Command or evidence                                                            | Result                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Full repository gate               | `npm run check` (format, lint, task cards, UI build/lint/tests, backend suite) | pass                                                              |
| Installed artifact                 | `npm run acceptance:installed`; packed tarball inspection                      | pass (candidate evidence; local install rerun stalled in sandbox) |
| Git safety                         | no automatic push/deployment; explicit confirmation for mutations              | pass                                                              |
| Real-browser shortcut matrix       | Safari, Chrome, Firefox reserved-key behavior plus fallback                    | environmental skip                                                |
| Live-terminal and assistive matrix | embedded xterm, external open, VoiceOver, reduced motion, narrow widths        | environmental skip                                                |

## Git workflow and safety

Keyboard shortcuts never bypass confirmation policy: state-changing commands still open the existing product confirmation dialogs, and Continue can never invoke `finish-worker`, finalization, merge, or release. Numbered navigation reuses `selectTask` routing; disabled positions and out-of-scope keys are no-ops. External viewers and session openers reuse the existing daemon boundary, including Runner-local diagnostics.

## Known boundaries

Browsers may reserve `Cmd+1…0` before the page receives them; the documented `Option/Alt+1…0` fallback is exercised in component tests and must be confirmed on each supported host (see the manual matrix below). VoiceOver, reduced-motion, narrow-width, and live-terminal behaviors are implemented and unit-tested for reset lifecycle. The host-only rows below are recorded as environmental skips for this sign-off: the managed execution sandbox rejects local loopback listeners, and the browser connector's automatic review blocked navigation to the local daemon. No alternate browser or raw CDP path was used. Run these rows from a native supported host before public publication. Tagging and GitHub release creation are intentionally outside this sign-off commit.

## Manual acceptance matrix

Run against a clean v0.10 install on each supported host and record the outcome here. Current
managed-session result is recorded as an environmental skip; the implementation and component
coverage remain accepted by the automated gate.

| Host / surface            | `Cmd+1…0` delivered? | Fallback path verified? | Notes                            |
| ------------------------- | -------------------- | ----------------------- | -------------------------------- |
| macOS Safari              | environmental skip   | environmental skip      | Requires native browser session. |
| macOS Chrome              | environmental skip   | environmental skip      | Requires native browser session. |
| macOS Firefox             | environmental skip   | environmental skip      | Requires native browser session. |
| Standalone/PWA (if avail) | environmental skip   | environmental skip      | Requires native browser session. |

| Scenario                       | Result             | Notes                                                                |
| ------------------------------ | ------------------ | -------------------------------------------------------------------- |
| Live embedded terminal focus   | environmental skip | Native terminal/browser session unavailable here.                    |
| External session opening       | environmental skip | Native desktop session unavailable here.                             |
| Keyboard-only task loop        | environmental skip | Native browser session unavailable here.                             |
| VoiceOver pass                 | environmental skip | VoiceOver is not exposed to this task.                               |
| Reduced motion enabled         | environmental skip | CSS/unit coverage is automated; native toggle requires host session. |
| Narrow-width layout            | environmental skip | Native visual viewport unavailable here.                             |
| Application switching mid-hold | environmental skip | Requires native application switching.                               |
