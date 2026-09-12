/** Codex runtime manifest for CLEW-128 (`clew.runtime.codex`).
 *
 * Connection config carries the host-owned binary selection that used to
 * be the global `codexBin`: `{ bin, args?, model?, timeouts? }`.
 */

import { PLUGIN_API_VERSION } from '../manifest.js';

export const CODEX_RUNTIME_PLUGIN_ID = 'clew.runtime.codex';
export const CODEX_DEFAULT_CONNECTION_ID = 'codex-default';

export function codexRuntimeManifest() {
  return {
    id: CODEX_RUNTIME_PLUGIN_ID,
    version: '1.0.0',
    apiVersion: PLUGIN_API_VERSION,
    extensionPoints: [{ point: 'AgentRuntime', version: '1' }],
    configSchema: {
      type: 'object',
      properties: {
        bin: { type: 'string', minLength: 1 },
        args: { type: 'array', items: { type: 'string' } },
        model: { type: ['string', 'null'] },
        timeoutMs: { type: 'number', minimum: 1 },
        interruptTimeoutMs: { type: 'number', minimum: 1 },
        startupTimeoutMs: { type: 'number', minimum: 1 },
      },
      required: ['bin'],
    },
    scope: 'execution-host',
    resources: {
      binaries: ['codex CLI in app-server mode'],
      network: [],
      notes:
        'Spawns the configured codex binary with stdio JSON-RPC and an optional unix-socket live endpoint. No other network use.',
    },
  };
}
