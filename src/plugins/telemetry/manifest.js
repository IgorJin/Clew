/** Telemetry manifests for CLEW-132.
 *
 * `clew.telemetry.otel` delivers traces to OTLP; `clew.telemetry.test` is
 * the in-memory sink for CI. Connection config mirrors the classic
 * observability settings (`endpoint`, `serviceName`, queue bounds).
 */

import { PLUGIN_API_VERSION } from '../manifest.js';

export const OTEL_SINK_PLUGIN_ID = 'clew.telemetry.otel';
export const TEST_SINK_PLUGIN_ID = 'clew.telemetry.test';
export const TELEMETRY_DEFAULT_CONNECTION_ID = 'otel-main';

const SINK_CONFIG_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    endpoint: { type: ['string', 'null'] },
    serviceName: { type: ['string', 'null'] },
    maxQueueSize: { type: 'number', minimum: 1 },
    exportTimeoutMs: { type: 'number', minimum: 1 },
  },
});

function sinkManifest(id, notes) {
  return {
    id,
    version: '1.0.0',
    apiVersion: PLUGIN_API_VERSION,
    extensionPoints: [{ point: 'TelemetrySink', version: '1' }],
    configSchema: SINK_CONFIG_SCHEMA,
    scope: 'execution-host',
    resources: {
      binaries: [],
      network: ['OTLP HTTP to the configured endpoint'],
      notes,
    },
  };
}

export function otelSinkManifest() {
  return sinkManifest(
    OTEL_SINK_PLUGIN_ID,
    'Delivers trace records through the official OpenTelemetry SDK to OTLP. No manual wire protocol.',
  );
}

export function testSinkManifest() {
  return sinkManifest(TEST_SINK_PLUGIN_ID, 'Test-only sink: records everything in memory.');
}
