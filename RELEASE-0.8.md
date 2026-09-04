# Clew v0.8.0 release sign-off

Date: 2026-09-04

## Release goal

Make every agent run's Git provenance and code changes inspectable from the task UI while preserving manual, operator-controlled transfer into target branches.

## Included

- immutable `base_sha` and branch provenance on local and paired run metadata, including safe legacy recovery;
- run-scoped read-only Git inspection across committed, staged, unstaged, untracked, rename, binary, empty, missing-worktree, and runner-local states;
- extensible change viewers with explicit configuration, Cursor-first and VS Code fallback, macOS application-bundle launch, and path copy;
- one task-header Changes control with explicit run selection and a dependency-free unified/split diff renderer;
- selectable workflow steps with status, prerequisites, action, approval, and side-effect details;
- one task status/waiting surface and deterministic newest-first sidebar ordering;
- populated v0.7 migration coverage and an explicit manual Git handoff guide.

## Required checks

| Gate                          | Command or evidence                                         | Result                           |
| ----------------------------- | ----------------------------------------------------------- | -------------------------------- |
| v0.7 migration                | `node --test test/release-v08.test.js`                      | pass                             |
| Git provenance and inspection | store, scheduler, runner protocol, change inspection suites | pass                             |
| Viewer adapters               | `test/change-viewer.test.js`, control-service coverage      | pass                             |
| UI behavior                   | UI tests and production build                               | pass                             |
| Full repository gate          | `npm run check`                                             | pass                             |
| Installed artifact            | `npm run acceptance:installed`                              | pass                             |
| Git safety                    | automated tests plus `docs/GIT-WORKFLOW.md` review          | pass: no automatic merge or push |

## Change-viewer decision

The bounded viewer spike is recorded in `docs/adr/0002-diff-viewer.md`. v0.8 uses the internal Preact renderer because it adds no dependency or HTML injection boundary and remains reproducible from the checked-in lockfiles.

## Git workflow and safety

`Changes`, editor opening, path copying, and `Complete` are read-only or metadata-only with respect to the primary checkout. Worktree results are transferred manually through merge, cherry-pick, or pull request as documented in `docs/GIT-WORKFLOW.md`.

## Known boundary

Runner-local code cannot be opened or inspected on the Controller host without a future remote viewer. Clew reports this explicitly. Publication, tagging, pushing, and GitHub release creation remain operator actions outside this sign-off commit.
