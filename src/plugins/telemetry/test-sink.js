/** In-memory and null TelemetrySinks for CLEW-132.
 *
 * The test sink records every validated record for CI assertions and can
 * simulate failure modes (failures count, never throw). The null sink is
 * the disabled path: everything is a no-op.
 */

import { validateTelemetryRecord } from './contract.js';
import { TEST_SINK_PLUGIN_ID } from './manifest.js';

export class TestTelemetrySink {
  constructor(connection = {}, hostServices = {}) {
    this.connectionId =
      typeof connection.id === 'string' && connection.id ? connection.id : 'otel-main';
    this.config = { ...(connection.config ?? {}) };
    this.failEmit = hostServices.failEmit === true;
    this.received = [];
    this.openSpans = new Map();
    this.dropped = 0;
    this.exportErrors = 0;
    this.flushed = 0;
    this.disposed = false;
  }

  describe() {
    return {
      plugin: TEST_SINK_PLUGIN_ID,
      apiVersion: '1',
      capabilities: ['telemetry.traces'],
    };
  }

  async probe() {
    return { status: this.failEmit ? 'unavailable' : 'ready', connection: this.connectionId };
  }

  emit(record) {
    try {
      validateTelemetryRecord(record, TEST_SINK_PLUGIN_ID);

      if (this.failEmit) {
        this.dropped += 1;
        this.exportErrors += 1;

        return;
      }

      if (record.action === 'span-end') {
        this.received.push(record);
        this.openSpans.delete(record.spanKey);

        return;
      }

      if (record.action === 'span-start' && this.openSpans.has(record.spanKey)) {
        this.dropped += 1;

        return;
      }

      this.received.push(record);

      if (record.action === 'span-start') this.openSpans.set(record.spanKey, record);
    } catch {
      this.dropped += 1;
    }
  }

  status() {
    return {
      state: this.failEmit ? 'unavailable' : 'ready',
      endpoint: null,
      queued: this.openSpans.size,
      dropped: this.dropped,
      exportErrors: this.exportErrors,
      error: this.failEmit ? 'test sink is failing' : null,
    };
  }

  async flush() {
    this.flushed += 1;
  }

  async dispose() {
    this.openSpans.clear();
    this.disposed = true;
  }
}

export function createTestTelemetrySink(connection, hostServices = {}) {
  return new TestTelemetrySink(connection, hostServices);
}

export function createNullTelemetrySink(connection = {}) {
  const connectionId =
    typeof connection.id === 'string' && connection.id ? connection.id : 'otel-main';
  const state = { flushed: 0, disposed: false };

  return {
    describe: () => ({ plugin: 'clew.telemetry.null', apiVersion: '1', capabilities: [] }),
    probe: async () => ({ status: 'disabled', connection: connectionId }),
    emit: () => {},
    status: () => ({
      state: 'disabled',
      endpoint: null,
      queued: 0,
      dropped: 0,
      exportErrors: 0,
      error: null,
    }),
    flush: async () => {
      state.flushed += 1;
    },
    dispose: async () => {
      state.disposed = true;
    },
    state,
  };
}
