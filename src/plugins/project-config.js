/** Project-config plugin safety for CLEW-127.
 *
 * Repository project config may select connections and models, but it must
 * not define host-owned settings: module paths, binaries, endpoints, or
 * credentials. Those belong to the execution-host owner. Secrets are
 * rejected anywhere inside the plugin sections.
 */

import { PLUGIN_ERROR_CODE, PluginError } from './errors.js';

export const PLUGIN_CONFIG_SECTIONS = Object.freeze(['agents', 'plugins', 'connections']);

const SECRET_KEY_PATTERN = /(?:authorization|api[_-]?key|token|password|secret|cookie)/i;
const HOST_FIELD_PATTERN =
  /(?:^|[_\-. ])(bin|binary|binaries|module|modulepath|endpoint|url|credential|executable|command)(?:$|[_\-. ])/i;

function inspect(value, path) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspect(entry, [...path, String(index)]));

    return;
  }

  if (!value || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value)) {
    const fieldPath = [...path, key].join('.');

    if (SECRET_KEY_PATTERN.test(key))
      throw new PluginError(
        PLUGIN_ERROR_CODE.INVALID_CONFIG,
        `project plugin config must not contain secret field: ${fieldPath}`,
      );

    if (HOST_FIELD_PATTERN.test(key))
      throw new PluginError(
        PLUGIN_ERROR_CODE.INVALID_CONFIG,
        `project plugin config must not define host-level field "${fieldPath}": module paths, binaries, and endpoints belong to the execution-host owner`,
      );

    inspect(child, [...path, key]);
  }
}

export function assertSafeProjectPluginConfig(projectConfig) {
  if (!projectConfig || typeof projectConfig !== 'object') return;

  for (const section of PLUGIN_CONFIG_SECTIONS) {
    const subtree = projectConfig[section];

    if (subtree !== undefined) inspect(subtree, [section]);
  }
}
