/** Execution-host plugin assembly for CLEW-130.
 *
 * Builds the long-lived plugin host from host-owned settings: bundled
 * runtimes plus legacy connections derived from the classic
 * `codexBin`/`openCodeUrl` settings, plus extra connections from the user
 * config. Project-defined connections never merge here; they produce an
 * ignore-with-diagnostic (repository config must not extend host policy).
 */

import { PLUGIN_ERROR_CODE, PluginError } from './errors.js';
import { PluginRegistry } from './registry.js';
import { ConnectionResolver } from './resolver.js';
import { validateConfigValue } from './validate-config.js';
import { registerCodexPlugin } from './codex/index.js';
import { registerOpenCodePlugin } from './opencode/index.js';
import {
  buildLegacyCodexConnection,
  buildLegacyOpenCodeConnection,
  buildLegacyTelemetryConnection,
} from './legacy.js';
import { registerTelemetryPlugins } from './telemetry/index.js';
import { CODEX_RUNTIME_PLUGIN_ID } from './codex/manifest.js';
import { OPENCODE_RUNTIME_PLUGIN_ID } from './opencode/manifest.js';

function assertUserConnectionShape(entry, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry))
    throw new PluginError(
      PLUGIN_ERROR_CODE.INVALID_CONFIG,
      `user config connections[${index}] must be an object`,
    );

  if (typeof entry.id !== 'string' || !entry.id)
    throw new PluginError(
      PLUGIN_ERROR_CODE.INVALID_CONFIG,
      `user config connections[${index}] requires a non-empty string id`,
    );

  if (typeof entry.plugin !== 'string' || !entry.plugin)
    throw new PluginError(
      PLUGIN_ERROR_CODE.INVALID_CONFIG,
      `user config connection "${entry.id}" requires a non-empty plugin id`,
      { connectionId: entry.id },
    );
}

export function buildRuntimeHost(
  runtimeConfig = {},
  { allowFake = false, terminalManager = null, telemetryCwd = null } = {},
) {
  const diagnostics = [];
  const registry = new PluginRegistry();

  registerCodexPlugin(registry, {
    terminalManager,
    trustedWorkspaceRoot: runtimeConfig.worktreeRoot ?? null,
    openDesktop: runtimeConfig.openCodexDesktop ?? false,
  });
  registerOpenCodePlugin(registry, {});
  // CLEW-132: the same registry serves telemetry sinks; the legacy
  // otel-main connection mirrors the classic observability settings.
  registerTelemetryPlugins(registry, { cwd: telemetryCwd ?? process.cwd() });

  const connections = [];
  const codexLegacy = buildLegacyCodexConnection({ codexBin: runtimeConfig.codexBin });

  connections.push(codexLegacy.connection);
  diagnostics.push(...codexLegacy.diagnostics);

  const openCodeLegacy = buildLegacyOpenCodeConnection({ openCodeUrl: runtimeConfig.openCodeUrl });

  connections.push(openCodeLegacy.connection);
  diagnostics.push(...openCodeLegacy.diagnostics);

  const observability = runtimeConfig.observability ?? {};
  const telemetryLegacy = buildLegacyTelemetryConnection({
    enabled: observability.enabled === true,
    endpoint: observability.endpoint ?? null,
    serviceName: observability.serviceName ?? null,
    maxQueueSize: observability.maxQueueSize ?? null,
    exportTimeoutMs: observability.exportTimeoutMs ?? null,
  });

  connections.push(telemetryLegacy.connection);
  diagnostics.push(...telemetryLegacy.diagnostics);

  const projectConnections = runtimeConfig.layers?.connections?.project ?? [];

  if (projectConnections.length > 0)
    diagnostics.push({
      source: 'connections',
      message: `ignored ${projectConnections.length} project-defined connection(s): define connections on the execution host (user config), not in the project`,
    });

  for (const [index, entry] of (runtimeConfig.connections ?? []).entries()) {
    assertUserConnectionShape(entry, index);

    if (!registry.has(entry.plugin))
      throw new PluginError(
        PLUGIN_ERROR_CODE.INVALID_CONFIG,
        `user config connection "${entry.id}" references unknown plugin "${entry.plugin}"`,
        { connectionId: entry.id, pluginId: entry.plugin },
      );

    const normalized = {
      id: entry.id,
      plugin: entry.plugin,
      enabled: entry.enabled !== false,
      config: entry.config ?? {},
    };

    validateConfigValue(
      registry.get(entry.plugin).manifest.configSchema,
      normalized.config,
      `connections["${entry.id}"].config`,
    );
    connections.push(normalized);
  }

  const resolver = new ConnectionResolver({ registry, connections, hostPolicy: null, allowFake });

  return { registry, resolver, diagnostics, connections: resolver.listConnections() };
}

/** Minimal runtime host for the Runner process (CLEW-133).
 *
 * Registers the bundled runtimes with legacy connections derived from the
 * Runner's adapter config. Telemetry stays Controller-side in this epic.
 */
export function buildRunnerHost(adapterConfig = {}, { allowFake = false } = {}) {
  const registry = new PluginRegistry();

  registerCodexPlugin(registry, {
    openDesktop: adapterConfig.openCodexDesktop ?? false,
  });
  registerOpenCodePlugin(registry, {});

  const { connection: codexConnection } = buildLegacyCodexConnection({
    codexBin: adapterConfig.codexBin,
  });
  const { connection: openCodeConnection } = buildLegacyOpenCodeConnection({
    openCodeUrl: adapterConfig.openCodeUrl,
  });
  const resolver = new ConnectionResolver({
    registry,
    connections: [codexConnection, openCodeConnection],
    hostPolicy: null,
    allowFake,
  });

  return { registry, resolver };
}

/** Collect a secret-free runtime inventory for Runner registration (CLEW-131).
 *
 * Only plugin ids/versions/capabilities and connection ids leave the host:
 * no configs, binaries, endpoints, or credentials.
 */
export function collectRunnerInventory({ codexBin = null, openCodeUrl = null } = {}) {
  const registry = new PluginRegistry();

  registerCodexPlugin(registry, {});
  registerOpenCodePlugin(registry, {});

  const { connection: codexConnection } = buildLegacyCodexConnection({ codexBin });
  const { connection: openCodeConnection } = buildLegacyOpenCodeConnection({ openCodeUrl });
  const inventoryFor = (pluginId, connection) => {
    const manifest = registry.get(pluginId).manifest;
    const capabilities =
      registry.createAdapter(pluginId, connection).describe()?.capabilities ?? [];

    return {
      plugin: pluginId,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      capabilities: [...capabilities],
      connections: [{ id: connection.id, enabled: true }],
    };
  };

  return [
    inventoryFor(CODEX_RUNTIME_PLUGIN_ID, codexConnection),
    inventoryFor(OPENCODE_RUNTIME_PLUGIN_ID, openCodeConnection),
  ];
}
