/** Host connection and role-routing persistence for CLEW-133 follow-up.
 *
 * Host-owned plugin settings live in the user config file (never the
 * project repo): connection definitions (`bin`/`baseUrl`/`model`) and the
 * default role routing (`agents`). Writes are atomic, preserve unrelated
 * keys, and are validated by the caller against the plugin manifest.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PLUGIN_ERROR_CODE, PluginError } from './errors.js';

export const RESERVED_CONNECTION_IDS = Object.freeze([
  'codex-default',
  'opencode-default',
  'otel-main',
]);

function readJson(path) {
  if (!existsSync(path)) return {};

  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));

    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    throw new PluginError(
      PLUGIN_ERROR_CODE.INVALID_CONFIG,
      `invalid Clew config ${path}: ${error.message}`,
      { cause: error },
    );
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;

  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

export function listHostConnections(userConfigPath) {
  return readJson(userConfigPath).connections ?? [];
}

export function listUserAgents(userConfigPath) {
  return readJson(userConfigPath).agents ?? {};
}

export function saveHostConnection(userConfigPath, connection) {
  if (RESERVED_CONNECTION_IDS.includes(connection.id))
    throw new PluginError(
      PLUGIN_ERROR_CODE.INVALID_CONFIG,
      `connection "${connection.id}" is a reserved legacy id and cannot be redefined; create a named connection instead`,
      { connectionId: connection.id },
    );
  const config = readJson(userConfigPath);
  const connections = Array.isArray(config.connections) ? [...config.connections] : [];
  const index = connections.findIndex((entry) => entry.id === connection.id);

  if (index >= 0) connections[index] = connection;
  else connections.push(connection);

  config.connections = connections;
  writeJson(userConfigPath, config);

  return connection;
}

export function removeHostConnection(userConfigPath, id) {
  if (RESERVED_CONNECTION_IDS.includes(id))
    throw new PluginError(
      PLUGIN_ERROR_CODE.INVALID_CONFIG,
      `connection "${id}" is reserved and cannot be removed`,
      { connectionId: id },
    );
  const config = readJson(userConfigPath);
  const connections = Array.isArray(config.connections) ? config.connections : [];
  const remaining = connections.filter((entry) => entry.id !== id);

  if (remaining.length === connections.length)
    throw new PluginError(PLUGIN_ERROR_CODE.UNKNOWN_ID, `unknown connection id "${id}"`, {
      connectionId: id,
    });
  config.connections = remaining;
  writeJson(userConfigPath, config);

  return { id, removed: true };
}

export function saveUserAgent(userConfigPath, role, route) {
  const config = readJson(userConfigPath);

  config.agents = { ...(config.agents ?? {}), [role]: { ...route } };
  writeJson(userConfigPath, config);

  return { role, ...route };
}
