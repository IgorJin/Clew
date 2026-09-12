/** Plugin composition root helper for CLEW-127.
 *
 * Owns the only place where the registry is assembled: register bundled
 * manifests with their factories, attach host-owned connections, then hand
 * the resolver to consumers via constructor injection. Domain services must
 * never import this module — they receive an already-resolved AgentRuntime.
 */

import { ConnectionResolver } from './resolver.js';
import { PluginRegistry } from './registry.js';

export function createPluginHost({
  plugins = [],
  connections = [],
  hostPolicy = null,
  allowFake = false,
} = {}) {
  const registry = new PluginRegistry();

  for (const { manifest, factory } of plugins) registry.register(manifest, factory);

  const resolver = new ConnectionResolver({ registry, connections, hostPolicy, allowFake });

  return { registry, resolver };
}

export { PLUGIN_ERROR_CODE, PluginError } from './errors.js';
export {
  AGENT_RUNTIME_POINT,
  AGENT_RUNTIME_VERSION,
  AGENT_RUNTIME_REQUIRED_METHODS,
  AGENT_RUNTIME_OPTIONAL_METHODS,
  RUNTIME_ERROR_CLASS,
  RUNTIME_TERMINAL_STATUS,
  assertAgentRuntime,
  createRuntimeError,
  validateRuntimeResult,
} from './runtime-contract.js';
export {
  FAKE_RUNTIME_PLUGIN_ID,
  FakeAgentRuntime,
  createFakeAgentRuntime,
  fakeRuntimeManifest,
} from './fake-runtime.js';
export {
  KNOWN_EXTENSION_POINTS,
  PLUGIN_API_VERSION,
  PLUGIN_SCOPE,
  validatePluginManifest,
} from './manifest.js';
export { assertSafeProjectPluginConfig, PLUGIN_CONFIG_SECTIONS } from './project-config.js';
export { ConnectionResolver } from './resolver.js';
export { PluginRegistry } from './registry.js';
export { validateConfigValue } from './validate-config.js';
