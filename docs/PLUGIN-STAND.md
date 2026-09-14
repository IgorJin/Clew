# Plugin acceptance stand (CLEW-127–133)

Manual, hands-on verification of the plugin architecture. It runs against
the real modules with fixtures and fake runtimes only — no external Codex /
OpenCode CLI, no network, no OTel collector. Use it before signing off the
epic or when reviewing a change to `src/plugins/**`.

## Run it

```sh
npm run stand:plugins                       # everything, temp workspace removed
node scripts/plugins-stand.js --keep        # keep the temp workspace
node scripts/plugins-stand.js --step        # pause for Enter between sections
node scripts/plugins-stand.js --json        # machine-readable summary
node scripts/plugins-stand.js --section 127,128
```

Exit code is non-zero when any check fails. The report prints one line per
check plus a per-section summary.

## What it proves (map to task cards)

| Section | Card              | Checks                                                                                                                                                                                                                |
| ------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 127     | Plugin API v1     | manifest validation, duplicate/unknown ids, incompatible API, unsupported capability, fake route gating, adapter stability, DI grep gate, project-config secret/host-field rejection                                  |
| 128     | Codex runtime     | direct-vs-adapter equivalence, approval round-trip, abort, resume, legacy `codexBin` mapping + conflict rule                                                                                                          |
| 129     | OpenCode runtime  | message flow, SSE flow with approval, structured-output refusal (0 HTTP calls), truncated SSE → protocol error, malformed model omission, foreign-session refusal                                                     |
| 130     | Routing           | precedence flag→env→project→user→default, legacy reviewer default (codex only), foreign role refusal, doctor reason codes with no path leaks, safe `connections list` projection, `--harness`/`--connection` conflict |
| 131     | Bindings / paired | deterministic fingerprint, pinned local parallel stage run, `legacy-unknown` + corrupt-row handling, secret-free Runner inventory, v1-runner refusal                                                                  |
| 132     | Telemetry sink    | disabled no-op, lifecycle through test sink with redaction + persisted correlation, failing sink drops without touching history, replay dedupe                                                                        |
| 133     | Release           | fourth-runtime plug-in proof, grep gate, docs presence                                                                                                                                                                |

## Verify by hand (beyond the stand)

The stand is automated, but a few guarantees are easiest to confirm
directly. Run these in a scratch repo after `node bin/clew.js init`:

```sh
# Connections are visible as a safe projection (no paths/secrets):
node bin/clew.js connections list

# Doctor explains unavailable runtimes without leaking host paths:
node bin/clew.js doctor
node bin/clew.js doctor --harness codex
node bin/clew.js doctor --connection opencode-default

# The old and new selectors cannot be combined:
node bin/clew.js run SOME-TASK --harness codex --connection codex-default   # explicit error

# Session surfaces are still harness-based (P6 deferred):
node bin/clew.js session open SOME-TASK --connection codex-default          # explicit "not yet"
```

Config migration (create a scratch `.clew.json`):

```json
{
  "agents": {
    "worker": { "connection": "opencode-work", "model": null },
    "reviewer": { "connection": "codex-work", "model": null }
  }
}
```

- A project `.clew.json` with a secret (`token`) or a host-level field
  (`bin`, `endpoint`, `credential`) is rejected at load time.
- Legacy `models.*` and `codexBin`/`openCodeUrl` keep working but surface a
  migration diagnostic.

## Localhost daemon lab

`stand:plugins` runs in-process. When you want a **real daemon on
localhost** with its own state, config, fake runtimes, and UI, use the lab:

```sh
npm run stand:serve      # boot daemon + fake Codex + OpenCode stub, leave running
npm run stand:status     # endpoints, health, connections, tasks
npm run stand:stop       # stop daemon + stub (keep files)
npm run stand:reset      # stop and delete .clew-stand/
```

`stand:serve` creates an isolated stand under `./.clew-stand/` (gitignored):

- `project/` — a git repo with its own `.clew` state and `.clew.json`
  routing `worker/reviewer → codex-stand`, `architect → codex-plan`,
  `qa → opencode-stand`;
- `home/config.json` — host connections pointing at the fakes:
  `codex-stand` and `codex-plan` run wrapper scripts around
  `fixtures/fake-codex-server.js` and `fixtures/stand/codex-plan-server.js`;
  `opencode-stand` points at `scripts/stand/opencode-stub-server.js`
  (HTTP + SSE, no provider);
- `clew` — a wrapper that pins `CLEW_USER_CONFIG` and the project cwd.

Use the wrapper for everything so the daemon, config, and state line up:

```sh
.clew-stand/clew daemon status
.clew-stand/clew connections list
.clew-stand/clew doctor
.clew-stand/clew run STAND-QUICK                                  # fake Codex worker
.clew-stand/clew run STAND-STANDARD                               # worker + reviewer
.clew-stand/clew run STAND-OPENCODE --connection opencode-stand   # OpenCode SSE stub
.clew-stand/clew status STAND-QUICK --watch
.clew-stand/clew task result STAND-QUICK
.clew-stand/clew events STAND-QUICK
```

Open the UI at the printed endpoint (e.g. `http://127.0.0.1:<port>/`); the
token comes from `<project>/.clew/daemon.token`. The lab also shows a
`curl` example for `/api/v1/command`.

Verify the routing actually used the intended plugin connection — every run
is bound (CLEW-131):

```sh
node --input-type=module -e '
  import { DatabaseSync } from "node:sqlite";
  const db = new DatabaseSync(".clew-stand/project/.clew/clew.sqlite");
  for (const r of db.prepare("SELECT runs.task_id, run_bindings.binding FROM runs LEFT JOIN run_bindings ON run_bindings.run_id=runs.id ORDER BY runs.rowid").all())
    console.log(r.task_id, JSON.parse(r.binding).connectionId);
'
```

Deep profile: the project routes `architect` to `codex-plan`, whose fixture
returns a valid DAG, so `run TASK --profile deep` works (plan approval gate
included).

### Real Codex CLI and git changes

The lab also carries the host's **real** Codex connection as `codex-default`
(legacy mapping of `codexBin`, resolved to the actual binary). Use it to
prove a genuine plugin connection and authorization end-to-end:

```sh
.clew-stand/clew doctor --connection codex-default
#   -> status ready, version codex-cli <x.y.z>, auth: ok   (when logged in)
.clew-stand/clew run STAND-QUICK --connection codex-default   # real Codex turn
```

`doctor` calls the plugin `probe()`, which runs `<bin> --version` and
`<bin> login status`; `ready` with `auth: ok` means installed **and**
authorized. The account/raw output never leaves the host — only the boolean
and version reach the UI/doctor output.

The Connections chapter is also an **editable settings surface** backed by
the service:

- **Add / Edit / Remove** host connections (validated against the plugin
  manifest `configSchema`) — saved to the host user config, not the project.
- **Log in with Codex** starts `codex login --device-auth`, shows the
  verification URL and one-time code, and polls until the browser approval
  finishes; **API key** pipes a pasted key to `codex login --with-api-key`
  once (never stored) for a fully browser-free login.
- **Role routing** (`worker`/`architect`/`reviewer`/`qa` → connection +
  model) is saved to the host user config too.

Inspecting **git changes is not a plugin connection** in this release; it is
the v0.8 change-inspection feature driven by config + CLI:

```sh
.clew-stand/clew task changes <RUN-ID>                          # summary, files, patch
.clew-stand/clew task inspect-changes <RUN-ID>
.clew-stand/clew task open-changes STAND-QUICK --run <RUN-ID> \
  --viewer cursor|vscode|worktree-path
```

Configure viewers with `changeViewer` and `editorBin` (env
`CLEW_CHANGE_VIEWER`, `CLEW_EDITOR_BIN`). The extensible `ChangeViewer` /
`WorkspaceOpener` plugin extension points are deferred to P6 (see
`PLUGIN-ARCHITECTURE.md` and the "Runtime connections vs git-change viewers"
section of `PLUGIN-DI.md`).

## Interpreting results

- A red row means a guarantee regressed; the message names the assertion.
- `--keep` prints the temp workspace so you can inspect the SQLite state,
  generated worktrees, and fixtures.
- The stand is also a smoke test for the fixtures used by the automated
  suites; a fixture change that breaks the stand will usually break the
  matching `test/plugins-*.test.js` too.

## Out of scope

Live smoke of the real CLIs, a real OTel collector, metrics/log export,
pricing sources, terminal/IDE launchers, and the workflow constructor are
deferred (see `PLUGIN-DI.md`, section "Deferred to later releases").
