# Clew v0.6 — Observable task execution workflow

Status: planning draft  
Created: 2026-08-31

## Purpose

This release establishes one small, fully observable, human-controlled path from
task creation to task completion.

The current implementation already contains task storage, CLI commands, a local
server, UI projections, orchestration code, harness adapters, and logging. This
release does not replace or rewrite those internals up front. We will inspect
each existing part, prove whether it works, and connect or correct it one slice
at a time.

The first goal is not autonomous orchestration. The first goal is a workflow a
developer can understand and debug without guessing which process is running or
why a status changed.

## MVP outcome

A user can:

1. Create a task from the UI or CLI.
2. Supply the task as CLI arguments, JSON, or Markdown.
3. See the normalized task title and description before execution.
4. Request that the task be started.
5. See an explanation of the exact next action, its inputs, expected state
   transition, side effects, worker configuration, and approval requirement.
6. Explicitly approve that action.
7. Observe one real worker process start with the Luna model.
8. Follow its identifiers, status, structured logs, output, and failure details.
9. Review the result and explicitly complete or reject the task.

No execution step may be silently simulated by changing task statuses.

## Scope boundaries

The v0.6 MVP includes one worker, one attempt, one task at a time, and simple
read-only tasks.

The following are deliberately out of scope:

- screenshots and other attachments;
- parallel stages or multiple agents;
- architect, reviewer, or QA stages;
- autonomous retries, continuation, or exhaustion handoff;
- worker writes, commits, pushes, or destructive commands;
- replacement of all existing task and orchestration internals;
- changes to the v0.5 Controller/Runner release scope.

## Canonical task input

All creation paths must normalize into the same task draft:

```json
{
  "title": "Inspect the project version",
  "description": "Read package.json and report the current version. Do not change files."
}
```

### UI

The create form contains two required fields:

- `title` — a short task title;
- `description` — the complete task instruction.

The UI shows validation errors and the normalized task after creation.

### CLI arguments

```shell
clew task create \
  --title "Inspect the project version" \
  --description "Read package.json and report the current version. Do not change files."
```

### JSON file

```shell
clew task create --json ./task.json
```

The JSON object must contain non-empty string fields `title` and `description`.
Unknown fields must produce a clear validation result rather than being silently
interpreted.

### Markdown file

```shell
clew task create --md ./task.md
```

The first level-one heading is the title. All content after that heading is the
description:

```markdown
# Inspect the project version

Read `package.json` and report the current version. Do not change files.
```

For the MVP, front matter and attachments are not supported.

## Observable sequential workflow

The names below describe observable workflow steps. During the audit they must
be mapped to existing persisted states where possible; they are not an immediate
requirement to replace the current state model.

| Step              | Meaning                                                            | How it advances                          |
| ----------------- | ------------------------------------------------------------------ | ---------------------------------------- |
| `TASK_CREATED`    | Title and description are stored; nothing is executing.            | User requests Start.                     |
| `START_PROPOSED`  | Clew explains the exact worker action it is prepared to run.       | User approves or cancels.                |
| `START_APPROVED`  | The proposed action is authorized exactly once.                    | Clew starts the worker.                  |
| `WORKER_STARTING` | Process creation has begun and diagnostic identifiers are visible. | Real process/session start is confirmed. |
| `WORKER_RUNNING`  | The Luna worker is processing the read-only task.                  | Process exits or fails.                  |
| `WORKER_FINISHED` | Exit status and result are stored; task is not yet complete.       | User opens result review.                |
| `RESULT_REVIEW`   | Output, logs, and errors are available for inspection.             | User completes or rejects.               |
| `COMPLETED`       | The human accepted the result.                                     | Terminal state.                          |

`FAILED` and `CANCELLED` are explicit terminal outcomes available from every
applicable step. A failed process must never be displayed as a successful task.

Only one transition may occur at a time. During MVP development there is no
automatic transition from a human gate to the next action.

## One source of truth for “next step”

The UI must not invent explanatory text separately from the backend action. The
service layer must return a canonical action descriptor used by both UI and CLI.
A representative descriptor is:

```json
{
  "id": "action_123",
  "taskId": "CLEW-123",
  "kind": "start_worker",
  "currentStep": "TASK_CREATED",
  "resultingStep": "WORKER_STARTING",
  "summary": "Start one read-only worker for this task",
  "inputs": {
    "harness": "opencode",
    "model": "luna",
    "permissionMode": "read-only"
  },
  "sideEffects": ["start a local worker process", "create a run record"],
  "approvalRequired": true
}
```

The same descriptor is rendered by:

- the UI next-step panel;
- a CLI inspection command such as `clew task next-step <task-id>`;
- the approval command or endpoint that executes it.

Approval references the immutable action ID. If task state or inputs changed
after preview, approval must fail as stale and require a new preview. This keeps
the explanation and executed action identical and makes retries idempotent.

The final route and command names will be selected after auditing existing
service-layer conventions. The contract above is the requirement, not a demand
for a parallel API implementation.

## Worker MVP

The first worker is intentionally constrained:

- existing harness boundary is reused rather than replaced without evidence;
- Luna is selected through the existing model configuration boundary;
- exact provider and model identifier must be discovered and verified during
  the audit, then exposed in the action descriptor and logs;
- permission mode is read-only;
- one process or native agent session is started per approved action;
- one attempt is allowed;
- no hidden continuation, reviewer, QA, commit, or push occurs;
- cancellation and non-zero exit are visible failures, not status shortcuts.

The worker is considered started only after Clew has evidence of a real native
process or session. A task-state update alone is not proof.

Initial acceptance tasks should be deterministic and harmless, for example:

- read `package.json` and report its version;
- list files in a specified directory;
- summarize one supplied source file without editing it.

## Required debugging information

The UI and CLI must expose enough information to reconstruct one run:

- task ID;
- action ID and approval timestamp;
- run/attempt ID;
- server process ID and worker process or native session ID when available;
- harness, provider, model, and permission mode;
- current workflow step and the reason for the last transition;
- start time, finish time, duration, and exit status;
- structured worker events and server logs;
- normalized worker output and raw error details;
- correlation ID shared by API/service/worker log entries.

Secrets, authorization values, and sensitive environment variables must remain
redacted.

## UI requirements for the debug phase

The task page should prioritize observability over visual compactness:

1. A timeline shows every confirmed step and timestamp.
2. The current step is visually distinct.
3. A next-step panel shows the canonical action descriptor.
4. The approval control names the action it will authorize.
5. Worker configuration and process/session identifiers are visible.
6. Logs and output can be inspected without leaving the task.
7. Errors contain a useful cause and a suggested operator action.
8. Refreshing or reconnecting reconstructs the same persisted state and does not
   start duplicate work.

## Audit before implementation

The first engineering activity is an evidence-based audit, not a rewrite. For
each capability we will identify the current entry point, service method,
storage model, tests, and actual runtime behavior.

| Capability       | Current expectation to verify                              | Required MVP result                                                 |
| ---------------- | ---------------------------------------------------------- | ------------------------------------------------------------------- |
| Task persistence | A task/domain store exists.                                | One normalized title/description record from every input path.      |
| CLI creation     | Task commands and JSON output exist.                       | Arguments, JSON file, and Markdown file creation work consistently. |
| UI creation      | Task projections exist; a working create form is unproven. | Real form backed by the same service contract as CLI.               |
| Start action     | Existing orchestration may advance statuses automatically. | Preview, explicit approval, then exactly one start.                 |
| Service layer    | Shared task/daemon services exist.                         | UI and CLI call one canonical next-action contract.                 |
| Harness adapter  | Native harness integration exists in code.                 | A real Luna worker process/session is demonstrated.                 |
| Observability    | Structured server logging exists.                          | End-to-end correlation and worker lifecycle are inspectable.        |
| Recovery         | Persisted task state exists.                               | Restart/reconnect does not duplicate an approved action.            |

No row is marked complete based only on the presence of code. Each row needs a
repeatable test or runtime trace.

## Incremental implementation plan

### Slice 0 — Reproducible baseline and audit

- Document exact commands to run the server, UI, and CLI.
- Create one fixture project and one read-only test task.
- Trace current create and start flows through CLI, UI, service, store, and
  harness.
- Record every unexpected status transition and whether a real process starts.
- Produce a short inventory: reuse as-is, repair, or currently missing.

Exit condition: we can reproduce the current failure and explain it from logs
and code paths.

### Slice 1 — Task creation only

- Define and validate the canonical task draft.
- Make CLI arguments, JSON, and Markdown normalize through one service method.
- Add the UI create form against the same contract.
- Keep newly created tasks inert; creation must not start execution.
- Add unit, CLI integration, API/service, and UI tests.

Exit condition: equivalent inputs create equivalent inert tasks from all three
formats and the UI.

### Slice 2 — Next-step explanation

- Add the canonical action descriptor to the service layer.
- Render it in CLI and UI.
- Include state transition, side effects, model, permissions, and approval need.
- Persist or sign the immutable action identity needed for safe approval.

Exit condition: the operator can inspect exactly what Start will do without
anything executing.

### Slice 3 — Explicit Start approval

- Add approval for the proposed action.
- Reject duplicate, stale, or mismatched approvals.
- Remove or disable automatic start transitions on this MVP path.
- Persist approval and correlation information before process creation.

Exit condition: no worker starts before approval, and one approval starts at
most one run.

### Slice 4 — Real Luna read-only worker

- Verify the installed harness and exact Luna model identifier.
- Start one real native worker process/session.
- Capture lifecycle events, identifiers, output, exit status, and errors.
- Enforce read-only permissions and one attempt.
- Make startup and runtime failures visible without fake progress.

Exit condition: logs prove that a real worker handled a harmless read-only task
and that no files changed.

### Slice 5 — Human result review

- Stop after worker completion and present the result.
- Allow explicit Complete or Reject.
- Preserve raw diagnostics for failed and rejected runs.
- Ensure refresh and server restart reconstruct the same review state.

Exit condition: completion is a human decision and never an automatic worker
side effect.

### Slice 6 — Golden-path acceptance

- Run the same task from UI, CLI arguments, JSON, and Markdown.
- Test stale approval, double approval, worker failure, server restart, UI
  reconnect, and cancellation.
- Verify correlated logs and absence of hidden status transitions.
- Publish the exact local debugging runbook.

Exit condition: another developer can execute and diagnose the complete flow
using only the documented commands and visible diagnostics.

## Release acceptance checklist

- [ ] UI task creation stores only title and description and does not execute.
- [ ] CLI argument, JSON, and Markdown inputs produce the same normalized task.
- [ ] Invalid inputs explain the exact field or Markdown rule that failed.
- [ ] Start first produces a canonical next-step explanation.
- [ ] UI and CLI display information from that same action descriptor.
- [ ] No worker starts without explicit approval.
- [ ] An approved action is executed at most once.
- [ ] Exactly one real Luna worker process/session handles the MVP task.
- [ ] Worker permissions are demonstrably read-only.
- [ ] Process/session IDs and correlated structured logs are visible.
- [ ] Success, failure, cancellation, and rejection remain distinguishable.
- [ ] Worker completion waits for human result review.
- [ ] Refresh, reconnect, and server restart do not create duplicate work.
- [ ] The golden-path runbook works from a clean local checkout.
- [ ] No existing subsystem is replaced without an audit finding that justifies
      the change.

## First implementation task

Before changing behavior, audit the current task creation and start path and
produce a reproducible baseline:

1. Start the current server and UI using documented commands.
2. Create one inert read-only task through the current CLI and UI paths.
3. Capture persisted records, API/service calls, status changes, logs, and
   processes.
4. Prove whether a native worker starts.
5. Map each observed behavior to the v0.6 workflow table.
6. List the smallest changes required for Slice 1.

Only after this audit should implementation of task creation begin.
