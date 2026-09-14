/** OTel TelemetrySink for CLEW-132.
 *
 * Uses the official OpenTelemetry SDK only (loaded lazily from the
 * `.clew/telemetry` runtime like before); no manual OTLP wire protocol.
 * Emits cleared records: span lifecycle arrives as records, duplicate
 * span-starts for one key are ignored so replays never double-count.
 * The constructor loads eagerly and synchronously so `status()` is
 * accurate without awaiting; `emit()` never throws.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { redactSecrets } from '../../security.js';
import { validateTelemetryRecord } from './contract.js';
import { OTEL_SINK_PLUGIN_ID } from './manifest.js';

export const OTEL_PACKAGES = [
  '@opentelemetry/api@^1.9.0',
  '@opentelemetry/sdk-trace-node@^2.10.0',
  '@opentelemetry/sdk-trace-base@^2.10.0',
  '@opentelemetry/exporter-trace-otlp-http@^0.221.0',
];

const TELEMETRY_DIR = '.clew/telemetry';
const DEFAULT_ENDPOINT = 'http://127.0.0.1:4318';

export function resolveOtelEndpoint(config, env = process.env) {
  const endpoint = config?.endpoint || env.OTEL_EXPORTER_OTLP_ENDPOINT || DEFAULT_ENDPOINT;

  return endpoint.endsWith('/v1/traces') ? endpoint : `${endpoint.replace(/\/$/, '')}/v1/traces`;
}

function loadOtelModules(cwd) {
  const loader = join(resolve(cwd), TELEMETRY_DIR, 'loader.cjs');

  if (!existsSync(loader))
    throw new Error('OpenTelemetry is not installed; run clew telemetry install');

  const require = createRequire(loader);
  const api = require('@opentelemetry/api');
  const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
  const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');

  return { api, NodeTracerProvider, BatchSpanProcessor, OTLPTraceExporter };
}

function randomHex(length) {
  return randomUUID().replace(/-/g, '').slice(0, length);
}

/** IdGenerator that replays core-assigned ids so persisted trace
 * correlation survives restarts byte-identically (CLEW-132). Falls back to
 * random ids when the core did not assign one.
 */
export class ReplayIdGenerator {
  constructor() {
    this.traceIds = [];
    this.spanIds = [];
  }

  enqueue(traceId, spanId) {
    if (traceId) this.traceIds.push(traceId);
    if (spanId) this.spanIds.push(spanId);
  }

  generateTraceId() {
    return this.traceIds.shift() ?? randomHex(32);
  }

  generateSpanId() {
    return this.spanIds.shift() ?? randomHex(16);
  }
}

class SafeExporter {
  constructor(exporter, onError) {
    this.exporter = exporter;
    this.onError = onError;
  }

  export(spans, callback) {
    try {
      this.exporter.export(spans, (result) => {
        if (result?.code !== 0) this.onError(result?.error?.message ?? 'OTLP export failed');
        callback(result);
      });
    } catch (error) {
      this.onError(error.message);
      callback({ code: 1, error });
    }
  }

  shutdown() {
    return this.exporter.shutdown?.();
  }

  forceFlush() {
    return this.exporter.forceFlush?.();
  }
}

export class OtelTelemetrySink {
  constructor(connection = {}, hostServices = {}) {
    this.connectionId =
      typeof connection.id === 'string' && connection.id ? connection.id : 'otel-main';
    this.config = { ...(connection.config ?? {}) };
    this.hostServices = { ...hostServices };
    this.cwd = hostServices.cwd ?? process.cwd();
    this.endpoint = resolveOtelEndpoint(this.config, hostServices.env ?? process.env);
    this.serviceName =
      typeof this.config.serviceName === 'string' && this.config.serviceName
        ? this.config.serviceName
        : 'clew';
    this.maxQueueSize = this.config.maxQueueSize ?? 256;
    this.exportTimeoutMs = this.config.exportTimeoutMs ?? 5_000;
    this.openSpans = new Map();
    this.dropped = 0;
    this.exportErrors = 0;
    this.error = null;
    this.available = false;
    this.idGenerator = new ReplayIdGenerator();

    try {
      const loadOtel = hostServices.loadOtel ?? loadOtelModules;
      const otel = loadOtel(this.cwd);
      const exporter = new SafeExporter(
        new otel.OTLPTraceExporter({ url: this.endpoint }),
        (message) => {
          this.exportErrors += 1;
          this.error = redactSecrets(message);
        },
      );

      this.api = otel.api;
      this.provider = new otel.NodeTracerProvider({
        idGenerator: this.idGenerator,
        spanProcessors: [
          new otel.BatchSpanProcessor(exporter, {
            maxQueueSize: this.maxQueueSize,
            maxExportBatchSize: Math.min(this.maxQueueSize, 64),
            exportTimeoutMillis: this.exportTimeoutMs,
          }),
        ],
      });
      this.provider.register();
      this.tracer = this.provider.getTracer(this.serviceName);
      this.available = true;
    } catch (error) {
      this.error = redactSecrets(error?.message ?? String(error));
      this.available = false;
    }
  }

  describe() {
    return {
      plugin: OTEL_SINK_PLUGIN_ID,
      apiVersion: '1',
      capabilities: ['telemetry.traces'],
    };
  }

  async probe() {
    return {
      status: this.available ? 'ready' : 'unavailable',
      connection: this.connectionId,
      endpoint: this.endpoint,
      serviceName: this.serviceName,
      ...(this.error ? { detail: this.error } : {}),
    };
  }

  parentContext(record) {
    const active = this.api.context.active();

    if (!record?.parent) return active;

    return this.api.trace.setSpanContext(active, { ...record.parent, isRemote: false });
  }

  emit(record) {
    try {
      validateTelemetryRecord(record, OTEL_SINK_PLUGIN_ID);

      if (!this.available) {
        this.dropped += 1;

        return;
      }

      if (record.action === 'span-end') {
        this.openSpans.get(record.spanKey)?.end();
        this.openSpans.delete(record.spanKey);

        return;
      }

      if (record.action === 'span-start' && this.openSpans.has(record.spanKey)) {
        // Replay/duplicate delivery: ignore, never double-count.
        this.dropped += 1;

        return;
      }

      if (this.openSpans.size >= this.maxQueueSize) {
        this.dropped += 1;

        return;
      }

      this.idGenerator.enqueue(record.traceId, record.spanId);

      const span = this.tracer.startSpan(
        record.name ?? `clew.${record.action}`,
        { attributes: record.attributes ?? {} },
        this.parentContext(record),
      );

      if (record.action === 'span-start') this.openSpans.set(record.spanKey, span);
      else span.end();
    } catch {
      this.dropped += 1;
    }
  }

  status() {
    return {
      state: this.available ? 'ready' : 'unavailable',
      endpoint: this.endpoint,
      queued: this.openSpans.size,
      dropped: this.dropped,
      exportErrors: this.exportErrors,
      error: this.error,
    };
  }

  async flush(deadlineMs = this.exportTimeoutMs) {
    if (!this.available) return;

    await Promise.race([
      Promise.resolve().then(() => this.provider?.forceFlush?.()),
      new Promise((resolve) => setTimeout(resolve, deadlineMs)),
    ]);
  }

  async dispose() {
    for (const span of this.openSpans.values()) {
      try {
        span.end();
      } catch {
        // Open spans must not block shutdown.
      }
    }

    this.openSpans.clear();

    if (!this.available) return;

    // A hung exporter never holds shutdown hostage (CLEW-132).
    await Promise.race([
      Promise.resolve().then(() => this.provider?.shutdown?.()),
      new Promise((resolve) => setTimeout(resolve, this.exportTimeoutMs)),
    ]);
  }
}

export function createOtelTelemetrySink(connection, hostServices = {}) {
  return new OtelTelemetrySink(connection, hostServices);
}

export function telemetryInstall({ cwd = process.cwd(), npm = 'npm' } = {}) {
  const directory = resolve(cwd, TELEMETRY_DIR);

  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'loader.cjs'), 'module.exports = {};\n');
  writeFileSync(
    join(directory, 'package.json'),
    `${JSON.stringify({ name: 'clew-telemetry-runtime', private: true, type: 'commonjs' }, null, 2)}\n`,
  );
  execFileSync(
    npm,
    ['install', '--no-save', '--no-package-lock', '--ignore-scripts', ...OTEL_PACKAGES],
    {
      cwd: directory,
      stdio: 'inherit',
    },
  );

  return { directory, packages: OTEL_PACKAGES };
}
