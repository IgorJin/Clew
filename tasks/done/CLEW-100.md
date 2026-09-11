---
id: CLEW-100
title: 'bug: Task creation UX, duplicate submission, approval modal, and Codex launch'
status: done
release: v0.9
priority: P0
size: L
depends_on: []
parallel_group: null
owner: codex
updated: 2026-09-11
evidence_policy: v1
---

# CLEW-100 — bug: Task creation UX, duplicate submission, approval modal, and Codex launch

## Objective

Repair four regressions in the task-creation and task-start flow: replace the obsolete task form with a minimal title-and-description dialog, make creation single-submit safe, replace the browser-native `confirm` prompt with product UI for non-Quick profiles, and make Codex executable resolution reliable when Clew runs through the daemon.

## User outcome

A user can create one task with a simple form and start it without raw browser or process errors. A Quick task starts immediately; Standard and Deep tasks use a clear in-product confirmation dialog. Repeated clicks cannot create duplicate tasks, and a correctly installed Codex executable is found from the daemon environment.

## Context

The current flow exposes an older, over-configured task modal even though the intended product surface only requires a title and description. While the create request is pending, two rapid activations of `Create` can cross the render boundary and create two durable task records. Starting a non-Quick task exposes a browser-native prompt containing a raw command such as `Confirm task approve-step ...`; this leaks implementation detail and provides inconsistent interaction and accessibility. Starting a task can also fail with the unhandled low-level message `spawn codex ENOENT`, especially when the daemon was started from a macOS GUI environment with a reduced `PATH`.

### Reproduction

1. Open `New task`; observe fields beyond title and description.
2. Enter valid content and activate `Create` twice rapidly; observe two task records or two create commands.
3. Create or open a Standard/Deep draft and approve its next step; observe the native browser confirmation containing the CLI command.
4. Create a Quick task; observe that it enters the same confirmation flow instead of starting immediately.
5. Start a task from a daemon launched without the interactive shell's full `PATH`; observe `spawn codex ENOENT` even when Codex is installed in a common user-level location.

## Scope

- Reduce the task creation modal to exactly two user inputs: title and description.
- Derive any required contract defaults internally; removed controls must not leave stale values in the submitted payload.
- Add a synchronous, render-independent single-flight guard around create submission and disable all duplicate submission paths while the request is pending.
- Ensure duplicate delivery at the command/service boundary cannot create a second task for the same client intent or request identity.
- Remove `window.confirm` from `approve-step` entirely.
- Show an accessible Clew confirmation dialog for Standard and Deep approval, with human-readable consequences and explicit Cancel/Confirm actions.
- Start Quick tasks immediately after successful creation without opening the approval dialog.
- Resolve the Codex executable from explicit configuration first, then the inherited environment and supported platform-specific locations.
- Preserve a usable daemon spawn environment and translate a genuine missing executable into an actionable product error rather than exposing raw `ENOENT`.
- Add focused UI and backend regression coverage for success, cancellation, duplicate, fallback, and failure paths.

## Out of scope

- Redesigning the task detail screen or workflow stepper.
- Changing Standard or Deep planning semantics beyond replacing the confirmation surface.
- Installing Codex automatically or modifying the user's shell configuration.
- General-purpose daemon process supervision unrelated to executable discovery.
- Migrating or deduplicating unrelated historical task records.

## Deliverables

- Minimal create-task modal and updated create payload construction.
- Single-flight create guard and durable duplicate-command protection.
- Accessible approval modal for Standard and Deep tasks.
- Immediate Quick creation/start path.
- Codex executable resolver and actionable launch diagnostics.
- UI and backend regression tests mapped to every acceptance criterion.

## Acceptance criteria

1. The task creation modal exposes only Title and Description, validates both, and submits no values from the removed legacy controls.
2. Two rapid clicks, Enter plus click, or repeated submit events during one pending request result in exactly one create command and one durable task.
3. Standard and Deep `approve-step` actions use an accessible in-product dialog; `window.confirm` is never called, Cancel sends no command, and repeated confirmation sends exactly one command.
4. A newly created Quick task starts immediately exactly once without showing either the browser confirmation or the Standard/Deep approval dialog.
5. A daemon-launched task finds an installed Codex executable through explicit configuration, inherited `PATH`, or supported macOS fallback locations; genuine absence produces an actionable error without raw `spawn codex ENOENT`.
6. Automated tests cover modal shape and payload, every duplicate submission path, Standard/Deep confirm and cancel flows, Quick immediate start, daemon executable discovery, restricted `PATH`, and missing-binary diagnostics.

## Acceptance evidence

| Criterion | Automated evidence                                   | Logical scenarios                                                                           | Result |
| --------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------ |
| AC-1      | `ui/src/App.test.tsx` create-task modal tests        | visible fields; required validation; exact command payload; keyboard submit                 | pass   |
| AC-2      | `ui/src/App.test.tsx` and service idempotency tests  | double click; Enter+click; unresolved request; repeated request identity; one database row  | pass   |
| AC-3      | `ui/src/App.test.tsx` approval-dialog tests          | Standard; Deep; cancel; confirm; keyboard activation; repeated confirm; no `window.confirm` | pass   |
| AC-4      | `ui/src/App.test.tsx` Quick creation tests           | successful create; immediate approve/start; one command; no dialog                          | pass   |
| AC-5      | harness/config/daemon executable-resolution tests    | configured absolute path; inherited PATH; macOS GUI PATH; missing binary; actionable error  | pass   |
| AC-6      | focused UI and backend suites plus full quality gate | all profiles; success and failure; duplicate requests; daemon restart boundary              | pass*  |

## Verification

- Run `npm run lint`.
- Run focused create-task and approval-dialog UI tests.
- Run focused service idempotency and Codex executable-resolution tests.
- Run `npm run ui:check`.
- Run `npm test`.
- Manually start the daemon from a reduced-PATH environment and verify both a configured Codex path and the missing-binary diagnostic.
- Verify a Quick task starts once, while Standard and Deep remain behind the new explicit approval dialog.

## Review record

- Verdict: pass
- Reviewer: independent counterexample review, 2026-09-11
- Findings: Reviewed the minimal create form, synchronous submit guard, stable client ID, service-side idempotency, approval dialog, Quick/Standard/Deep branching, Codex resolver precedence, and normalized launch errors. No blocking issue found. Current repository gates pass: `npm run check`, UI tests, backend tests (230 pass, 10 loopback skips imposed by the managed sandbox), lint, and formatting.

## Dependencies and parallelization

The UI modal, duplicate-submit guard, and approval dialog share `ui/src/App.tsx` and should be implemented together. Service idempotency and Codex executable discovery can be developed independently, but their tests must land before integration. The final pass must exercise the complete create-to-start flow across Quick, Standard, and Deep profiles.

## Risks

- A React/Preact state-only busy flag may still admit two events before rerender; the guard must be synchronous.
- Automatically starting Quick can duplicate execution if create and approve retries do not share an idempotency boundary.
- Executable lookup must not execute shell text or trust unvalidated paths.
- Adding fallback paths can hide a genuinely stale daemon environment unless diagnostics report the selected executable source.
- Removing legacy form inputs must not accidentally drop required contract defaults or change existing API validation.

## Blockers

None.

## Completion record

Completed on 2026-09-11 on `main` as part of the v0.10.0 release line.

- `npm run check` passes; the current UI suite has 101 passing tests and the backend suite has 230 passing tests with 10 loopback-listener skips imposed by the managed sandbox.
- The service idempotency and Codex resolver tests cover stable client IDs, repeated input rejection, explicit paths, inherited `PATH`, macOS app-bundle fallback, and actionable missing-binary diagnostics.
- The reduced-PATH macOS fixture resolves Codex to `/Applications/ChatGPT.app/Contents/Resources/codex`; packed-release acceptance evidence is retained in the v0.10 release record.
