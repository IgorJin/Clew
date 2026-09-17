/** TelemetrySink port contract for CLEW-132.
 *
 * Sinks deliver cleared instrumentation records to an external system.
 * They never throw on the hot path: overloads and failures are counted
 * and visible through `status()`, never fatal to execution or history.
 * A generic per-dashboard exporter is out of scope: the OTel sink speaks
 * OTLP to a Collector, which fans out from there.
 */

import { PLUGIN_ERROR_CODE, PluginError } from '../errors.js';

export const TELEMETRY_SINK_POINT = 'TelemetrySink';
export const TELEMETRY_SINK_VERSION = '1';

export const TELEMETRY_SINK_REQUIRED_METHODS = Object.freeze([
  'describe',
  'probe',
  'emit',
  'status',
  'flush',
  'dispose',
]);

export const TELEMETRY_RECORD_SIGNALS = Object.freeze(['trace']);
export const TELEMETRY_RECORD_ACTIONS = Object.freeze(['span-start', 'span-end', 'instant']);

export function assertTelemetrySink(adapter, pluginId) {
  if (!adapter || (typeof adapter !== 'object' && typeof adapter !== 'function'))
    throw new PluginError(
      PLUGIN_ERROR_CODE.INCOMPATIBLE,
      `plugin "${pluginId}" adapter must be an object implementing TelemetrySink v1`,
      { pluginId },
    );

  for (const method of TELEMETRY_SINK_REQUIRED_METHODS)
    if (typeof adapter[method] !== 'function')
      throw new PluginError(
        PLUGIN_ERROR_CODE.INCOMPATIBLE,
        `plugin "${pluginId}" adapter must implement TelemetrySink v1 method "${method}"`,
        { pluginId },
      );

  return adapter;
}

export function validateTelemetryRecord(record, pluginId) {
  if (!record || typeof record !== 'object')
    throw new PluginError(
      PLUGIN_ERROR_CODE.PROTOCOL,
      `plugin "${pluginId}" record must be an object`,
      { pluginId },
    );

  if (record.version !== 1)
    throw new PluginError(
      PLUGIN_ERROR_CODE.PROTOCOL,
      `plugin "${pluginId}" record version must be 1`,
      { pluginId },
    );

  if (!TELEMETRY_RECORD_SIGNALS.includes(record.signal))
    throw new PluginError(
      PLUGIN_ERROR_CODE.PROTOCOL,
      `plugin "${pluginId}" record signal must be one of ${TELEMETRY_RECORD_SIGNALS.join(', ')}`,
      { pluginId },
    );

  if (!TELEMETRY_RECORD_ACTIONS.includes(record.action))
    throw new PluginError(
      PLUGIN_ERROR_CODE.PROTOCOL,
      `plugin "${pluginId}" record action must be one of ${TELEMETRY_RECORD_ACTIONS.join(', ')}`,
      { pluginId },
    );

  if (typeof record.spanKey !== 'string' || !record.spanKey)
    throw new PluginError(
      PLUGIN_ERROR_CODE.PROTOCOL,
      `plugin "${pluginId}" record requires a non-empty spanKey`,
      { pluginId },
    );

  return record;
}
