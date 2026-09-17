/** Legacy harness-name mapping for CLEW-128.
 *
 * Bridges the old world (`--harness codex`, `codexBin`, `models.*`) to
 * connections. Full CLI routing and doctor wiring belong to CLEW-130;
 * this card provides the mapping, the exclusivity rule, and the
 * scheduler-side connection selection used by tests.
 */

import { PLUGIN_ERROR_CODE, PluginError } from './errors.js';
import { ConnectionResolver } from './resolver.js';
import { PluginRegistry } from './registry.js';
import { CODEX_DEFAULT_CONNECTION_ID, CODEX_RUNTIME_PLUGIN_ID } from './codex/manifest.js';
import { OPENCODE_DEFAULT_CONNECTION_ID, OPENCODE_RUNTIME_PLUGIN_ID } from './opencode/manifest.js';
import { registerCodexPlugin } from './codex/index.js';
import { registerOpenCodePlugin } from './opencode/index.js';
import { createCodexArchitect, createCodexReviewer } from './codex/role-services.js';
import { OTEL_SINK_PLUGIN_ID, TELEMETRY_DEFAULT_CONNECTION_ID } from './telemetry/manifest.js';

/** Role-service wrappers (CLEW-128 transition).
 *
 * Bind an already-built harness-style executor to the Codex role service.
 * Lets call sites honor their own harness construction (factories,
 * injected resolvers) without importing the Codex module directly.
 */
export function wrapCodexReviewer(harness) {
  return createCodexReviewer({ asLegacyHarness: () => harness });
}

export function wrapCodexArchitect(harness) {
  return createCodexArchitect({ asLegacyHarness: () => harness });
}

export const LEGACY_CONNECTION_IDS = Object.freeze({
  codex: CODEX_DEFAULT_CONNECTION_ID,
  opencode: OPENCODE_DEFAULT_CONNECTION_ID,
  fake: 'fake-default',
});

export function buildLegacyCodexConnection({ codexBin = null, model = null } = {}) {
  const bin = codexBin ?? process.env.CLEW_CODEX_BIN ?? 'codex';

  if (typeof bin !== 'string' || !bin)
    throw new PluginError(
      PLUGIN_ERROR_CODE.INVALID_CONFIG,
      'legacy codexBin must be a non-empty executable name or path',
    );

  const connection = {
    id: CODEX_DEFAULT_CONNECTION_ID,
    plugin: CODEX_RUNTIME_PLUGIN_ID,
    enabled: true,
    config: { bin, ...(model ? { model } : {}) },
  };
  const diagnostics = [
    {
      connection: CODEX_DEFAULT_CONNECTION_ID,
      // Secret-safe: the bin value itself (often an absolute host path)
      // never leaves the host; only the setting source is named.
      source: 'codexBin',
      message: `codexBin setting mapped to legacy connection "${CODEX_DEFAULT_CONNECTION_ID}"; prefer an explicit connection instead`,
    },
  ];

  return { connection, diagnostics };
}

export function assertHarnessConnectionExclusive({ harness = null, connection = null } = {}) {
  if (harness !== null && harness !== undefined && connection !== null && connection !== undefined)
    throw new PluginError(
      PLUGIN_ERROR_CODE.INVALID_CONFIG,
      'Specify either --harness or --connection, not both: --harness selects a legacy runtime by name while --connection selects a configured plugin connection',
    );
}

export function selectCodexConnectionId(adapterConfig = {}) {
  assertHarnessConnectionExclusive({
    harness: adapterConfig.explicitHarness ?? null,
    connection: adapterConfig.connection ?? null,
  });

  return adapterConfig.connection ?? LEGACY_CONNECTION_IDS.codex;
}

export function selectOpenCodeConnectionId(adapterConfig = {}) {
  assertHarnessConnectionExclusive({
    harness: adapterConfig.explicitHarness ?? null,
    connection: adapterConfig.connection ?? null,
  });

  return adapterConfig.connection ?? LEGACY_CONNECTION_IDS.opencode;
}

export function buildLegacyOpenCodeConnection({ openCodeUrl = null, model = null } = {}) {
  const baseUrl = openCodeUrl ?? process.env.CLEW_OPENCODE_URL ?? 'http://127.0.0.1:4096';

  if (typeof baseUrl !== 'string' || !baseUrl)
    throw new PluginError(
      PLUGIN_ERROR_CODE.INVALID_CONFIG,
      'legacy openCodeUrl must be a non-empty server URL',
    );

  const connection = {
    id: OPENCODE_DEFAULT_CONNECTION_ID,
    plugin: OPENCODE_RUNTIME_PLUGIN_ID,
    enabled: true,
    config: { baseUrl, ...(model ? { model } : {}) },
  };
  const diagnostics = [
    {
      connection: OPENCODE_DEFAULT_CONNECTION_ID,
      source: 'openCodeUrl',
      message: `openCodeUrl setting mapped to legacy connection "${OPENCODE_DEFAULT_CONNECTION_ID}"; prefer an explicit connection instead`,
    },
  ];

  return { connection, diagnostics };
}

/** Ephemeral plugin host behind a legacy config (CLEW-128 transition).
 *
 * Mirrors the old per-call `new CodexHarness(...)` semantics: every call
 * builds a fresh host, so adapter instances are never shared across calls.
 * Production code must prefer an injected long-lived resolver (CLEW-130
 * wires it); this helper keeps legacy call sites behavior-identical.
 */
export function createLegacyCodexResolver(legacyConfig = {}, hostServices = {}) {
  const registry = new PluginRegistry();

  registerCodexPlugin(registry, hostServices);

  const { connection } = buildLegacyCodexConnection(legacyConfig);

  return new ConnectionResolver({ registry, connections: [connection], allowFake: false });
}

function legacyCodexAdapter(adapterConfig = {}, hostServices = {}) {
  const resolver = createLegacyCodexResolver({ codexBin: adapterConfig.codexBin }, hostServices);

  return resolver.resolve({ connectionId: LEGACY_CONNECTION_IDS.codex });
}

function resolveAdapter({
  resolver = null,
  adapterConfig = {},
  hostServices = {},
  connectionId = null,
}) {
  const selected = connectionId ?? selectCodexConnectionId(adapterConfig);

  if (resolver) return resolver.resolve({ connectionId: selected });

  return legacyCodexAdapter(adapterConfig, hostServices);
}

export function resolveCodexHarness({
  resolver = null,
  adapterConfig = {},
  hostServices = {},
  connectionId = null,
} = {}) {
  const adapter = resolveAdapter({ resolver, adapterConfig, hostServices, connectionId });

  return adapter.asLegacyHarness();
}

export function resolveOpenCodeHarness({
  resolver = null,
  adapterConfig = {},
  hostServices = {},
  connectionId = null,
} = {}) {
  const selected = connectionId ?? selectOpenCodeConnectionId(adapterConfig);

  if (resolver) return resolver.resolve({ connectionId: selected }).asLegacyHarness();

  const registry = new PluginRegistry();

  registerOpenCodePlugin(registry, hostServices);

  const { connection } = buildLegacyOpenCodeConnection({ openCodeUrl: adapterConfig.openCodeUrl });
  const ephemeral = new ConnectionResolver({
    registry,
    connections: [connection],
    allowFake: false,
  });

  return ephemeral.resolve({ connectionId: selected }).asLegacyHarness();
}

function assertCodexRoleAdapter(adapter, role, connectionId) {
  const plugin = adapter?.describe?.().plugin;

  if (plugin !== CODEX_RUNTIME_PLUGIN_ID)
    throw new PluginError(
      PLUGIN_ERROR_CODE.UNSUPPORTED_CAPABILITY,
      `agent role "${role}" requires the codex runtime (structured output + read-only), but connection "${connectionId}" provides "${plugin ?? 'unknown'}": refusing before execution instead of degrading silently`,
      { connectionId, pluginId: plugin ?? null },
    );
}

export function resolveCodexReviewer({
  resolver = null,
  adapterConfig = {},
  hostServices = {},
  connectionId = null,
} = {}) {
  const adapter = resolveAdapter({
    resolver,
    adapterConfig,
    hostServices,
    connectionId,
  });

  assertCodexRoleAdapter(adapter, 'reviewer', connectionId ?? LEGACY_CONNECTION_IDS.codex);

  return createCodexReviewer(adapter, { model: adapterConfig.models?.reviewer ?? null });
}

export function resolveCodexArchitect({
  resolver = null,
  adapterConfig = {},
  hostServices = {},
  connectionId = null,
} = {}) {
  const adapter = resolveAdapter({
    resolver,
    adapterConfig,
    hostServices,
    connectionId,
  });

  assertCodexRoleAdapter(adapter, 'architect', connectionId ?? LEGACY_CONNECTION_IDS.codex);

  return createCodexArchitect(adapter, { model: adapterConfig.models?.architect ?? null });
}

/** Legacy role-model defaults (CLEW-130).
 *
 * The historical Codex reviewer default (`gpt-5.6-luna`, previously in
 * `DEFAULT_CONFIG`) lives here — in the legacy mapping, not in core.
 * Every other role defaults to the runtime default (`null`).
 */
export const LEGACY_REVIEWER_MODEL = 'gpt-5.6-luna';

export function legacyDefaultModel(role, pluginId) {
  if (role === 'reviewer' && pluginId === CODEX_RUNTIME_PLUGIN_ID) return LEGACY_REVIEWER_MODEL;

  return null;
}

/** Legacy OTel sink connection bridge (CLEW-132).
 *
 * Maps the classic observability settings (`enabled`, `endpoint`, queue
 * bounds) to the `otel-main` connection. Telemetry stays off by default;
 * an explicit disable resolves but never emits.
 */
export function buildLegacyTelemetryConnection({
  enabled = false,
  endpoint = null,
  serviceName = null,
  maxQueueSize = null,
  exportTimeoutMs = null,
} = {}) {
  const config = {};

  if (endpoint !== null && endpoint !== undefined) config.endpoint = endpoint;
  if (serviceName !== null && serviceName !== undefined) config.serviceName = serviceName;
  if (maxQueueSize !== null && maxQueueSize !== undefined) config.maxQueueSize = maxQueueSize;
  if (exportTimeoutMs !== undefined && exportTimeoutMs !== null)
    config.exportTimeoutMs = exportTimeoutMs;

  const connection = {
    id: TELEMETRY_DEFAULT_CONNECTION_ID,
    plugin: OTEL_SINK_PLUGIN_ID,
    enabled: enabled === true,
    config,
  };
  const diagnostics = enabled
    ? [
        {
          connection: TELEMETRY_DEFAULT_CONNECTION_ID,
          source: 'observability',
          message: `observability settings mapped to legacy connection "${TELEMETRY_DEFAULT_CONNECTION_ID}"; prefer an explicit connection instead`,
        },
      ]
    : [];

  return { connection, diagnostics };
}

/** Legacy harness-name to plugin-id map for doctor filtering (CLEW-130). */
export const LEGACY_PLUGIN_IDS = Object.freeze({
  codex: CODEX_RUNTIME_PLUGIN_ID,
  opencode: OPENCODE_RUNTIME_PLUGIN_ID,
});
