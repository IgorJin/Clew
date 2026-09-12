/** Connection resolver for CLEW-127.
 *
 * A connection binds a plugin to host-owned runtime settings
 * (`{ id, plugin, enabled, config }`). Binaries, endpoints, and credentials
 * live here — never in project config and never in core defaults. The
 * resolver checks the connection, the plugin version, host policy, and the
 * required capabilities of a specific launch before execution.
 */

import { PLUGIN_ERROR_CODE, PluginError } from './errors.js';
import { FAKE_RUNTIME_PLUGIN_ID } from './fake-runtime.js';
import { validateConfigValue } from './validate-config.js';

function normalizeHostPolicy(hostPolicy) {
  if (hostPolicy === null || hostPolicy === undefined) return { allowedConnections: null };
  if (typeof hostPolicy !== 'object' || Array.isArray(hostPolicy))
    throw new PluginError(
      PLUGIN_ERROR_CODE.INVALID_CONFIG,
      'host policy must be an object with an optional allowedConnections array',
    );

  const { allowedConnections } = hostPolicy;

  if (allowedConnections === undefined || allowedConnections === null)
    return { allowedConnections: null };

  if (!Array.isArray(allowedConnections) || allowedConnections.some((id) => typeof id !== 'string'))
    throw new PluginError(
      PLUGIN_ERROR_CODE.INVALID_CONFIG,
      'host policy allowedConnections must be an array of connection IDs',
    );

  return { allowedConnections: Object.freeze([...allowedConnections]) };
}

function normalizeConnection(connection) {
  if (!connection || typeof connection !== 'object' || Array.isArray(connection))
    throw new PluginError(PLUGIN_ERROR_CODE.INVALID_CONFIG, 'connection must be an object');

  const { id, plugin, enabled, config } = connection;

  if (typeof id !== 'string' || !id)
    throw new PluginError(
      PLUGIN_ERROR_CODE.INVALID_CONFIG,
      'connection requires a non-empty string id',
    );

  if (typeof plugin !== 'string' || !plugin)
    throw new PluginError(
      PLUGIN_ERROR_CODE.INVALID_CONFIG,
      `connection "${id}" requires a non-empty plugin id`,
      { connectionId: id },
    );

  return { id, plugin, enabled: enabled !== false, config: config ?? {} };
}

export class ConnectionResolver {
  constructor({ registry, connections = [], hostPolicy = null, allowFake = false } = {}) {
    if (
      !registry ||
      typeof registry.get !== 'function' ||
      typeof registry.createAdapter !== 'function'
    )
      throw new PluginError(
        PLUGIN_ERROR_CODE.INVALID_CONFIG,
        'connection resolver requires a plugin registry',
      );

    this.registry = registry;
    this.allowFake = allowFake === true;
    this.hostPolicy = normalizeHostPolicy(hostPolicy);
    this.connections = new Map();
    this.adapters = new Map();

    for (const connection of connections) this.addConnection(connection);
  }

  addConnection(connection) {
    const normalized = normalizeConnection(connection);

    if (this.connections.has(normalized.id))
      throw new PluginError(
        PLUGIN_ERROR_CODE.INVALID_CONFIG,
        `duplicate connection id "${normalized.id}"`,
        { connectionId: normalized.id },
      );

    this.connections.set(normalized.id, normalized);

    return normalized;
  }

  resolve({ connectionId, requireCapabilities = [] } = {}) {
    const connection = this.connections.get(connectionId);

    if (!connection)
      throw new PluginError(
        PLUGIN_ERROR_CODE.UNKNOWN_ID,
        `unknown connection id "${connectionId}"`,
        { connectionId },
      );

    if (!connection.enabled)
      throw new PluginError(
        PLUGIN_ERROR_CODE.DISABLED,
        `connection "${connectionId}" is disabled`,
        { connectionId },
      );

    if (
      this.hostPolicy.allowedConnections !== null &&
      !this.hostPolicy.allowedConnections.includes(connectionId)
    )
      throw new PluginError(
        PLUGIN_ERROR_CODE.HOST_POLICY_DENIED,
        `connection "${connectionId}" is not allowed by the execution-host policy`,
        { connectionId },
      );

    const entry = this.registry.get(connection.plugin);

    if (connection.plugin === FAKE_RUNTIME_PLUGIN_ID && !this.allowFake)
      throw new PluginError(
        PLUGIN_ERROR_CODE.FAKE_NOT_ALLOWED,
        `connection "${connectionId}" uses the fake test runtime, which requires an explicit test route`,
        { connectionId, pluginId: connection.plugin },
      );

    validateConfigValue(
      entry.manifest.configSchema,
      connection.config,
      `connections["${connectionId}"].config`,
    );

    let adapter = this.adapters.get(connectionId);

    if (!adapter) {
      adapter = this.registry.createAdapter(connection.plugin, {
        id: connectionId,
        config: connection.config,
      });
      this.adapters.set(connectionId, adapter);
    }

    const described = adapter.describe() ?? {};
    const capabilities = Array.isArray(described.capabilities) ? described.capabilities : [];
    const missing = requireCapabilities.filter((capability) => !capabilities.includes(capability));

    if (missing.length > 0)
      throw new PluginError(
        PLUGIN_ERROR_CODE.UNSUPPORTED_CAPABILITY,
        `connection "${connectionId}" does not support capabilities: ${missing.join(', ')}`,
        { connectionId, pluginId: connection.plugin },
      );

    return adapter;
  }

  describeConnection(connectionId) {
    const connection = this.connections.get(connectionId);

    if (!connection)
      throw new PluginError(
        PLUGIN_ERROR_CODE.UNKNOWN_ID,
        `unknown connection id "${connectionId}"`,
        { connectionId },
      );

    return { id: connection.id, plugin: connection.plugin, enabled: connection.enabled };
  }

  listConnections() {
    return [...this.connections.keys()].map((id) => this.describeConnection(id));
  }

  async dispose() {
    for (const adapter of this.adapters.values()) await adapter.dispose?.();

    this.adapters.clear();
  }
}
