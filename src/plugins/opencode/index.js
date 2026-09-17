/** OpenCode plugin composition entry for CLEW-129.
 *
 * Mirrors the Codex plugin entry: registers the `clew.runtime.opencode`
 * manifest with a factory capturing host-owned services (fetch seam).
 * Domain services never import this module.
 */

import { OPENCODE_RUNTIME_PLUGIN_ID, openCodeRuntimeManifest } from './manifest.js';
import { createOpenCodeAgentRuntime } from './adapter.js';

export function registerOpenCodePlugin(registry, hostServices = {}) {
  registry.register(openCodeRuntimeManifest(), (connection) =>
    createOpenCodeAgentRuntime(connection, hostServices),
  );

  return { pluginId: OPENCODE_RUNTIME_PLUGIN_ID };
}

export {
  OpenCodeAgentRuntime,
  OPENCODE_CAPABILITIES,
  createOpenCodeAgentRuntime,
} from './adapter.js';
export { OpenCodeHarness } from './harness.js';
export {
  OPENCODE_DEFAULT_CONNECTION_ID,
  OPENCODE_RUNTIME_PLUGIN_ID,
  openCodeRuntimeManifest,
} from './manifest.js';
