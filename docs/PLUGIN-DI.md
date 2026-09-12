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
  output never leave the host.
- `clew connections list` exposes `{ id, plugin, enabled, capabilities }`
  plus host diagnostics. No secrets, paths, or credentials.
- Session references carry `{ runtime, connection, host, nativeSessionId }`
  and never move between runtimes (resume with a foreign runtime is an
  explicit error). Durable binding snapshots belong to CLEW-131.

## Forbidden

- A generic `execute(type, payload)` RPC: each port stays typed with its
  own failure semantics.
- Marketplace, hot reload, arbitrary package installs, third-party
  frontend code, and out-of-process isolation: separate stage after the
  contract stabilizes.
- Live smoke of external CLIs in this epic: fixtures, fake, and unit
  tests only (epic decision 2026-09-11).
