import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextEncoder } from 'node:util';
import { OpenCodeHarness } from '../src/plugins/opencode/harness.js';
import { OpenCodeHarness as FacadeHarness } from '../src/harness.js';
import {
  OPENCODE_CAPABILITIES,
  createOpenCodeAgentRuntime,
  registerOpenCodePlugin,
} from '../src/plugins/opencode/index.js';
import {
  OPENCODE_RUNTIME_PLUGIN_ID,
  openCodeRuntimeManifest,
} from '../src/plugins/opencode/manifest.js';
import { createPluginHost } from '../src/plugins/index.js';
import { PLUGIN_ERROR_CODE } from '../src/plugins/errors.js';
import { validatePluginManifest } from '../src/plugins/manifest.js';
import {
  assertHarnessConnectionExclusive,
  buildLegacyOpenCodeConnection,
  selectOpenCodeConnectionId,
} from '../src/plugins/legacy.js';
import { Scheduler } from '../src/scheduler.js';
import { RunnerExecutionPort } from '../src/runner-execution.js';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');
const fixtureDir = join(here, '..', 'fixtures', 'plugins');

const fixtureTask = Object.freeze({
  id: 'OPENCODE-1',
  title: 'OpenCode plugin',
  goal: 'Exercise the OpenCode adapter through a stub server',
  acceptance: [{ id: 'AC-1', criterion: 'the adapter preserves behavior' }],
});

function readFixture(name) {
  return JSON.parse(readFileSync(join(fixtureDir, name), 'utf8'));
}

function jsonResponse(data, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => data };
}

function sseBody(frames, chunkSize = 7) {
  const text = frames
    .map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`)
    .join('');
  const bytes = new TextEncoder().encode(text);
  const chunks = [];

  for (let index = 0; index < bytes.length; index += chunkSize)
    chunks.push(bytes.slice(index, index + chunkSize));

  let position = 0;

  return {
    getReader: () => ({
      read: async () =>
        position < chunks.length
          ? { done: false, value: chunks[position++] }
          : { done: true, value: undefined },
    }),
  };
}

function rawBody(chunks) {
  const bytes = new TextEncoder().encode(chunks.join(''));
  let consumed = false;

  return {
    getReader: () => ({
      read: async () => {
        if (consumed) return { done: true, value: undefined };

        consumed = true;

        return { done: false, value: bytes };
      },
    }),
  };
}

function hangingBody(signal) {
  return {
    getReader: () => ({
      read: () =>
        new Promise((_, reject) => {
          if (signal?.aborted) reject(new Error('aborted'));
          else
            signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    }),
  };
}

// Scripted OpenCode server. Modes select the /event behavior; every call
// is recorded for assertions.
function createStubServer({ eventMode = 'message', sseFrames = null } = {}) {
  const calls = [];
  const sseSessionId = sseFrames?.[0]?.properties?.sessionID ?? 'sess_1';
  const fetchImpl = async (url, options = {}) => {
    const href = String(url);
    const method = options.method ?? 'GET';

    calls.push({ href, method, body: options.body });

    if (options.signal?.aborted) throw new Error('aborted');
    if (href.includes('/global/health')) return jsonResponse({ healthy: true, version: '9.9.9' });
    if (href.includes('/permissions/')) return jsonResponse({ ok: true });
    if (href.includes('/abort')) return jsonResponse({ ok: true });
    if (href.includes('/prompt_async')) return jsonResponse({ ok: true });

    if (href.includes('/message') && method === 'POST')
      return jsonResponse({
        id: 'msg_1',
        parts: [
          {
            type: 'tool',
            tool: 'npm',
            state: { status: 'completed', input: { command: 'npm test' }, output: 'passed' },
          },
        ],
        usage: { inputTokens: 3, outputTokens: 9, model: 'oc-model' },
      });

    if (href.includes('/session?') && method === 'POST') return jsonResponse({ id: sseSessionId });

    if (href.includes('/event')) {
      if (eventMode === 'hang') return { ok: true, status: 200, body: hangingBody(options.signal) };
      if (eventMode === 'raw') return { ok: true, status: 200, body: rawBody(sseFrames) };
      if (eventMode === 'message') return jsonResponse({ ok: true });

      return { ok: true, status: 200, body: sseBody(sseFrames ?? []) };
    }

    throw new Error(`unexpected stub call: ${method} ${href}`);
  };

  return { fetchImpl, calls };
}

function withTempDir(run) {
  return async () => {
    const directory = mkdtempSync(join(tmpdir(), 'clew-opencode-plugin-'));

    try {
      await run(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function openCodeHost({ baseUrl = 'http://oc-test:4096', server, allowFake = false } = {}) {
  const host = createPluginHost({
    plugins: [],
    connections: [
      {
        id: 'opencode-default',
        plugin: OPENCODE_RUNTIME_PLUGIN_ID,
        enabled: true,
        config: { baseUrl },
      },
    ],
    allowFake,
  });

  registerOpenCodePlugin(host.registry, { fetchImpl: server.fetchImpl });

  return host;
}

// Group 1 (AC-1): worker flow through fixtures; unsupported role/policy
// combinations are refused before execution.

test(
  'plugins-opencode group 1: message worker flow through the adapter',
  withTempDir(async (directory) => {
    const server = createStubServer({ eventMode: 'message' });
    const direct = new OpenCodeHarness({ baseUrl: 'http://oc:4096', fetchImpl: server.fetchImpl });
    const directResult = await direct.run({
      task: fixtureTask,
      cwd: directory,
      onEvent: () => {},
    });
    const host = openCodeHost({ server: createStubServer({ eventMode: 'message' }) });
    const adapter = host.resolver.resolve({ connectionId: 'opencode-default' });
    const events = [];
    const checkpoints = [];
    const result = await adapter.run(
      {
        runId: 'run-1',
        brief: { task: fixtureTask, stageId: 'worker' },
        workspace: { cwd: directory },
      },
      {
        onEvent: (event) => events.push(event),
        onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
      },
    );

    assert.equal(result.status, 'completed');
    assert.deepEqual(result.output.output, directResult.output);
    assert.equal(result.session.nativeSessionId, directResult.sessionId);
    assert.equal(result.usage.status, 'reported');
    assert.equal(result.usage.inputTokens, 3);
    assert.deepEqual(result.output.verification, [
      { type: 'command', command: 'npm test', result: 'passed', output: 'passed' },
    ]);
    assert.deepEqual(
      events.map((event) => event.type),
      ['SESSION_STARTED', 'TURN_STARTED', 'HARNESS_COMPLETED'],
    );
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0].session.nativeSessionId, directResult.sessionId);
    await host.resolver.dispose();
  }),
);

test(
  'plugins-opencode group 1: streaming worker flow with approval through fixtures',
  withTempDir(async (directory) => {
    const fixture = readFixture('opencode-sse-complete.json');
    const server = createStubServer({ eventMode: 'sse', sseFrames: fixture.frames });
    const host = openCodeHost({ server });
    const adapter = host.resolver.resolve({ connectionId: 'opencode-default' });
    const events = [];
    const result = await adapter.run(
      { runId: 'run-sse', brief: { task: fixtureTask }, workspace: { cwd: directory } },
      { onEvent: (event) => events.push(event), requestApproval: () => 'accept' },
    );
    const permissionCall = server.calls.find((call) => call.href.includes('/permissions/'));

    assert.equal(result.status, 'completed');
    assert.equal(result.output.output, 'hello world');
    assert.ok(events.some((event) => event.type === 'APPROVAL_REQUIRED'));
    assert.ok(events.some((event) => event.type === 'APPROVAL_DECIDED'));
    assert.ok(permissionCall);
    assert.deepEqual(JSON.parse(permissionCall.body), { response: 'once' });
    assert.equal(result.usage.status, 'reported');
    assert.equal(result.usage.inputTokens, 11);
    assert.equal(result.usage.model, 'oc-fixture');
    await host.resolver.dispose();
  }),
);

test(
  'plugins-opencode group 1: resume skips session creation',
  withTempDir(async (directory) => {
    const server = createStubServer({ eventMode: 'message' });
    const host = openCodeHost({ server });
    const adapter = host.resolver.resolve({ connectionId: 'opencode-default' });
    const events = [];
    const result = await adapter.run(
      {
        runId: 'run-resume',
        brief: { task: fixtureTask },
        workspace: { cwd: directory },
        resumeSessionRef: { nativeSessionId: 'sess_old' },
      },
      { onEvent: (event) => events.push(event) },
    );

    assert.ok(!server.calls.some((call) => call.href.includes('/session?')));
    assert.ok(events.some((event) => event.type === 'SESSION_RESUMED'));
    assert.equal(result.status, 'completed');
    assert.equal(result.session.nativeSessionId, 'sess_old');
    await host.resolver.dispose();
  }),
);

test('plugins-opencode group 1: structured output is refused before execution', async () => {
  const server = createStubServer({ eventMode: 'message' });
  const host = openCodeHost({ server });
  const adapter = host.resolver.resolve({ connectionId: 'opencode-default' });

  await assert.rejects(
    adapter.run(
      {
        runId: 'run-schema',
        brief: { task: fixtureTask },
        workspace: { cwd: process.cwd() },
        outputSchema: { type: 'object' },
      },
      { onEvent: () => {} },
    ),
    /no verified schema-output mode/,
  );
  assert.equal(server.calls.length, 0);
  assert.ok(!adapter.describe().capabilities.includes('output.structured'));
  assert.throws(
    () =>
      host.resolver.resolve({
        connectionId: 'opencode-default',
        requireCapabilities: ['output.structured'],
      }),
    /does not support capabilities/,
  );
  await host.resolver.dispose();
});

test('plugins-opencode group 1: manifest and probe describe the honest boundary', async () => {
  const manifest = openCodeRuntimeManifest();

  assert.equal(validatePluginManifest(manifest).id, OPENCODE_RUNTIME_PLUGIN_ID);
  assert.deepEqual(createOpenCodeAgentRuntime({ id: 'x', config: {} }).describe().capabilities, [
    ...OPENCODE_CAPABILITIES,
  ]);

  const server = createStubServer({});
  const adapter = createOpenCodeAgentRuntime(
    { id: 'opencode-default', config: { baseUrl: 'http://oc:4096' } },
    { fetchImpl: server.fetchImpl },
  );
  const report = await adapter.probe();

  assert.equal(report.status, 'ready');

  const bad = createOpenCodeAgentRuntime(
    { id: 'opencode-default', config: { baseUrl: 'not-a-url' } },
    { fetchImpl: server.fetchImpl },
  );

  assert.equal((await bad.probe()).status, 'unavailable');
});

test('plugins-opencode group 1: foreign sessions never resume across runtimes', async () => {
  const server = createStubServer({ eventMode: 'message' });
  const host = openCodeHost({ server });
  const adapter = host.resolver.resolve({ connectionId: 'opencode-default' });

  await assert.rejects(
    adapter.run(
      {
        runId: 'run-foreign',
        brief: { task: fixtureTask },
        workspace: { cwd: process.cwd() },
        resumeSessionRef: { runtime: 'codex', connection: 'x', nativeSessionId: 'sess' },
      },
      { onEvent: () => {} },
    ),
    /never move between runtimes/,
  );

  assert.equal(server.calls.length, 0);
  await host.resolver.dispose();
});

// Group 2 (AC-2): no direct openCodeUrl reads in services; resolver wiring.

test('plugins-opencode group 2: domain services do not import the OpenCode module', () => {
  const guarded = ['scheduler.js', 'runner-execution.js', 'architect.js', 'review.js'];
  const forbidden =
    /(?:from|import\()\s*['"][^'"]*plugins\/opencode|import\s*\{[^}]*\bOpenCodeHarness\b/;
  const violations = [];

  for (const file of guarded) {
    const content = readFileSync(join(srcDir, file), 'utf8');

    if (forbidden.test(content)) violations.push(file);
  }

  assert.deepEqual(violations, []);
});

test('plugins-opencode group 2: harness facade re-exports the plugin class', () => {
  assert.equal(FacadeHarness, OpenCodeHarness);
});

test('plugins-opencode group 2: scheduler resolves OpenCode through the resolver', () => {
  const host = openCodeHost({
    baseUrl: 'http://oc-resolver:4096',
    server: createStubServer({}),
  });
  const scheduler = new Scheduler(
    null,
    { root: null },
    { runtimeResolver: host.resolver, adapterConfig: {} },
  );
  const harness = scheduler.createHarnessAdapter('opencode');

  assert.ok(harness instanceof OpenCodeHarness);
  assert.equal(harness.baseUrl, 'http://oc-resolver:4096');

  const legacy = new Scheduler(
    null,
    { root: null },
    { adapterConfig: { openCodeUrl: 'http://oc-legacy:4096' } },
  );

  assert.equal(legacy.createHarnessAdapter('opencode').baseUrl, 'http://oc-legacy:4096');
});

test('plugins-opencode group 2: runner resolves OpenCode through the resolver', () => {
  const host = openCodeHost({
    baseUrl: 'http://oc-runner:4096',
    server: createStubServer({}),
  });
  const port = new RunnerExecutionPort({ adapterConfig: {}, runtimeResolver: host.resolver });

  assert.equal(port.createHarness('opencode').baseUrl, 'http://oc-runner:4096');

  const legacyPort = new RunnerExecutionPort({
    adapterConfig: { openCodeUrl: 'http://oc-r:4096' },
  });

  assert.equal(legacyPort.createHarness('opencode').baseUrl, 'http://oc-r:4096');
});

// Group 3 (AC-3): text output is never fabricated into structured results.

test(
  'plugins-opencode group 3: text output stays text, never a fabricated plan',
  withTempDir(async (directory) => {
    const fixture = readFixture('opencode-sse-complete.json');
    const server = createStubServer({ eventMode: 'sse', sseFrames: fixture.frames });
    const host = openCodeHost({ server });
    const adapter = host.resolver.resolve({ connectionId: 'opencode-default' });
    const result = await adapter.run(
      { runId: 'run-text', brief: { task: fixtureTask }, workspace: { cwd: directory } },
      { onEvent: () => {}, requestApproval: () => 'accept' },
    );

    assert.equal(result.status, 'completed');
    assert.equal(typeof result.output.output, 'string');
    await host.resolver.dispose();
  }),
);

// Group 4 (AC-4): truncated JSON/SSE, timeout, duplicates, interrupt.

test(
  'plugins-opencode group 4: truncated JSON fails as protocol error',
  withTempDir(async (directory) => {
    const fixture = readFixture('opencode-sse-truncated.json');
    const server = createStubServer({ eventMode: 'raw', sseFrames: fixture.rawChunks });
    const host = openCodeHost({ server });
    const adapter = host.resolver.resolve({ connectionId: 'opencode-default' });
    const result = await adapter.run(
      { runId: 'run-truncated', brief: { task: fixtureTask }, workspace: { cwd: directory } },
      { onEvent: () => {} },
    );

    assert.equal(result.status, 'failed');
    assert.equal(result.error.class, 'protocol');
    await host.resolver.dispose();
  }),
);

test(
  'plugins-opencode group 4: timeout maps to a timeout failure',
  withTempDir(async (directory) => {
    const server = createStubServer({ eventMode: 'hang' });
    const host = openCodeHost({ server });
    const adapter = host.resolver.resolve({ connectionId: 'opencode-default' });

    adapter.asLegacyHarness().timeoutMs = 100;
    const result = await adapter.run(
      { runId: 'run-timeout', brief: { task: fixtureTask }, workspace: { cwd: directory } },
      { onEvent: () => {} },
    );

    assert.equal(result.status, 'failed');
    assert.equal(result.error.class, 'timeout');
    await host.resolver.dispose();
  }),
);

test(
  'plugins-opencode group 4: duplicate events complete without double usage',
  withTempDir(async (directory) => {
    const textFrame = {
      type: 'message.part.updated',
      properties: { sessionID: 'sess_s', part: { type: 'text', text: 'again ' } },
    };
    const idleFrame = {
      type: 'session.status',
      properties: {
        sessionID: 'sess_s',
        status: { type: 'idle' },
        usage: { inputTokens: 2, outputTokens: 4 },
      },
    };
    const server = createStubServer({
      eventMode: 'sse',
      sseFrames: [textFrame, textFrame, idleFrame],
    });
    const host = openCodeHost({ server });
    const adapter = host.resolver.resolve({ connectionId: 'opencode-default' });
    const result = await adapter.run(
      { runId: 'run-dup', brief: { task: fixtureTask }, workspace: { cwd: directory } },
      { onEvent: () => {} },
    );

    assert.equal(result.status, 'completed');
    assert.equal(result.usage.status, 'reported');
    assert.equal(result.usage.inputTokens, 2);
    assert.equal(result.output.output, 'again again ');
    await host.resolver.dispose();
  }),
);

test(
  'plugins-opencode group 4: abort maps to an interrupted result',
  withTempDir(async (directory) => {
    const server = createStubServer({ eventMode: 'hang' });
    const host = openCodeHost({ server });
    const adapter = host.resolver.resolve({ connectionId: 'opencode-default' });

    adapter.asLegacyHarness().timeoutMs = 5_000;
    const controller = new AbortController();
    const events = [];
    const pending = adapter.run(
      { runId: 'run-abort', brief: { task: fixtureTask }, workspace: { cwd: directory } },
      {
        onEvent: (event) => {
          events.push(event);

          if (event.type === 'SESSION_STARTED') controller.abort();
        },
        signal: controller.signal,
      },
    );
    const result = await pending;

    assert.equal(result.status, 'interrupted');
    assert.ok(server.calls.some((call) => call.href.includes('/abort')));
    await host.resolver.dispose();
  }),
);

test('plugins-opencode group 4: legacy mapping and exclusivity', () => {
  const { connection, diagnostics } = buildLegacyOpenCodeConnection({
    openCodeUrl: 'http://oc-map:4096',
  });

  assert.equal(connection.id, 'opencode-default');
  assert.equal(connection.plugin, OPENCODE_RUNTIME_PLUGIN_ID);
  assert.equal(connection.config.baseUrl, 'http://oc-map:4096');
  assert.equal(diagnostics[0].source, 'openCodeUrl');

  const fallback = buildLegacyOpenCodeConnection({});

  assert.equal(
    fallback.connection.config.baseUrl,
    process.env.CLEW_OPENCODE_URL ?? 'http://127.0.0.1:4096',
  );
  assert.equal(selectOpenCodeConnectionId({}), 'opencode-default');
  assert.equal(selectOpenCodeConnectionId({ connection: 'custom' }), 'custom');
  assert.throws(
    () => selectOpenCodeConnectionId({ explicitHarness: 'opencode', connection: 'custom' }),
    /either --harness or --connection/,
  );
  assertHarnessConnectionExclusive({ harness: null, connection: 'opencode-default' });
  assert.throws(
    () => assertHarnessConnectionExclusive({ harness: 'opencode', connection: 'opencode-default' }),
    /either --harness or --connection/,
  );

  try {
    assertHarnessConnectionExclusive({ harness: 'opencode', connection: 'x' });
  } catch (error) {
    assert.equal(error.code, PLUGIN_ERROR_CODE.INVALID_CONFIG);

    return;
  }

  assert.fail('expected an error');
});
