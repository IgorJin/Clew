/** Stable plugin error codes for CLEW-127.
 *
 * Every plugin registry/resolver failure carries a machine-readable `code`
 * so callers can route (retry, needs-human, configuration fix) without
 * parsing messages. Messages stay human-readable and secret-free.
 */

export const PLUGIN_ERROR_CODE = Object.freeze({
  INVALID_MANIFEST: 'PLUGIN_INVALID_MANIFEST',
  INCOMPATIBLE_API: 'PLUGIN_INCOMPATIBLE_API',
  DUPLICATE_ID: 'PLUGIN_DUPLICATE_ID',
  UNKNOWN_ID: 'PLUGIN_UNKNOWN_ID',
  DISABLED: 'PLUGIN_DISABLED',
  UNCONFIGURED: 'PLUGIN_UNCONFIGURED',
  INCOMPATIBLE: 'PLUGIN_INCOMPATIBLE',
  UNSUPPORTED_CAPABILITY: 'PLUGIN_UNSUPPORTED_CAPABILITY',
  INVALID_CONFIG: 'PLUGIN_INVALID_CONFIG',
  HOST_POLICY_DENIED: 'PLUGIN_HOST_POLICY_DENIED',
  FAKE_NOT_ALLOWED: 'PLUGIN_FAKE_NOT_ALLOWED',
  RECOVERY_REQUIRED: 'PLUGIN_RECOVERY_REQUIRED',
});

export class PluginError extends Error {
  constructor(code, message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });

    this.name = 'PluginError';
    this.code = code;

    if (details.pluginId !== undefined) this.pluginId = details.pluginId;
    if (details.connectionId !== undefined) this.connectionId = details.connectionId;
  }
}
