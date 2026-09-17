import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { redactSecrets } from './security.js';
import { createNullTelemetrySink, defaultTelemetryHost } from './plugins/telemetry/index.js';
import { TELEMETRY_DEFAULT_CONNECTION_ID } from './plugins/telemetry/manifest.js';

export { telemetryInstall } from './plugins/telemetry/index.js';

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

function randomTraceId() {
  return randomUUID().replace(/-/g, '');
}

function randomSpanId() {
  return randomUUID().replace(/-/g, '').slice(0, 16);
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

export class Observability {
  constructor({ cwd = process.cwd(), config = {}, store = null, plugins = null } = {}) {
    this.cwd = cwd;
    this.config = config;
    this.store = store;
    this.taskSpans = new Map();
    this.runSpans = new Map();
    this.stageRuns = new Map();
    this.dropped = 0;
    this.installed = existsSync(join(resolve(cwd), '.clew/telemetry', 'loader.cjs'));
    this.error = null;

    const host = plugins?.host ?? defaultTelemetryHost({ cwd, observability: config });
    const connectionId = plugins?.connectionId ?? TELEMETRY_DEFAULT_CONNECTION_ID;
    let sink;

    try {
      sink = host.resolver.resolve({ connectionId });
    } catch (error) {
      sink = createNullTelemetrySink({ id: connectionId });
      this.error =
        error?.code === 'PLUGIN_DISABLED' ? null : redactSecrets(error?.message ?? String(error));
    }

    this.sink = sink;

    const sinkStatus = this.sinkStatus();

    this.state = !config.enabled ? 'disabled' : sinkStatus.state;

    if (!config.enabled) this.error = null;
    else if (this.error === null || this.error === undefined) this.error = sinkStatus.error ?? null;
  }

  sinkStatus() {
    try {
      return this.sink.status();
    } catch {
      return {
        state: 'unavailable',
        endpoint: null,
        queued: 0,
        dropped: 0,
        exportErrors: 0,
        error: 'sink status failed',
      };
    }
  }

  setStore(store) {
    this.store = store;
  }

  emitRecord(record) {
    try {
      this.sink.emit(record);
    } catch {
      this.dropped += 1;
    }
  }

  ensureTaskContext(taskId, attributes) {
    if (this.taskSpans.has(taskId)) return this.taskSpans.get(taskId);

    const persisted = this.store?.getTelemetryTask(taskId);

    if (persisted?.rootSpanContext) {
      const context = {
        traceId: persisted.rootSpanContext.traceId,
        spanId: persisted.rootSpanContext.spanId,
      };

      this.taskSpans.set(taskId, context);

      return { context, fresh: false };
    }

    const context = { traceId: randomTraceId(), spanId: randomSpanId() };

    this.emitRecord({
      version: 1,
      signal: 'trace',
      action: 'span-start',
      spanKey: `task:${taskId}`,
      name: 'clew.task',
      attributes,
      traceId: context.traceId,
      spanId: context.spanId,
    });
    this.taskSpans.set(taskId, context);
    this.store?.saveTelemetryTask(taskId, { ...context, traceFlags: 1 });

    return { context, fresh: true };
  }

  onEvent(event) {
    if (this.state !== 'ready' || !this.store) return;
    try {
      const attributes = eventAttributes(event);
      const task = this.ensureTaskContext(event.task_id, attributes);

      if (!task) return;
      const payload = event.payload ?? {};
      const runId = payload.runId ?? payload.run_id;

      if (event.type === 'STAGE_RUN_STARTED' && runId) {
        const runContext = { traceId: task.context.traceId, spanId: randomSpanId() };

        this.emitRecord({
          version: 1,
          signal: 'trace',
          action: 'span-start',
          spanKey: `run:${runId}`,
          name: 'clew.stage.run',
          attributes,
          traceId: runContext.traceId,
          spanId: runContext.spanId,
          parent: task.context,
        });
        this.runSpans.set(runId, runContext);
        this.stageRuns.set(`${event.task_id}:${payload.stageId ?? payload.stage_id ?? ''}`, runId);
        this.store.saveTelemetryRun(runId, event.task_id, { ...runContext, traceFlags: 1 });
      }
      const stageKey = `${event.task_id}:${payload.stageId ?? payload.stage_id ?? ''}`;
      const effectiveRunId = runId ?? this.stageRuns.get(stageKey);
      const parent = (effectiveRunId && this.runSpans.get(effectiveRunId)) || task.context;

      this.emitRecord({
        version: 1,
        signal: 'trace',
        action: 'instant',
        spanKey: `event:${event.task_id}:${Date.now()}:${randomSpanId()}`,
        name: `clew.event.${event.type.toLowerCase()}`,
        attributes,
        traceId: parent.traceId,
        spanId: randomSpanId(),
        parent,
      });
      if (event.type === 'STAGE_STATE_CHANGED' && TERMINAL_STAGE_STATES.has(payload.status)) {
        const finishedRunId = this.stageRuns.get(stageKey);

        if (finishedRunId) {
          this.emitRecord({
            version: 1,
            signal: 'trace',
            action: 'span-end',
            spanKey: `run:${finishedRunId}`,
          });
          this.runSpans.delete(finishedRunId);
        }
        this.stageRuns.delete(stageKey);
      }
      if (event.type === 'TASK_COMPLETED') {
        this.emitRecord({
          version: 1,
          signal: 'trace',
          action: 'span-end',
          spanKey: `task:${event.task_id}`,
        });
        this.taskSpans.delete(event.task_id);
      }
    } catch {
      this.dropped += 1;
    }
  }

  status() {
    const sink = this.sinkStatus();

    return {
      state: this.state,
      installed: this.installed,
      endpoint: this.config.enabled ? (sink.endpoint ?? null) : null,
      dropped: this.dropped + (sink.dropped ?? 0),
      exportErrors: sink.exportErrors ?? 0,
      error: this.error ?? sink.error ?? null,
    };
  }

  async shutdown() {
    for (const [runId] of this.runSpans)
      this.emitRecord({ version: 1, signal: 'trace', action: 'span-end', spanKey: `run:${runId}` });

    for (const [taskId] of this.taskSpans)
      this.emitRecord({
        version: 1,
        signal: 'trace',
        action: 'span-end',
        spanKey: `task:${taskId}`,
      });

    this.runSpans.clear();
    this.stageRuns.clear();
    this.taskSpans.clear();

    try {
      await this.sink.flush();
    } catch {
      // Flush failures are already counted by the sink; shutdown continues.
    }

    try {
      await this.sink.dispose();
    } catch {
      // Dispose is deadline-bounded inside the sink; never hangs shutdown.
    }
  }
}
