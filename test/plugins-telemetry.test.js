import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Observability } from '../src/observability.js';
import { Store } from '../src/store.js';
import { PluginRegistry } from '../src/plugins/registry.js';
import { ConnectionResolver } from '../src/plugins/resolver.js';
import { PLUGIN_ERROR_CODE } from '../src/plugins/errors.js';
import { assertTelemetrySink, validateTelemetryRecord } from '../src/plugins/telemetry/contract.js';
import {
  otelSinkManifest,
  testSinkManifest,
  OTEL_SINK_PLUGIN_ID,
  TEST_SINK_PLUGIN_ID,
} from '../src/plugins/telemetry/manifest.js';
import { registerTelemetryPlugins } from '../src/plugins/telemetry/index.js';
import { createTestTelemetrySink } from '../src/plugins/telemetry/test-sink.js';
import { createOtelTelemetrySink } from '../src/plugins/telemetry/otel-sink.js';
import { validatePluginManifest } from '../src/plugins/manifest.js';

function testHost({ failEmit = false } = {}) {
  const registry = new PluginRegistry();

  registerTelemetryPlugins(registry, { cwd: '/tmp/clew-telemetry-test', failEmit });
  const connection = { id: 'test-main', plugin: TEST_SINK_PLUGIN_ID, enabled: true, config: {} };
  const resolver = new ConnectionResolver({
    registry,
    connections: [connection],
    allowFake: false,
  });

  return { registry, resolver, connection, host: { resolver } };
}

function fakeOtelModules({ hangExporter = false } = {}) {
  const calls = { startSpan: [], export: [], shutdown: 0, forceFlush: 0 };
  const exporter = {
    export: (spans, callback) => {
      calls.export.push(spans.length);

      if (!hangExporter) callback({ code: 0 });
    },
    shutdown: () => {
      calls.shutdown += 1;

      return hangExporter ? new Promise(() => {}) : Promise.resolve();
    },
    forceFlush: () => {
      calls.forceFlush += 1;

      return hangExporter ? new Promise(() => {}) : Promise.resolve();
    },
  };
  const api = {
    context: { active: () => ({}) },
    trace: { setSpanContext: (context, spanContext) => ({ ...context, ...spanContext }) },
  };
  const tracer = {
    startSpan: (name, options, context) => {
      calls.startSpan.push({ name, options, context });

      return { end: () => {} };
    },
  };
  const provider = {
    register: () => {},
    getTracer: () => tracer,
    shutdown: () => exporter.shutdown(),
    forceFlush: () => exporter.forceFlush(),
  };

  return {
    calls,
    modules: {
      api,
      NodeTracerProvider: function fakeProvider({ idGenerator } = {}) {
        this.idGenerator = idGenerator;
        this.register = provider.register;
        this.getTracer = () => ({
          startSpan: (name, options, context) => {
            const traceId = this.idGenerator?.generateTraceId?.() ?? 't';
            const spanId = this.idGenerator?.generateSpanId?.() ?? 's';

            calls.startSpan.push({ name, options, context, traceId, spanId });

            return { end: () => {} };
          },
        });
        this.shutdown = provider.shutdown;
        this.forceFlush = provider.forceFlush;
      },
      BatchSpanProcessor: function fakeProcessor(exporterInstance) {
        this.exporter = exporterInstance;
        this.shutdown = () => exporterInstance.shutdown();
        this.forceFlush = () => exporterInstance.forceFlush();
      },
      OTLPTraceExporter: function fakeExporter() {
        return exporter;
      },
    },
  };
}

function otelSinkWithFake({
  failLoad = false,
  hangExporter = false,
  config = {},
  connectionId = 'otel-main',
} = {}) {
  const { calls, modules } = fakeOtelModules({ hangExporter });
  const loadOtel = () => {
    if (failLoad) throw new Error('no packages');

    return modules;
  };
  const sink = createOtelTelemetrySink(
    { id: connectionId, config },
    { cwd: '/tmp/clew-telemetry-test', loadOtel, env: {} },
  );

  return { sink, calls };
}

function observedStore() {
  const directory = mkdtempSync(join(tmpdir(), 'clew-telemetry-'));
  const store = new Store(join(directory, 'state.sqlite'));

  store.createTask({
    id: 'TEL-1',
    title: 'Telemetry',
    goal: 'Exercise the sink path',
    profile: 'quick',
    acceptance: [{ id: 'AC-1', criterion: 'works' }],
  });

  return {
    directory,
    store,
    dispose() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function runLifecycle(observability) {
  // Production order: the run row exists before STAGE_RUN_STARTED
  // (telemetry_runs references runs).
  observability.store?.createRun({
    id: 'run-1',
    taskId: 'TEL-1',
    stageId: 'worker',
    attempt: 1,
    status: 'RUNNING',
    harness: 'codex',
  });
  observability.onEvent({
    task_id: 'TEL-1',
    type: 'STAGE_RUN_STARTED',
    payload: { stageId: 'worker', runId: 'run-1' },
  });
  observability.onEvent({
    task_id: 'TEL-1',
    type: 'HARNESS_EVENT',
    payload: { stageId: 'worker', runId: 'run-1', token: 'secret', prompt: 'hidden' },
  });
  observability.onEvent({
    task_id: 'TEL-1',
    type: 'STAGE_STATE_CHANGED',
    payload: { stageId: 'worker', status: 'COMPLETED' },
  });
  observability.onEvent({ task_id: 'TEL-1', type: 'TASK_COMPLETED', payload: {} });
}

// Group 1 (AC-1): the disabled path needs no packages and changes nothing.

test('plugins-telemetry group 1: disabled telemetry is a no-op without packages', async () => {
  const observability = new Observability({ config: { enabled: false } });

  observability.onEvent({ task_id: 'T-1', type: 'TASK_CREATED', payload: {} });
  assert.deepEqual(observability.status(), {
    state: 'disabled',
    installed: false,
    endpoint: null,
    dropped: 0,
    exportErrors: 0,
    error: null,
  });
  await observability.shutdown();
});

test('plugins-telemetry group 1: sink manifests and contracts validate', () => {
  assert.equal(validatePluginManifest(otelSinkManifest()).id, OTEL_SINK_PLUGIN_ID);
  assert.equal(validatePluginManifest(testSinkManifest()).id, TEST_SINK_PLUGIN_ID);

  const registry = new PluginRegistry();

  registerTelemetryPlugins(registry, {});
  assert.ok(registry.has(OTEL_SINK_PLUGIN_ID));
  assert.ok(registry.has(TEST_SINK_PLUGIN_ID));
  assert.throws(
    () => assertTelemetrySink({}, OTEL_SINK_PLUGIN_ID),
    /must implement TelemetrySink v1 method "describe"/,
  );
  assert.throws(
    () => validateTelemetryRecord({ version: 1 }, OTEL_SINK_PLUGIN_ID),
    /record signal must be/,
  );
});

test('plugins-telemetry group 1: missing OTel packages report unavailable without throwing', async () => {
  const { sink } = otelSinkWithFake({ failLoad: true });
  const probe = await sink.probe();

  assert.equal(probe.status, 'unavailable');
  assert.equal(sink.status().state, 'unavailable');

  sink.emit({ version: 1, signal: 'trace', action: 'instant', spanKey: 'k', name: 'n' });
  assert.equal(sink.status().dropped, 1);
  await sink.flush();
  await sink.dispose();
});

test('plugins-telemetry group 1: full lifecycle flows through the test sink', async () => {
  const { store, dispose } = observedStore();

  try {
    const host = testHost();
    const observability = new Observability({
      config: { enabled: true },
      store,
      plugins: { host, connectionId: 'test-main' },
    });

    assert.equal(observability.status().state, 'ready');
    runLifecycle(observability);

    const sink = host.resolver.resolve({ connectionId: 'test-main' });
    const starts = sink.received.filter((record) => record.action === 'span-start');

    assert.ok(starts.some((record) => record.name === 'clew.task'));
    assert.ok(starts.some((record) => record.name === 'clew.stage.run'));
    assert.ok(sink.received.some((record) => record.action === 'span-end'));
    assert.ok(store.getTelemetryTask('TEL-1'));
    assert.ok(store.getTelemetryRun('run-1'));
    await observability.shutdown();
    assert.equal(sink.disposed, true);
  } finally {
    dispose();
  }
});

// Group 2 (AC-2): exporter failure, overload, hangs, and replays never
// change task state or mandatory checks.

test('plugins-telemetry group 2: failing sink never breaks execution or history', async () => {
  const { store, dispose } = observedStore();

  try {
    const host = testHost();
    const observability = new Observability({
      config: { enabled: true },
      store,
      plugins: { host, connectionId: 'test-main' },
    });
    const sink = host.resolver.resolve({ connectionId: 'test-main' });

    assert.equal(observability.status().state, 'ready');

    // The exporter fails mid-flow: records drop and count visibly,
    // execution and canonical history are untouched.
    sink.failEmit = true;
    runLifecycle(observability);

    assert.ok(sink.status().dropped > 0);
    assert.ok(sink.status().exportErrors > 0);
    assert.ok(store.getTelemetryTask('TEL-1'));
    assert.ok(store.getTelemetryRun('run-1'));
    await observability.shutdown();
  } finally {
    dispose();
  }
});

test('plugins-telemetry group 2: bounded queue drops visibly instead of growing', () => {
  const { sink } = otelSinkWithFake({ config: { maxQueueSize: 2 } });

  for (let index = 0; index < 5; index += 1)
    sink.emit({
      version: 1,
      signal: 'trace',
      action: 'span-start',
      spanKey: `k-${index}`,
      name: 'n',
    });

  assert.ok(sink.status().dropped > 0);
  assert.ok(sink.status().queued <= 2);
});

test('plugins-telemetry group 2: hung exporter never holds flush or shutdown', async () => {
  const { sink } = otelSinkWithFake({ hangExporter: true, config: { exportTimeoutMs: 50 } });

  sink.emit({ version: 1, signal: 'trace', action: 'span-start', spanKey: 'k', name: 'n' });
  await sink.flush(50);
  await sink.dispose();
});

test('plugins-telemetry group 2: core-assigned ids survive the SDK mapping', () => {
  const { sink, calls } = otelSinkWithFake({});

  sink.emit({
    version: 1,
    signal: 'trace',
    action: 'span-start',
    spanKey: 'task:T',
    name: 'clew.task',
    attributes: {},
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
  });

  assert.equal(calls.startSpan.length, 1);
  assert.equal(calls.startSpan[0].traceId, 'a'.repeat(32));
  assert.equal(calls.startSpan[0].spanId, 'b'.repeat(16));
});

test('plugins-telemetry group 2: replayed span-starts never double-count', () => {
  const { sink, calls } = otelSinkWithFake({});
  const record = {
    version: 1,
    signal: 'trace',
    action: 'span-start',
    spanKey: 'task:T',
    name: 'clew.task',
    attributes: {},
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
  };

  sink.emit(record);
  sink.emit({ ...record });

  assert.equal(calls.startSpan.length, 1);
  assert.equal(sink.status().dropped, 1);

  const testSink = createTestTelemetrySink({ id: 'test-main' });

  testSink.emit(record);
  testSink.emit({ ...record });
  assert.equal(testSink.received.length, 1);
  assert.equal(testSink.status().dropped, 1);
});

test('plugins-telemetry group 2: persisted contexts continue traces without new task spans', async () => {
  const { store, dispose } = observedStore();

  try {
    const firstHost = testHost();
    const first = new Observability({
      config: { enabled: true },
      store,
      plugins: { host: firstHost, connectionId: 'test-main' },
    });

    runLifecycle(first);
    await first.shutdown();

    const secondHost = testHost();
    const second = new Observability({
      config: { enabled: true },
      store,
      plugins: { host: secondHost, connectionId: 'test-main' },
    });

    second.onEvent({ task_id: 'TEL-1', type: 'HARNESS_EVENT', payload: { stageId: 'worker' } });

    const sink = secondHost.resolver.resolve({ connectionId: 'test-main' });
    const taskStarts = sink.received.filter(
      (record) => record.action === 'span-start' && record.name === 'clew.task',
    );

    assert.equal(taskStarts.length, 0);
    await second.shutdown();
  } finally {
    dispose();
  }
});

// Group 3 (AC-3): redaction, label bounds, and usage independence.

test('plugins-telemetry group 3: only allowlisted attributes leave the host', async () => {
  const { store, dispose } = observedStore();

  try {
    const host = testHost();
    const observability = new Observability({
      config: { enabled: true },
      store,
      plugins: { host, connectionId: 'test-main' },
    });

    observability.onEvent({
      task_id: 'TEL-1',
      type: 'HARNESS_EVENT',
      payload: {
        stageId: 'worker',
        runId: 'run-1',
        token: 'secret-token',
        secret: 'shh',
        prompt: 'do evil',
        code: 'rm -rf /',
        password: 'hunter2',
      },
    });

    const sink = host.resolver.resolve({ connectionId: 'test-main' });
    const serialized = JSON.stringify(sink.received);

    assert.ok(sink.received.length > 0);
    assert.doesNotMatch(serialized, /secret-token|shh|do evil|rm -rf|hunter2/);
    assert.ok(sink.received.every((record) => record.attributes.task_id === 'TEL-1'));

    const keys = new Set();

    for (const record of sink.received)
      for (const key of Object.keys(record.attributes ?? {})) keys.add(key);

    assert.ok(
      [...keys].every((key) =>
        [
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
        ].includes(key),
      ),
    );
    await observability.shutdown();
  } finally {
    dispose();
  }
});

test('plugins-telemetry group 3: sink connection joins the safe projection', () => {
  const host = testHost();
  const entry = host.resolver.describeConnection('test-main');

  assert.deepEqual(entry, { id: 'test-main', plugin: TEST_SINK_PLUGIN_ID, enabled: true });
  assert.throws(
    () =>
      host.resolver.resolve({
        connectionId: 'test-main',
        requireCapabilities: ['telemetry.metrics'],
      }),
    (error) => error.code === PLUGIN_ERROR_CODE.UNSUPPORTED_CAPABILITY,
  );
});
