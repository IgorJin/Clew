# Clew v0.4.0 release candidate sign-off

Date: 2026-08-28

## Scope

v0.4 integrates the local daemon/API, Task Thread projection, bounded continuation and review exhaustion handoff, native Session Surface, and the Preact Web UI. The package version is `0.4.0`; the UI bundle is included in the npm artifact.

## Required checks

| Gate               | Command or evidence                    | Result                                                                                                |
| ------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Source/toolchain   | `npm run check`                        | pass: formatting, lint, task cards, UI build/lint/tests, 109 Node tests (4 loopback skips in sandbox) |
| Migration          | `node --test test/release-v04.test.js` | pass: populated v0.3 fixture upgraded to schema 15 with history preserved and SQLite integrity `ok`   |
| Daemon/API         | `node --test test/daemon.test.js`      | pass: auth, owner, parse containment, Task Thread, WS Origin, replay cursor, UI/bootstrap             |
| UI                 | `npm run ui:check`                     | pass: Preact build, lint, 10 tests plus production disconnect/restart browser smoke                   |
| Installed artifact | `npm run acceptance:installed`         | pass: clean install, Quick/Standard/Deep via API, continuation, UI, WS replay/origin, restart         |
| Live Codex         | `npm run smoke:codex`                  | optional; skipped for this sign-off unless explicit provider credentials are available                |
| Main/tag CI        | release operator                       | pending until the reviewed changes are committed and `v0.4.0` is tagged                               |

## Security and compatibility checks

- Daemon remains loopback-only and requires bearer authentication for API/WS routes.
- Browser bootstrap and WebSocket upgrades accept only the daemon origin; bootstrap issues an HttpOnly, SameSite cookie and tokens are not placed in URLs or the UI bundle.
- Package inspection rejects `.clew` telemetry, `.env`, and `node_modules` leakage and requires the UI and all v0.4 migration sources.
- The migration fixture preserves task, run/session, event, completion, operator action, telemetry, and usage history.
- The UI is Preact-based and renders curated public-safe summaries, not raw event payloads, prompts, tool output, or HTML.

## Operator actions intentionally pending

No git commit, tag, or npm publication was performed. The candidate is ready for those operator gates only after the local checks above are rerun against the final diff.
