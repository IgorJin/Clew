import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { CodexHarness } from '../src/plugins/codex/harness.js';
import { CodexHarness as FacadeHarness } from '../src/harness.js';
import {
  CODEX_CAPABILITIES,
  createCodexAgentRuntime,
  registerCodexPlugin,
} from '../src/plugins/codex/index.js';
import { CODEX_RUNTIME_PLUGIN_ID } from '../src/plugins/codex/manifest.js';
import { CodexArchitect, CodexReviewer } from '../src/plugins/codex/role-services.js';
import { createPluginHost } from '../src/plugins/index.js';
import { PLUGIN_ERROR_CODE } from '../src/plugins/errors.js';
import {
  LEGACY_CONNECTION_IDS,
  assertHarnessConnectionExclusive,
  buildLegacyCodexConnection,
  selectCodexConnectionId,
} from '../src/plugins/legacy.js';
import { Scheduler } from '../src/scheduler.js';
import { RunnerExecutionPort } from '../src/runner-execution.js';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');

const fixtureTask = Object.freeze({
  id: 'CODEX-1',
  title: 'Codex plugin',
  goal: 'Exercise the Codex adapter through a scripted app-server',
  acceptance: [{ id: 'AC-1', criterion: 'the adapter preserves behavior' }],
});

const STRUCTURED_PLAN = Object.freeze({
  parallelizable: false,
  stages: [{ id: 'worker', kind: 'worker', goal: 'Implement', dependsOn: [] }],
});

function enoentSpawn() {
  throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
}

// Minimal scripted app-server speaking just enough JSON-RPC for the flows
// below: initialize, thread/start (or thread/resume), thread/name/set,
// turn/start, one approval round-trip, and turn/completed.
function createFakeAppServer({ approval = true, completeTurn = true } = {}) {
  const requests = [];
  const decisions = [];
  const spawnImpl = (_command, _args, _options) => {
    const child = new EventEmitter();

    child.kill = () => {};
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    let input = '';
    const send = (message) =>
      Promise.resolve().then(() => child.stdout.write(`${JSON.stringify(message)}\n`));
    const route = (message) => {
      requests.push(message);

      if (message.method === 'initialize') send({ id: message.id, result: {} });
      else if (message.method === 'thread/start')
        send({ id: message.id, result: { thread: { id: 'thr_fixture' } } });
      else if (message.method === 'thread/resume')
        send({ id: message.id, result: { thread: { id: 'thr_resumed' } } });
      else if (message.method === 'thread/name/set') send({ id: message.id, result: {} });
      else if (message.method === 'turn/start') {
        send({ id: message.id, result: { turn: { id: 'turn_fixture' } } });

        if (approval)
          send({ id: 100, method: 'test/requestApproval', params: { prompt: 'allow?' } });
        else if (completeTurn) sendCompleted();
      } else if (message.id === 100 && message.result?.decision) {
        decisions.push(message.result.decision);

        if (completeTurn) sendCompleted();
      }
    };
    const sendCompleted = () =>
      send({
        method: 'turn/completed',
        params: {
          turn: {
            status: 'completed',
            id: 'turn_fixture',
            output: { output: STRUCTURED_PLAN },
            usage: { inputTokens: 5, outputTokens: 7, model: 'fixture-model' },
          },
        },
      });

    child.stdin.on('data', (chunk) => {
      input += chunk.toString();
      let newline;

      while ((newline = input.indexOf('\n')) >= 0) {
        const line = input.slice(0, newline).trim();

        input = input.slice(newline + 1);

        if (line) route(JSON.parse(line));
      }
    });

    return child;
  };

  return { spawnImpl, requests, decisions };
}

function withTempDir(run) {
  return async () => {
    const directory = mkdtempSync(join(tmpdir(), 'clew-codex-plugin-'));

    try {
      await run(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function codexHost({ bin = 'codex', spawnImpl, allowFake = false } = {}) {
  const { connection } = buildLegacyCodexConnection({ codexBin: bin });
  const host = createPluginHost({ plugins: [], connections: [connection], allowFake });

  registerCodexPlugin(host.registry, { spawnImpl });

  return { host, connection };
}

// Group 1 (AC-1): the resolver-backed adapter produces the same canonical
// outcomes as the direct harness on identical scripted protocol runs.

test(
  'plugins-codex group 1: adapter and direct harness agree on the happy path',
  withTempDir(async (directory) => {
    const server = createFakeAppServer();
    const directEvents = [];
    const direct = new CodexHarness({
      command: 'codex',
      spawnImpl: server.spawnImpl,
      timeoutMs: 5_000,
    });
    const directResult = await direct.run({
      task: fixtureTask,
      cwd: directory,
      onEvent: (event) => directEvents.push(event),
      onApproval: () => 'accept',
    });
    const { host } = codexHost({ spawnImpl: createFakeAppServer().spawnImpl });
    const adapter = host.resolver.resolve({ connectionId: 'codex-default' });
    const adapterEvents = [];
    const checkpoints = [];
    const adapterResult = await adapter.run(
      {
        runId: 'run-1',
        brief: { task: fixtureTask, stageId: 'worker' },
        workspace: { cwd: directory },
      },
      {
        onEvent: (event) => adapterEvents.push(event),
        onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
        requestApproval: () => 'accept',
      },
    );

    assert.equal(adapterResult.status, 'completed');
    assert.deepEqual(adapterResult.output.output, directResult.output);
    assert.deepEqual(
      adapterEvents.map((event) => event.type),
      directEvents.map((event) => event.type),
    );
    assert.equal(adapterResult.session.nativeSessionId, directResult.sessionId);
    assert.equal(adapterResult.usage.status, 'reported');
    assert.equal(adapterResult.usage.inputTokens, 5);
    assert.equal(adapterResult.usage.outputTokens, 7);
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0].session.nativeSessionId, directResult.sessionId);
    await host.resolver.dispose();
  }),
);

test(
  'plugins-codex group 1: adapter and direct harness agree on failures',
  withTempDir(async (directory) => {
    const failing = createFakeAppServer({ approval: false, completeTurn: false });
    const direct = new CodexHarness({
      command: 'codex',
      spawnImpl: failing.spawnImpl,
      timeoutMs: 300,
    });

    await assert.rejects(
      direct.run({ task: fixtureTask, cwd: directory, onEvent: () => {} }),
      /timed out/,
    );

    const { host } = codexHost({ spawnImpl: failing.spawnImpl });
    const adapter = host.resolver.resolve({ connectionId: 'codex-default' });

    adapter.asLegacyHarness().timeoutMs = 300;
    const timeoutResult = await adapter.run(
      { runId: 'run-timeout', brief: { task: fixtureTask }, workspace: { cwd: directory } },
      { onEvent: () => {} },
    );

    assert.equal(timeoutResult.status, 'failed');
    assert.equal(timeoutResult.error.class, 'timeout');

    const missing = createCodexAgentRuntime(
      { id: 'codex-default', config: { bin: 'codex' } },
      { spawnImpl: enoentSpawn },
    );
    const enoentResult = await missing.run(
      { runId: 'run-enoent', brief: { task: fixtureTask }, workspace: { cwd: directory } },
      { onEvent: () => {} },
    );

    assert.equal(enoentResult.status, 'failed');
    assert.equal(enoentResult.error.code, 'CODEX_EXECUTABLE_NOT_FOUND');
    assert.equal(enoentResult.error.class, 'configuration');

    const directMissing = new CodexHarness({ command: 'codex', spawnImpl: enoentSpawn });

    // The raw harness only maps async spawn errors; a synchronous throw
    // surfaces raw. The adapter normalizes both timings to one launch code.
    await assert.rejects(
      directMissing.run({ task: fixtureTask, cwd: directory, onEvent: () => {} }),
      (error) => error.code === 'ENOENT',
    );
    await host.resolver.dispose();
  }),
);

// Group 2 (AC-2): scheduler and runner resolve Codex through the plugin
// seam; no domain service imports the Codex module directly.

test('plugins-codex group 2: domain services do not import the Codex module', () => {
  const guarded = ['scheduler.js', 'runner-execution.js', 'architect.js', 'review.js'];
  // Forbidden: imports from `plugins/codex/*`, and direct imports of the
  // Codex implementation bindings from anywhere. The generic transition
  // bridge `plugins/legacy.js` (e.g. `resolveCodexHarness`) is allowed
  // until CLEW-133.
  const forbidden =
    /(?:from|import\()\s*['"][^'"]*plugins\/codex|import\s*\{[^}]*\b(CodexHarness|CodexArchitect|CodexReviewer|codexLaunchError)\b/;
  const violations = [];

  for (const file of guarded) {
    const content = readFileSync(join(srcDir, file), 'utf8');

    if (forbidden.test(content)) violations.push(file);
  }

  assert.deepEqual(violations, []);
});

test('plugins-codex group 2: harness facade re-exports the plugin class', () => {
  assert.equal(FacadeHarness, CodexHarness);
});

test('plugins-codex group 2: scheduler resolves Codex through the resolver', () => {
  const { host } = codexHost({ bin: 'codex-test-bin' });
  const scheduler = new Scheduler(
    null,
    { root: null },
    { runtimeResolver: host.resolver, adapterConfig: {} },
  );
  const harness = scheduler.createHarnessAdapter('codex');

  assert.ok(harness instanceof CodexHarness);
  assert.equal(harness.command, 'codex-test-bin');

  const legacy = new Scheduler(null, { root: null }, { adapterConfig: { codexBin: 'legacy-bin' } });
  const legacyHarness = legacy.createHarnessAdapter('codex');

  assert.ok(legacyHarness instanceof CodexHarness);
  assert.equal(legacyHarness.command, 'legacy-bin');

  const reviewer = scheduler.createReviewerAdapter('codex');

  assert.ok(reviewer instanceof CodexReviewer);

  const architect = scheduler.createArchitectAdapter('codex');

  assert.ok(architect instanceof CodexArchitect);
});

test('plugins-codex group 2: runner resolves Codex through the resolver', () => {
  const { host } = codexHost({ bin: 'codex-runner-bin' });
  const port = new RunnerExecutionPort({
    adapterConfig: {},
    runtimeResolver: host.resolver,
  });
  const harness = port.createHarness('codex');

  assert.ok(harness instanceof CodexHarness);
  assert.equal(harness.command, 'codex-runner-bin');

  const legacyPort = new RunnerExecutionPort({ adapterConfig: { codexBin: 'runner-legacy-bin' } });

  assert.equal(legacyPort.createHarness('codex').command, 'runner-legacy-bin');
  assert.ok(legacyPort.createReviewer('codex') instanceof CodexReviewer);
  assert.ok(legacyPort.createArchitect('codex') instanceof CodexArchitect);
});

// Group 3 (AC-3): approval bridge, abort, resume, structured output,
// single writer, probe, and surface spec through the adapter.

test(
  'plugins-codex group 3: approval decisions reach the native turn',
  withTempDir(async (directory) => {
    const server = createFakeAppServer();
    const { host } = codexHost({ spawnImpl: server.spawnImpl });
    const adapter = host.resolver.resolve({ connectionId: 'codex-default' });
    const result = await adapter.run(
      { runId: 'run-approval', brief: { task: fixtureTask }, workspace: { cwd: directory } },
      { onEvent: () => {}, requestApproval: () => 'accept' },
    );

    assert.equal(result.status, 'completed');
    assert.deepEqual(server.decisions, ['accept']);
    assert.deepEqual(result.output.output, { output: STRUCTURED_PLAN });
    await host.resolver.dispose();
  }),
);

test(
  'plugins-codex group 3: abort maps to an interrupted result without a duplicate run',
  withTempDir(async (directory) => {
    const hanging = createFakeAppServer({ approval: false, completeTurn: false });
    const { host } = codexHost({ spawnImpl: hanging.spawnImpl });
    const adapter = host.resolver.resolve({ connectionId: 'codex-default' });

    adapter.asLegacyHarness().interruptTimeoutMs = 50;
    const controller = new AbortController();
    const events = [];
    const pending = adapter.run(
      { runId: 'run-abort', brief: { task: fixtureTask }, workspace: { cwd: directory } },
      {
        onEvent: (event) => {
          events.push(event);

          if (event.type === 'TURN_STARTED') controller.abort();
        },
        signal: controller.signal,
      },
    );
    const result = await pending;

    assert.equal(result.status, 'interrupted');
    assert.equal(events.filter((event) => event.type === 'TURN_STARTED').length, 1);
    await host.resolver.dispose();
  }),
);

test(
  'plugins-codex group 3: resume continues the native session',
  withTempDir(async (directory) => {
    const server = createFakeAppServer({ approval: false });
    const { host } = codexHost({ spawnImpl: server.spawnImpl });
    const adapter = host.resolver.resolve({ connectionId: 'codex-default' });
    const events = [];
    const result = await adapter.run(
      {
        runId: 'run-resume',
        brief: { task: fixtureTask },
        workspace: { cwd: directory },
        resumeSessionRef: { nativeSessionId: 'thr_old' },
      },
      { onEvent: (event) => events.push(event) },
    );
    const resumeCall = server.requests.find((message) => message.method === 'thread/resume');

    assert.ok(resumeCall);
    assert.equal(resumeCall.params.threadId, 'thr_old');
    assert.ok(events.some((event) => event.type === 'SESSION_RESUMED'));
    assert.equal(result.status, 'completed');
    assert.equal(result.session.nativeSessionId, 'thr_resumed');
    await host.resolver.dispose();
  }),
);

test('plugins-codex group 3: one adapter owns one writer', () => {
  const adapter = createCodexAgentRuntime({ id: 'codex-default', config: { bin: 'codex' } });

  assert.equal(adapter.asLegacyHarness(), adapter.asLegacyHarness());
  assert.deepEqual(adapter.describe().capabilities, [...CODEX_CAPABILITIES]);
  assert.ok(adapter.describe().capabilities.includes('execution.headless'));
});

test('plugins-codex group 3: probe reports unavailable binaries without throwing', async () => {
  const adapter = createCodexAgentRuntime({
    id: 'codex-default',
    config: { bin: '/definitely/missing/clew-codex-probe' },
  });
  const report = await adapter.probe();

  assert.equal(report.status, 'unavailable');
  assert.equal(report.ok ?? undefined, undefined);
});

test('plugins-codex group 3: prepareSurface describes resume without owning the terminal', () => {
  const adapter = createCodexAgentRuntime({ id: 'codex-default', config: { bin: 'codex' } });
  const resume = adapter.prepareSurface({
    sessionId: 'thr_1',
    workspace: '/work/tree',
    liveEndpoint: 'unix:///tmp/live.sock',
  });

  assert.equal(resume.kind, 'codex-resume');
  assert.deepEqual(resume.args, ['resume', '--remote', 'unix:///tmp/live.sock', 'thr_1']);

  const plain = adapter.prepareSurface({ workspace: '/work/tree' });

  assert.equal(plain.kind, 'codex-open');
});

// Group 4 (AC-4): legacy codexBin mapping and the harness/connection
// exclusivity rule.

test('plugins-codex group 4: codexBin maps to a legacy connection with diagnostics', () => {
  const { connection, diagnostics } = buildLegacyCodexConnection({ codexBin: '/bin/codex' });

  assert.equal(connection.id, 'codex-default');
  assert.equal(connection.plugin, CODEX_RUNTIME_PLUGIN_ID);
  assert.equal(connection.config.bin, '/bin/codex');
  assert.equal(diagnostics[0].source, 'codexBin');
  assert.match(diagnostics[0].message, /prefer an explicit connection/);

  const fallback = buildLegacyCodexConnection({});

  assert.equal(fallback.connection.config.bin, process.env.CLEW_CODEX_BIN ?? 'codex');
});

test('plugins-codex group 4: harness and connection cannot be combined', () => {
  assertHarnessConnectionExclusive({ harness: null, connection: 'codex-default' });
  assertHarnessConnectionExclusive({ harness: 'codex', connection: null });
  assert.throws(
    () => assertHarnessConnectionExclusive({ harness: 'codex', connection: 'codex-default' }),
    /either --harness or --connection/,
  );

  try {
    assertHarnessConnectionExclusive({ harness: 'codex', connection: 'x' });
  } catch (error) {
    assert.equal(error.code, PLUGIN_ERROR_CODE.INVALID_CONFIG);

    return;
  }

  assert.fail('expected an error');
});

test('plugins-codex group 4: connection selection prefers explicit values', () => {
  assert.equal(selectCodexConnectionId({}), LEGACY_CONNECTION_IDS.codex);
  assert.equal(selectCodexConnectionId({ connection: 'custom' }), 'custom');
  assert.throws(
    () => selectCodexConnectionId({ explicitHarness: 'codex', connection: 'custom' }),
    /either --harness or --connection/,
  );
});

test('plugins-codex group 4: legacy-mapped connection resolves to the mapped binary', () => {
  const { connection } = buildLegacyCodexConnection({ codexBin: '/mapped/codex' });
  const host = createPluginHost({ plugins: [], connections: [connection], allowFake: false });

  registerCodexPlugin(host.registry, {});
  const harness = host.resolver.resolve({ connectionId: 'codex-default' }).asLegacyHarness();

  assert.ok(harness instanceof CodexHarness);
  assert.equal(harness.command, '/mapped/codex');
});
