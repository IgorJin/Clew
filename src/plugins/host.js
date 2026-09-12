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
import { buildLegacyCodexConnection, buildLegacyOpenCodeConnection } from './legacy.js';

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
  { allowFake = false, terminalManager = null } = {},
) {
  const diagnostics = [];
  const registry = new PluginRegistry();

  registerCodexPlugin(registry, {
    terminalManager,
    trustedWorkspaceRoot: runtimeConfig.worktreeRoot ?? null,
    openDesktop: runtimeConfig.openCodexDesktop ?? false,
  });
  registerOpenCodePlugin(registry, {});

  const connections = [];
  const codexLegacy = buildLegacyCodexConnection({ codexBin: runtimeConfig.codexBin });

  connections.push(codexLegacy.connection);
  diagnostics.push(...codexLegacy.diagnostics);

  const openCodeLegacy = buildLegacyOpenCodeConnection({ openCodeUrl: runtimeConfig.openCodeUrl });

  connections.push(openCodeLegacy.connection);
  diagnostics.push(...openCodeLegacy.diagnostics);

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
