/** OpenCode runtime manifest for CLEW-129 (`clew.runtime.opencode`).
 *
 * Connection config carries the host-owned server selection that used to
 * be the global `openCodeUrl`: `{ baseUrl, model?, timeoutMs? }`.
 */

import { PLUGIN_API_VERSION } from '../manifest.js';

export const OPENCODE_RUNTIME_PLUGIN_ID = 'clew.runtime.opencode';
export const OPENCODE_DEFAULT_CONNECTION_ID = 'opencode-default';

export function openCodeRuntimeManifest() {
  return {
    id: OPENCODE_RUNTIME_PLUGIN_ID,
    version: '1.0.0',
    apiVersion: PLUGIN_API_VERSION,
    extensionPoints: [{ point: 'AgentRuntime', version: '1' }],
    configSchema: {
      type: 'object',
      properties: {
        baseUrl: { type: 'string', minLength: 1 },
        model: { type: ['string', 'null'] },
        timeoutMs: { type: 'number', minimum: 1 },
      },
      required: ['baseUrl'],
    },
    scope: 'execution-host',
    resources: {
      binaries: [],
      network: ['OpenCode server HTTP/SSE at the configured baseUrl'],
      notes:
        'Talks to an already-running OpenCode server over HTTP and SSE. The plugin never launches the server itself.',
    },
  };
}
