/** Plugin manifest validation for CLEW-127 (Plugin API v1).
 *
 * The manifest is checked without launching external CLIs and without
 * network requests. Compatibility of the Clew Plugin API version, the
 * plugin version, and the external CLI version is checked separately:
 * manifest validation covers the first two, `probe()` covers the third.
 */

import { PLUGIN_ERROR_CODE, PluginError } from './errors.js';

export const PLUGIN_API_VERSION = '1';

export const KNOWN_EXTENSION_POINTS = Object.freeze({
  AgentRuntime: '1',
  TelemetrySink: '1',
});

export const PLUGIN_SCOPE = Object.freeze({
  CONTROLLER: 'controller',
  EXECUTION_HOST: 'execution-host',
});

const PLUGIN_ID_PATTERN = /^clew\.[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

function fail(code, message, details) {
  throw new PluginError(code, message, details);
}

export function validatePluginManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    fail(PLUGIN_ERROR_CODE.INVALID_MANIFEST, 'plugin manifest must be an object');

  const { id, version, apiVersion, extensionPoints, configSchema, scope, resources } = manifest;

  if (typeof id !== 'string' || !PLUGIN_ID_PATTERN.test(id))
    fail(
      PLUGIN_ERROR_CODE.INVALID_MANIFEST,
      `plugin manifest id must match ${PLUGIN_ID_PATTERN} but received ${JSON.stringify(id)}`,
    );

  if (typeof version !== 'string' || !SEMVER_PATTERN.test(version))
    fail(
      PLUGIN_ERROR_CODE.INVALID_MANIFEST,
      `plugin "${id}" version must be semver x.y.z but received ${JSON.stringify(version)}`,
      { pluginId: id },
    );

  if (apiVersion !== PLUGIN_API_VERSION)
    fail(
      PLUGIN_ERROR_CODE.INCOMPATIBLE_API,
      `plugin "${id}" requires Plugin API ${JSON.stringify(apiVersion)} but Clew provides ${PLUGIN_API_VERSION}`,
      { pluginId: id },
    );

  if (!Array.isArray(extensionPoints) || extensionPoints.length === 0)
    fail(
      PLUGIN_ERROR_CODE.INVALID_MANIFEST,
      `plugin "${id}" must declare at least one extension point`,
      { pluginId: id },
    );

  for (const entry of extensionPoints) {
    const point = entry?.point;
    const pointVersion = entry?.version;

    if (typeof point !== 'string' || !(point in KNOWN_EXTENSION_POINTS))
      fail(
        PLUGIN_ERROR_CODE.INVALID_MANIFEST,
        `plugin "${id}" declares unknown extension point ${JSON.stringify(point)}`,
        { pluginId: id },
      );

    if (pointVersion !== KNOWN_EXTENSION_POINTS[point])
      fail(
        PLUGIN_ERROR_CODE.INCOMPATIBLE_API,
        `plugin "${id}" requires ${point} v${JSON.stringify(pointVersion)} but Clew provides v${KNOWN_EXTENSION_POINTS[point]}`,
        { pluginId: id },
      );
  }

  if (!configSchema || typeof configSchema !== 'object' || configSchema.type !== 'object')
    fail(
      PLUGIN_ERROR_CODE.INVALID_MANIFEST,
      `plugin "${id}" configSchema must be an object schema`,
      { pluginId: id },
    );

  if (!Object.values(PLUGIN_SCOPE).includes(scope))
    fail(
      PLUGIN_ERROR_CODE.INVALID_MANIFEST,
      `plugin "${id}" scope must be ${Object.values(PLUGIN_SCOPE).join(' or ')} but received ${JSON.stringify(scope)}`,
      { pluginId: id },
    );

  if (!resources || typeof resources !== 'object' || Array.isArray(resources))
    fail(PLUGIN_ERROR_CODE.INVALID_MANIFEST, `plugin "${id}" must declare execution resources`, {
      pluginId: id,
    });

  return manifest;
}
