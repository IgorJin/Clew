# v0.1 acceptance matrix

The release criteria in `spec.md` section 24 map to the following evidence.

| #   | Criterion                                            | Evidence                                                                    |
| --- | ---------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | Codex initialize/thread/turn/tool/completion         | Automated fixture: `test/harness-conformance.test.js`; live procedure below |
| 2   | OpenCode session/turn/events/completion/failure      | Automated SSE conformance; live `1.18.23` session/SSE/failure sign-off      |
| 3   | Harness cwd uses an isolated worktree                | `test/acceptance.test.js`, `test/workspace.test.js`                         |
| 4   | Architect plan is schema-valid before execution      | `test/architect.test.js`, scheduler Deep tests                              |
| 5   | DAG dependencies do not double-start                 | scheduler DAG/concurrency tests                                             |
| 6   | Verification is correlated to run/workspace/revision | Quick/Deep tests and successful native Codex command-evidence smoke         |
| 7   | Harness completion cannot directly complete a task   | harness conformance and Quick scheduler tests                               |
| 8   | Blocking review creates a bounded new attempt        | Standard feedback/session retry and Deep routed-timeout tests               |
| 9   | Restart preserves and reconciles in-flight work      | single-worker and Deep recovery scheduler tests                             |
| 10  | Event history explains every task                    | store, CLI and clean-checkout acceptance tests                              |

## Live Codex procedure

1. Run `node bin/clew.js doctor --harness codex` and require `ok: true`.
2. Create a disposable Git repository with one commit and initialize Clew.
3. Create a Quick task and run it with `--harness codex`.
4. Confirm `SESSION_STARTED`, `TURN_STARTED`, tool events, `HARNESS_COMPLETED`, verification and the final state in `clew events ID`.
5. Repeat once with an approval request and once with `clew interrupt ID` from a second process.

Release evidence on 2026-08-27: `npm run smoke:codex` passed against Codex `0.148.0`; command evidence was linked to `AC-1`, committed, and the primary checkout remained untouched. `npm run smoke:codex-roles` also passed: native read-only architect and reviewer outputs satisfied their strict schemas and did not modify the workspace.

## Live OpenCode procedure

1. Start OpenCode `1.18.23` in server mode and set `CLEW_OPENCODE_URL`.
2. Run `node bin/clew.js doctor --harness opencode` and require `ok: true`.
3. Run `npm run smoke:opencode` or a disposable Quick task with `--harness opencode`.
4. Confirm the persisted session/turn identity, terminal event, interrupt behavior and session resume after a simulated Clew restart.

Release evidence on 2026-08-27: OpenCode `1.18.23` created a real session, accepted an async prompt, streamed correlated events, executed a tool, recorded passing command evidence for `AC-1`, committed the result, reached `READY`, and left the primary checkout untouched. A separate unavailable-provider run proved correlated retry/failure diagnostics without a false `READY`.

The live procedures are release-signoff checks because they require local credentials, a working model provider and external processes. Fixture coverage remains mandatory in CI.
