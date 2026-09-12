/** Codex plugin composition entry for CLEW-128.
 *
 * Used by the composition root (and tests acting as one): registers the
 * `clew.runtime.codex` manifest with a factory that captures host-owned
 * services (terminal manager, workspace root, spawn seam). Domain services
 * never import this module — they receive resolved adapters.
 */

import { CODEX_RUNTIME_PLUGIN_ID, codexRuntimeManifest } from './manifest.js';
import { createCodexAgentRuntime } from './adapter.js';

export function registerCodexPlugin(registry, hostServices = {}) {
  registry.register(codexRuntimeManifest(), (connection) =>
    createCodexAgentRuntime(connection, hostServices),
  );

  return { pluginId: CODEX_RUNTIME_PLUGIN_ID };
}

export { CodexAgentRuntime, CODEX_CAPABILITIES, createCodexAgentRuntime } from './adapter.js';
export { CodexHarness, codexLaunchError } from './harness.js';
export {
  CODEX_DEFAULT_CONNECTION_ID,
  CODEX_RUNTIME_PLUGIN_ID,
  codexRuntimeManifest,
} from './manifest.js';
export {
  CodexArchitect,
  CodexReviewer,
  createCodexArchitect,
  createCodexReviewer,
} from './role-services.js';
