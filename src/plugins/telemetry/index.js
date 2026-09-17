/** Telemetry plugin composition entry for CLEW-132. */

import { PluginRegistry } from '../registry.js';
import { ConnectionResolver } from '../resolver.js';
import { buildLegacyTelemetryConnection } from '../legacy.js';
import { createOtelTelemetrySink } from './otel-sink.js';
import { createTestTelemetrySink } from './test-sink.js';
import { otelSinkManifest, testSinkManifest } from './manifest.js';

export function registerTelemetryPlugins(registry, hostServices = {}) {
  registry.register(otelSinkManifest(), (connection) =>
    createOtelTelemetrySink(connection, hostServices),
  );
  registry.register(testSinkManifest(), (connection) =>
    createTestTelemetrySink(connection, hostServices),
  );

  return { plugins: ['clew.telemetry.otel', 'clew.telemetry.test'] };
}

/** Ephemeral telemetry-only host for core default paths (CLEW-132).
 *
 * Lets `Observability` resolve its sink without a full runtime host.
 * Production command paths reuse the shared host from `buildRuntimeHost`.
 */
export function defaultTelemetryHost({ cwd = process.cwd(), observability = {} } = {}) {
  const registry = new PluginRegistry();

  registerTelemetryPlugins(registry, { cwd });

  const { connection } = buildLegacyTelemetryConnection({
    enabled: observability.enabled === true,
    endpoint: observability.endpoint ?? null,
    serviceName: observability.serviceName ?? null,
    maxQueueSize: observability.maxQueueSize ?? null,
    exportTimeoutMs: observability.exportTimeoutMs ?? null,
  });
  const resolver = new ConnectionResolver({
    registry,
    connections: [connection],
    allowFake: false,
  });

  return { registry, resolver };
}

export {
  OtelTelemetrySink,
  createOtelTelemetrySink,
  telemetryInstall,
  resolveOtelEndpoint,
  OTEL_PACKAGES,
  ReplayIdGenerator,
} from './otel-sink.js';
export {
  TestTelemetrySink,
  createTestTelemetrySink,
  createNullTelemetrySink,
} from './test-sink.js';
export {
  otelSinkManifest,
  testSinkManifest,
  OTEL_SINK_PLUGIN_ID,
  TEST_SINK_PLUGIN_ID,
  TELEMETRY_DEFAULT_CONNECTION_ID,
} from './manifest.js';
export {
  assertTelemetrySink,
  validateTelemetryRecord,
  TELEMETRY_SINK_POINT,
  TELEMETRY_SINK_VERSION,
  TELEMETRY_SINK_REQUIRED_METHODS,
} from './contract.js';
