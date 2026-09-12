/** Plugin registry for CLEW-127.
 *
 * The registry is constructed explicitly in the composition root and passed
 * to consumers — it is never a global or a singleton. Duplicate plugin IDs
 * are an error; load order never resolves a conflict.
 */

import { PLUGIN_ERROR_CODE, PluginError } from './errors.js';
import { validatePluginManifest } from './manifest.js';
import { assertAgentRuntime } from './runtime-contract.js';

export class PluginRegistry {
  constructor() {
    this.entries = new Map();
  }

  register(manifest, factory) {
    const validated = validatePluginManifest(manifest);

    if (this.entries.has(validated.id))
      throw new PluginError(
        PLUGIN_ERROR_CODE.DUPLICATE_ID,
        `duplicate plugin id "${validated.id}": plugin IDs must be unique, load order does not resolve the conflict`,
        { pluginId: validated.id },
      );

    if (typeof factory !== 'function')
      throw new PluginError(
        PLUGIN_ERROR_CODE.INVALID_MANIFEST,
        `plugin "${validated.id}" registration requires an adapter factory function`,
        { pluginId: validated.id },
      );

    this.entries.set(validated.id, { manifest: validated, factory });

    return validated;
  }

  has(pluginId) {
    return this.entries.has(pluginId);
  }

  get(pluginId) {
    const entry = this.entries.get(pluginId);

    if (!entry)
      throw new PluginError(PLUGIN_ERROR_CODE.UNKNOWN_ID, `unknown plugin id "${pluginId}"`, {
        pluginId,
      });

    return entry;
  }

  createAdapter(pluginId, connection) {
    const entry = this.get(pluginId);

    return assertAgentRuntime(entry.factory(connection), pluginId);
  }

  list() {
    return [...this.entries.values()].map(({ manifest }) => ({
      id: manifest.id,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      extensionPoints: manifest.extensionPoints,
      scope: manifest.scope,
    }));
  }
}
