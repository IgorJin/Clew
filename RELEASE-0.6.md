# Clew v0.6.0 release sign-off

Date: 2026-09-03

## Release goal

Separate execution from the Controller through one authenticated outbound Runner connection with durable at-least-once delivery, idempotency, lease fencing, and explicit recovery after ambiguous loss.

## Included

- Controller/Runner protocol v1 schemas, validators, compatibility negotiation, fake peers, payload bounds, and transport security rules;
- `clew runner serve|status`, stable Runner identity, restrictive credential-file loading, process ownership, and safe diagnostics;
- outbound authenticated WebSocket registration, heartbeat, bounded reconnect, and durable Runner outbox/inbound ledger;
- Controller Runner gateway, one-Runner health projection, durable commands/inbox/results, lease epochs, fencing, cancellation, and restart recovery;
- Scheduler `--execution paired` path preserving Quick execution, Standard review/retry, and Deep Runner-side architecture, approval-gated DAG, isolated worktrees, dependency integration, and final review while local execution remains the default;
- Runner-local harness execution and terminal capability without PTY proxying or Controller host-path authority;
- migration 17 for Controller Runner state and a separate versioned Runner SQLite store.

## Required checks

| Gate                      | Command or evidence                                                       | Result                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Protocol/components       | focused Runner, gateway, lease, execution-port suites                     | pass, including duplicate/reorder/delay, dropped ACK replay, cancellation race, heartbeat, fencing, and restart |
| Real transport            | loopback authenticated WebSocket Quick/Standard/Deep Scheduler acceptance | pass without skips; six durable leases prove Standard review and Deep architect/DAG/integration lifecycle       |
| Backend                   | unsandboxed `npm test`                                                    | pass: 174/174 tests, zero failures, zero skips                                                                  |
| UI/local regression       | `npm run ui:check` and existing local suites                              | pass: 16/16 UI tests and unchanged local execution regression                                                   |
| Formatting/lint/cards     | `npm run check`                                                           | pass                                                                                                            |
| v0.5 migration            | `test/release-v06.test.js`                                                | pass: populated schema 16 state upgrades to 17 with local Run/history preserved                                 |
| Installed artifact        | `npm run acceptance:installed`                                            | pass: clean `clew-0.6.0.tgz`, separate Controller/Runner process, paired Quick/Standard/Deep, clean SIGTERM     |
| Live Codex on Runner host | `npm run smoke:codex-runner`                                              | pass: paired `READY`, revision `5af4110308fdf643658a68cbb754df75ff148a2f`, primary checkout untouched           |
| Publication               | commit, tag, push, GitHub release with npm-format tarball                 | performed as the final release action; public npm namespace is unavailable                                      |

## Configuration

Controller user config may define `controllerRunner.runnerId` and a restrictive `credentialFile`; equivalent environment variables are `CLEW_CONTROLLER_RUNNER_ID` and `CLEW_CONTROLLER_RUNNER_TOKEN` or `CLEW_CONTROLLER_RUNNER_CREDENTIAL_FILE`.

Runner user config defines `runner.id`, `controllerUrl`, `credentialFile`, `stateDir`, capabilities, and logical workspace mappings. Environment equivalents include `CLEW_RUNNER_ID`, `CLEW_RUNNER_CONTROLLER`, `CLEW_RUNNER_TOKEN` or `CLEW_RUNNER_CREDENTIAL_FILE`, and `CLEW_RUNNER_STATE_DIR`. Non-loopback Controller URLs require `wss://`.

Start the Controller daemon, then `clew runner serve` on the execution host. Submit work with `clew run TASK --execution paired`; omit the flag for the unchanged local path.

## Publication decision

The public npm name `clew` is owned by an unrelated maintainer and is therefore not a valid publication target for this project. The release publishes the tested npm-format `clew-0.6.0.tgz` as a GitHub Release asset alongside GitHub source archives. Selecting a new npm package identity is a separate compatibility decision and is not hidden inside this release.

## Recovery and security decision

An accepted or running lease never returns to available because a socket disappears. Controller restart or Runner loss marks ambiguous work `recovering`; no automatic duplicate execution occurs. Credentials, environment values, arbitrary files, harness-generated prompts, hidden reasoning, raw native output, host paths, and PTY bytes are excluded from Controller persistence and public projections. The bounded public Task contract and normalized plans/reviews/evidence are the only execution content crossing the transport. Terminal access remains `runner_local`.

## Final review findings closed

- Replaced the candidate's single generic paired path with stage-level transport so Standard review/retry and Deep planning/DAG/integration semantics are preserved.
- Moved native architecture and review operations to Runner, and retained native session/turn provenance in Controller Runs.
- Added Runner-owned Git worktrees and dependency revision integration so parallel Deep stages never share one mutable checkout.
- Rejected product major/minor skew before registration mutation and made heartbeat timeout update durable health/recovery state synchronously.
- Preserved completed results when a late `already_terminal` cancellation acknowledgment arrives.
- Removed a stale hard-coded read-only Codex worker prompt exposed by the live paired smoke.
