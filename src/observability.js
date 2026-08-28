import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { redactSecrets } from './security.js';

const TELEMETRY_DIR = '.clew/telemetry';
const OTEL_PACKAGES = [
  '@opentelemetry/api@^1.9.0',
  '@opentelemetry/sdk-trace-node@^2.10.0',
  '@opentelemetry/sdk-trace-base@^2.10.0',
  '@opentelemetry/exporter-trace-otlp-http@^0.221.0',
];
const TERMINAL_STAGE_STATES = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED']);
const ALLOWED_ATTRIBUTES = new Set([
  'task_id',
  'stage_id',
  'run_id',
  'attempt',
  'profile',
  'role',
  'harness',
  'workspace_id',
  'commit_sha',
  'session_id',
  'turn_id',
  'state',
  'status',
  'event_type',
  'action',
  'decision',
  'failure_class',
  'trace_id',
]);

function loadOtel(cwd) {
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

function endpointFor(config) {
  const endpoint =
    config.endpoint || process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://127.0.0.1:4318';

  return endpoint.endsWith('/v1/traces') ? endpoint : `${endpoint.replace(/\/$/, '')}/v1/traces`;
}

function eventAttributes(event) {
  const payload = event.payload ?? {};
  const values = {
    task_id: event.task_id,
    event_type: event.type,
    stage_id: payload.stageId ?? payload.stage_id,
    run_id: payload.runId ?? payload.run_id,
    attempt: payload.attempt,
    profile: payload.profile,
    role: payload.role,
    harness: payload.harness,
    workspace_id: payload.workspaceId ?? payload.workspace_id,
    commit_sha: payload.revision ?? payload.commitSha ?? payload.commit_sha,
    session_id: payload.sessionId ?? payload.session_id,
    turn_id: payload.turnId ?? payload.turn_id,
    state: payload.state,
    status: payload.status,
    action: payload.action,
    decision: payload.decision,
    failure_class: payload.failureClass ?? payload.failure_class,
  };

  return Object.fromEntries(
    Object.entries(values).filter(
      ([key, value]) => ALLOWED_ATTRIBUTES.has(key) && value !== undefined && value !== null,
    ),
  );
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

export class Observability {
  constructor({ cwd = process.cwd(), config = {}, store = null } = {}) {
    this.cwd = cwd;
    this.config = config;
    this.store = store;
    this.taskSpans = new Map();
    this.runSpans = new Map();
    this.stageRuns = new Map();
    this.dropped = 0;
    this.exportErrors = 0;
    this.state = config.enabled ? 'initializing' : 'disabled';
    this.installed = existsSync(join(resolve(cwd), TELEMETRY_DIR, 'loader.cjs'));

    if (!config.enabled) return;
    try {
      const otel = loadOtel(cwd);
      const exporter = new SafeExporter(
        new otel.OTLPTraceExporter({ url: endpointFor(config) }),
        (error) => {
          this.exportErrors += 1;
          this.error = redactSecrets(error);
        },
      );

      this.provider = new otel.NodeTracerProvider({
        spanProcessors: [
          new otel.BatchSpanProcessor(exporter, {
            maxQueueSize: config.maxQueueSize ?? 256,
            maxExportBatchSize: Math.min(config.maxQueueSize ?? 256, 64),
            exportTimeoutMillis: config.exportTimeoutMs ?? 5_000,
          }),
        ],
      });
      this.provider.register();
      this.api = otel.api;
      this.tracer = this.provider.getTracer(config.serviceName ?? 'clew');
      this.state = 'ready';
    } catch (error) {
      this.state = 'unavailable';
      this.error = redactSecrets(error.message);
    }
  }

  setStore(store) {
    this.store = store;
  }

  parentContext(context) {
    if (!context) return this.api.context.active();

    return this.api.trace.setSpanContext(this.api.context.active(), {
      ...context,
      isRemote: false,
    });
  }

  ensureTaskSpan(taskId, attributes) {
    if (this.taskSpans.has(taskId)) return this.taskSpans.get(taskId);
    const persisted = this.store?.getTelemetryTask(taskId);
    const span = persisted ? null : this.tracer.startSpan('clew.task', { attributes });
    const context = persisted?.rootSpanContext ?? span?.spanContext();

    if (!context) return null;
    if (span) this.taskSpans.set(taskId, span);
    if (!persisted) this.store?.saveTelemetryTask(taskId, context);

    return { context, span };
  }

  onEvent(event) {
    if (this.state !== 'ready' || !this.store) return;
    try {
      const attributes = eventAttributes(event);
      const task = this.ensureTaskSpan(event.task_id, attributes);

      if (!task) return;
      const payload = event.payload ?? {};
      const runId = payload.runId ?? payload.run_id;

      if (event.type === 'STAGE_RUN_STARTED' && runId) {
        const span = this.tracer.startSpan(
          'clew.stage.run',
          { attributes },
          this.parentContext(task.context),
        );

        this.runSpans.set(runId, span);
        this.stageRuns.set(`${event.task_id}:${payload.stageId ?? payload.stage_id ?? ''}`, runId);
        this.store.saveTelemetryRun(runId, event.task_id, span.spanContext());
      }
      const stageKey = `${event.task_id}:${payload.stageId ?? payload.stage_id ?? ''}`;
      const effectiveRunId = runId ?? this.stageRuns.get(stageKey);
      const parent = effectiveRunId && this.runSpans.get(effectiveRunId)?.spanContext();
      const eventSpan = this.tracer.startSpan(
        `clew.event.${event.type.toLowerCase()}`,
        { attributes },
        this.parentContext(parent ?? task.context),
      );

      eventSpan.end();
      if (event.type === 'STAGE_STATE_CHANGED' && TERMINAL_STAGE_STATES.has(payload.status)) {
        const finishedRunId = this.stageRuns.get(stageKey);

        this.runSpans.get(finishedRunId)?.end();
        this.runSpans.delete(finishedRunId);
        this.stageRuns.delete(stageKey);
      }
      if (event.type === 'TASK_COMPLETED') {
        this.taskSpans.get(event.task_id)?.end();
        this.taskSpans.delete(event.task_id);
      }
    } catch {
      this.dropped += 1;
    }
  }

  status() {
    return {
      state: this.state,
      installed: this.installed,
      endpoint: this.config.enabled ? endpointFor(this.config) : null,
      dropped: this.dropped,
      exportErrors: this.exportErrors,
      error: this.error ?? null,
    };
  }

  async shutdown() {
    for (const span of this.runSpans.values()) span.end();
    for (const span of this.taskSpans.values()) span.end();
    this.runSpans.clear();
    this.stageRuns.clear();
    this.taskSpans.clear();
    await this.provider?.shutdown?.();
  }
}
