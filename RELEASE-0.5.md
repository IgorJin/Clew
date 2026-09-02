# Clew v0.5.0 release sign-off

Date: 2026-09-02

## Release goal

Make a native Codex worker directly usable through an interactive terminal while Clew keeps durable task state, Task Thread visibility, and explicit verification ownership.

The TUI remains the sole writer for the native session. Clew observes it through a read-only App Server reader, projects completed responses into Task Thread, and waits for the operator to continue or explicitly finish the worker.

## Included

- embedded xterm terminal for daemon-run Codex workers;
- read-only native turn monitor with delayed thread discovery and restart-safe deduplication;
- durable completed-turn responses and `waiting_for_operator` interaction state;
- follow-up turns without losing the existing Task Thread history;
- explicit `Finish worker` handoff to result collection and verification;
- bounded redaction and public-output filtering;
- local daemon/API, Web UI, reconnect, and packaged-artifact support.

## Required checks

| Gate                | Command or evidence                                       | Result                                                            |
| ------------------- | --------------------------------------------------------- | ----------------------------------------------------------------- |
| Formatting          | `npm run format:check`                                    | pass                                                              |
| Lint and task cards | `npm run lint && npm run tasks:check`                     | pass                                                              |
| Backend             | `npm test`                                                | 130 tests: 126 passed, 4 loopback tests skipped by sandbox policy |
| UI                  | `npm test --prefix ui` and `npm run ui:build`             | 16 tests pass; production build passes                            |
| Full check          | `npm run check`                                           | pass                                                              |
| Installed artifact  | `npm run acceptance:installed`                            | pass for clean `clew-0.5.0.tgz` installation                      |
| Terminal lifecycle  | live smoke plus deterministic multi-turn/restart coverage | pass                                                              |
| Release operator    | commit, `v0.5.0` tag, CI, publication                     | pending operator action                                           |

## Release decision

The one-turn live smoke passed on 2026-09-02 and exposed three defects that were fixed with regression tests. Multi-turn, reconnect, restart, duplicate-suppression, redaction, and explicit-finish behavior pass in deterministic backend/UI coverage. The installed tarball acceptance passes through daemon restart.

The candidate is approved for the `v0.5.0` release tag. Publication remains an explicit release-operator action.
