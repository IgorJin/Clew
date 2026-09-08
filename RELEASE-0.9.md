# Clew v0.9.0 release sign-off

Date: 2026-09-08

## Release goal

Make task completion an explicit, auditable workflow: the operator can inspect the finalization checks, integrate local Git work safely, and distinguish merged work from released work while using the Task Screen v3 on desktop and mobile.

## Included

- Task Screen v3 with task-level actions, current-stage context, agent runtime controls, delivery flow, and responsive sticky mobile actions;
- versioned, read-only Finalization Gate reports for workspace, verification, evidence, review, target branch, and integration policy;
- lifecycle states `READY_TO_FINISH`, `MERGED`, and `RELEASED`, with legacy `READY` and non-Git `COMPLETED` compatibility;
- local Git integration with clean-target preflight, squash/merge/human handoff policies, editable commit messages, conflict attention StageRuns, cleanup eligibility, and explicit release evidence;
- keyboard focus trapping, reduced-motion support, strict UI report mapping, and lifecycle/responsive acceptance coverage;
- documentation of manual merge, PR, deployment, and publication boundaries.

## Required checks

| Gate                                  | Command or evidence                                                                   | Result |
| ------------------------------------- | ------------------------------------------------------------------------------------- | ------ |
| Lifecycle and migration compatibility | backend domain, scheduler, migration, and finalization suites                         | pass   |
| Finalization and Git integration      | finalization service, workspace, integration, conflict, cleanup, and restart coverage | pass   |
| Task Screen v3                        | UI build, responsive states, keyboard/focus, and report mapping tests                 | pass   |
| Full repository gate                  | `npm run check`                                                                       | pass   |
| Installed artifact                    | `npm run acceptance:installed`                                                        | pass   |
| Git safety                            | clean-target preflight, no automatic push/deployment, manual handoff documentation    | pass   |

## Git workflow and safety

`Finish work` opens a read-only report before any mutation. Integration requires explicit operator confirmation and records the selected policy. A clean target branch receives no empty commit; conflicts create a structured attention run without damaging the target branch. Worktree cleanup is eligible only after confirmed integration. Clew never pushes, deploys, or marks `RELEASED` without explicit evidence.

## Known boundary

Runner-local changes cannot be inspected remotely from the Controller host without a future remote viewer. External PR providers, CI/CD deployment detection, automatic merge/push, and production release publication remain operator-managed. Tagging and GitHub release creation are intentionally outside this sign-off commit.
