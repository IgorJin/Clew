/** Run binding snapshots for CLEW-131.
 *
 * An immutable binding pins the exact runtime a run was launched with:
 * plugin id/version, Plugin API version, connection, execution host,
 * capability snapshot, model, and a secret-free config fingerprint. It is
 * written before execution and re-checked after restarts; a mismatch means
 * explicit recovery, never an automatic switch to another runtime. Runs
 * without a binding row predate plugins and read as `legacy-unknown`
 * without losing history.
 */

import { createHash } from 'node:crypto';
import { PLUGIN_ERROR_CODE, PluginError } from './errors.js';

export const RUN_BINDING_VERSION = 1;

export function fingerprintConnectionConfig(config = {}) {
  return createHash('sha256').update(stableStringify(config)).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;

  return JSON.stringify(value) ?? 'null';
}

export function buildRunBinding({
  runId,
  taskId = null,
  stageId = null,
  attempt = null,
  connectionId,
  adapter,
  registry,
  model = null,
  executionHost = 'local',
} = {}) {
  if (typeof runId !== 'string' || !runId)
    throw new PluginError(PLUGIN_ERROR_CODE.INVALID_CONFIG, 'run binding requires a run id');

  if (!adapter || typeof adapter.describe !== 'function')
    throw new PluginError(
      PLUGIN_ERROR_CODE.INVALID_CONFIG,
      'run binding requires a resolved runtime adapter',
    );

  const described = adapter.describe() ?? {};
  const pluginId = described.plugin;

  if (typeof pluginId !== 'string' || !pluginId)
    throw new PluginError(
      PLUGIN_ERROR_CODE.INVALID_CONFIG,
      'run binding requires the adapter plugin id',
    );

  const manifest = registry?.get(pluginId)?.manifest;

  if (!manifest)
    throw new PluginError(PLUGIN_ERROR_CODE.UNKNOWN_ID, `unknown plugin id "${pluginId}"`, {
      pluginId,
    });

  return Object.freeze({
    version: RUN_BINDING_VERSION,
    runId,
    taskId,
    stageId,
    attempt,
    pluginId,
    pluginVersion: manifest.version,
    pluginApiVersion: manifest.apiVersion,
    connectionId,
    executionHost,
    cliVersion: null,
    capabilitySnapshot: [...(described.capabilities ?? [])],
    model,
    configFingerprint: fingerprintConnectionConfig(adapter.config ?? {}),
    createdAt: new Date().toISOString(),
  });
}

function incompatible(binding, reason) {
  return { compatible: false, reason, binding };
}

/** Check a saved binding against the current host (CLEW-131).
 *
 * Exact match on plugin id/version/API version and a known, enabled
 * connection. Anything else is explicit recovery — the core never
 * re-routes the run to a different runtime on its own.
 */
export function checkBindingCompatible(binding, { registry, resolver } = {}) {
  if (!binding || typeof binding !== 'object') return incompatible(binding, 'missing run binding');

  if (binding.version !== RUN_BINDING_VERSION)
    return incompatible(binding, `unsupported binding version ${JSON.stringify(binding.version)}`);

  if (!registry || typeof registry.has !== 'function')
    return incompatible(binding, 'no plugin registry available for the compatibility check');

  if (!registry.has(binding.pluginId))
    return incompatible(
      binding,
      `plugin "${binding.pluginId}" is not registered on this host: recovery required, automatic runtime switch is forbidden`,
    );

  const manifest = registry.get(binding.pluginId).manifest;

  if (manifest.version !== binding.pluginVersion)
    return incompatible(
      binding,
      `plugin "${binding.pluginId}" is at version ${manifest.version} but the run was bound to ${binding.pluginVersion}: recovery required`,
    );

  if (manifest.apiVersion !== binding.pluginApiVersion)
    return incompatible(
      binding,
      `plugin "${binding.pluginId}" provides Plugin API ${manifest.apiVersion} but the run was bound to API ${binding.pluginApiVersion}: recovery required`,
    );

  if (resolver && typeof resolver.describeConnection === 'function') {
    let connection;

    try {
      connection = resolver.describeConnection(binding.connectionId);
    } catch {
      connection = null;
    }

    if (!connection)
      return incompatible(
        binding,
        `connection "${binding.connectionId}" is unknown on this host: recovery required`,
      );

    if (!connection.enabled)
      return incompatible(
        binding,
        `connection "${binding.connectionId}" is disabled: recovery required`,
      );
  }

  return { compatible: true, binding };
}
