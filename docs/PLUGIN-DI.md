# Plugin DI rule and config precedence (CLEW-127)

This note is the normative short form of the DI rule. The full proposal
lives in [PLUGIN-ARCHITECTURE.md](./PLUGIN-ARCHITECTURE.md), sections 2–4.

## DI rule

- The plugin registry is built **only in the composition root**
  (`createPluginHost` from `src/plugins/index.js`, called by `bin/clew.js`
  and the daemon/runner bootstrap). It is never a global or singleton.
- Domain services (`scheduler`, `architect`, `review`, `control-service`,
  `runner-execution`, `session-surface`, `daemon`) receive an
  already-resolved `AgentRuntime` port through constructor injection.
- They never import `src/plugins/registry`, never branch on harness or
  plugin names, and never read binary/endpoint settings. A grep gate in
  `test/plugins-contracts.test.js` enforces this.
- Adapters are connection-scoped; per-run mutable state is isolated by
  `runId`. Repeated `resolve()` of one connection returns the same adapter;
  a fresh host build creates fresh adapters (no cross-restart duplicates).

## Config precedence

- `роль → connection → модель`: project config selects a connection ID
  (and optionally a model) per role. It defines no binaries, module paths,
  endpoints, or credentials.
- Precedence per role: run/stage flag (`--connection`, `--review-connection`,
  `--architect-connection`, `--worker-model`) → environment
  (`CLEW_<ROLE>_CONNECTION`, `CLEW_*_MODEL`) → project (`agents.*`, then
  legacy `models.*` with a migration diagnostic) → user (same order) →
  defaults (`codex-default` connection, `null` model, plus the legacy
  reviewer default on Codex connections).
- `model: null` means the runtime default of that connection. A model ID is
  validated in the context of its connection and never silently replaced or
  carried over to another connection.
- The execution-host owner defines connections
  (`{ id, plugin, enabled, config }`) in the user config. Credentials resolve on that host; only the safe projection
  (`{ id, plugin, enabled }`) reaches Controller, history, and UI.

## Legacy mapping (implemented in CLEW-128–130, not here)

- `codexBin` / `CLEW_CODEX_BIN` / `--codex-bin` → legacy connection
  `codex-default` with `config.bin` plus a migration diagnostic.
- `models.*` → legacy role→connection mapping with a diagnostic.
- `--harness` together with `--connection` is an explicit error.
- The hardcoded reviewer default (`gpt-5.6-luna` in `DEFAULT_CONFIG`)
  moves into the Codex connection defaults in CLEW-130.

## Doctor and safe projection (CLEW-130)

- `clew doctor [--harness H] [--connection ID]` probes connections through
  the plugin `probe()` (binary/endpoint, version, auth state — read-only,
  auth is never changed). Per-connection entries carry `status`
  (`ready/unavailable/disabled/unconfigured/incompatible`), plugin,
  capabilities, and a reason code; binary paths, endpoints, and raw auth
  output never leave the host. Telemetry connections (`otel-main`) covered
  by the same projection since CLEW-132.
- `clew connections list` exposes `{ id, plugin, enabled, capabilities }`
  plus host diagnostics. No secrets, paths, or credentials.
- Session references carry `{ runtime, connection, host, nativeSessionId }`
  and never move between runtimes (resume with a foreign runtime is an
  explicit error). Durable binding snapshots belong to CLEW-131.

## Telemetry sinks (CLEW-132)

- One registry serves runtimes and telemetry: `clew.telemetry.otel`
  (traces via official OTel SDK to OTLP) and `clew.telemetry.test`
  (in-memory, for CI). Legacy `observability.{enabled,endpoint}` maps to
  the `otel-main` connection.
- Core owns event semantics, correlation ids, label allowlist, usage, and
  persistence; the sink owns SDK, exporter, queue, and delivery. Records
  are `{version: 1, signal: 'trace', action: span-start|span-end|instant}`.
- Sinks never throw on the hot path and never hold shutdown (bounded
  flush/dispose). Metrics and log export are out of scope.

## Migration from legacy flags (CLEW-133)

| Legacy input                            | New form                                            | Behavior                               |
| --------------------------------------- | --------------------------------------------------- | -------------------------------------- |
| `--harness codex\|opencode\|fake`       | `--connection <id>`                                 | both at once is an explicit error      |
| `--review-harness`, `--architect`       | `--review-connection`, `--architect-connection`     | same exclusivity rule                  |
| `--worker-model` / `models.*`           | `agents.<role>.model` (fallback: legacy `models.*`) | migration diagnostic, no silent change |
| `codexBin` / `CLEW_CODEX_BIN`           | `codex-default` connection `config.bin`             | diagnostic, host-owned                 |
| `openCodeUrl` / `CLEW_OPENCODE_URL`     | `opencode-default` connection `config.baseUrl`      | diagnostic, host-owned                 |
| `observability.{enabled,endpoint}`      | `otel-main` connection                              | disabled by default                    |
| `models.reviewer: gpt-5.6-luna` default | legacy Codex-connection reviewer default            | out of core config                     |

## Runtime connections vs git-change viewers (CLEW-133)

Two different things, easy to confuse:

- **Runtime connections** are plugin connections (`clew.runtime.codex`,
  `clew.runtime.opencode`, `clew.telemetry.otel`) defined by the execution
  host in the user config. `clew connections list` and the UI Settings →
  Connections chapter show the safe projection; `clew doctor` probes each
  one. For Codex, `probe()` runs `<bin> --version` and `<bin> login status`,
  so a `ready` status with `auth: ok` proves the CLI is installed **and**
  authorized (the account/raw output stays on the host). The real binary is
  resolved by the host (`codexBin`), e.g. macOS
  `/Applications/ChatGPT.app/Contents/Resources/codex`.
- **The service owns host settings.** Connections and default role routing
  are edited through the service/UI and persisted in the **user config**
  (never the project repo):
  - `clew connections show <id>` — raw host config for editing (`source`,
    `reserved`, `config`, `configSchema`);
  - `clew connections save <id> --plugin <pluginId> [--bin PATH] [--base-url URL] [--model M] [--enabled true|false]`
    — validated against the plugin manifest `configSchema`, then written
    atomically; the daemon reloads config immediately;
  - `clew connections remove <id>` — user connections only;
  - `clew agents list` / `clew agents set <role> --connection <id> [--model M]`
    — default role routing, also stored in the user config;
  - reserved legacy ids (`codex-default`, `opencode-default`, `otel-main`)
    cannot be redefined or removed.
- **Codex login from the UI (device code).** `clew connections login <id>`
  starts `codex login --device-auth` through the plugin's optional
  `authenticate()` and returns a verification URL + one-time code while the
  process waits; `clew connections login-status <sessionId>` reports
  `pending`/`authenticated`/`failed` until the browser approval completes.
  The UI Settings → Connections chapter exposes this as a "Log in with
  Codex" button and polls until ready. OpenCode has no interactive auth and
  is refused explicitly.
- **Codex login with an API key (no browser).**
  `clew connections login <id> --with-api-key --api-key <KEY>` pipes the key
  to `codex login --with-api-key` once and never persists it; the same flow
  is exposed in the UI as "API key". Poll `login-status` until it settles.
- **Git-change viewers are NOT plugin connections in this epic.** Inspecting
  changes is the existing v0.8 feature, driven by config + CLI, not by the
  plugin registry:
  - `clew task changes <RUN-ID>` — summary, files, unified patch;
  - `clew task inspect-changes <RUN-ID>` — the inspection service's raw result;
  - `clew task open-changes <TASK> [--run <RUN-ID>] [--viewer cursor|vscode|worktree-path]`.
  - Config keys: `changeViewer` (`null` | `cursor` | `vscode` | `worktree-path`)
    and `editorBin` (`code` by default); env `CLEW_CHANGE_VIEWER`,
    `CLEW_EDITOR_BIN`. Viewer priority: explicit `--viewer`/`changeViewer` →
    Cursor → VS Code; path copying is explicit only.
  - The extensible `ChangeViewer` and `WorkspaceOpener` **extension points**
    (Fork, Tower, Kaleidoscope, GitHub Desktop, JetBrains, …) are deferred to
    the P6 iteration in `PLUGIN-ARCHITECTURE.md`; they will reuse the same
    registry when implemented.

## Deferred to later releases (CLEW-133)

- Claude Code runtime, plugin marketplace / hot reload / third-party code,
  metrics and log export, `PricingSource`, `TerminalLauncher`,
  `WorkspaceOpener`, `ChangeViewer`, workflow constructor UX.
- Terminal surfaces and `session open` stay on `--harness` (no
  `--connection` support yet — explicit error).
- No live smoke of external CLIs is required by this epic (decision
  2026-09-11): fixtures, fake runtimes, and unit tests are the
  compatibility evidence.

## Compatibility

- Plugin API v1, `AgentRuntime` v1, `TelemetrySink` v1. Runner wire stays
  at protocol v1 with additive optional fields (`runtimeInventory`,
  `binding`); negotiation is capability-based (`plugin-bindings`), so v1
  runners interoperate and refuse plugin routes explicitly.
- Run bindings are exact-match (plugin id/version/API + connection);
  drift means explicit recovery, never an automatic runtime switch.
- Pre-plugin runs have no binding row and read as `legacy-unknown`
  with history intact (migration v24).

## Forbidden

- A generic `execute(type, payload)` RPC: each port stays typed with its
  own failure semantics.
- Marketplace, hot reload, arbitrary package installs, third-party
  frontend code, and out-of-process isolation: separate stage after the
  contract stabilizes.
- Live smoke of external CLIs in this epic: fixtures, fake, and unit
  tests only (epic decision 2026-09-11).
