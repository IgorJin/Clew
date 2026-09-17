#!/usr/bin/env node
/** Manual acceptance stand for the plugin epic (CLEW-127–133).
 *
 * Runs every user-visible guarantee of the plugin architecture against the
 * real modules, without any external CLI or network access (fixtures and
 * fakes only). Prints a readable report so a human can verify by hand.
 *
 * Usage:
 *   node scripts/plugins-stand.js            # run everything, clean up
 *   node scripts/plugins-stand.js --keep     # keep the temp workspace
 *   node scripts/plugins-stand.js --step     # pause for Enter between sections
 *   node scripts/plugins-stand.js --json     # machine-readable summary
 *   node scripts/plugins-stand.js --section 127,128
 *
 * Exit code is non-zero when any check fails.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';
import { PassThrough } from 'node:stream';
import { TextEncoder } from 'node:util';
import { createInterface } from 'node:readline';

import { DEFAULT_CONFIG, loadConfig } from '../src/config.js';
import { ClewService } from '../src/control-service.js';
import { Store } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { GitWorktreeManager } from '../src/workspace.js';
import { Observability } from '../src/observability.js';
import { RunnerExecutionPort } from '../src/runner-execution.js';
import { createPluginHost } from '../src/plugins/index.js';
import { PluginRegistry } from '../src/plugins/registry.js';
import { ConnectionResolver } from '../src/plugins/resolver.js';
import { PLUGIN_ERROR_CODE } from '../src/plugins/errors.js';
import {
  assertHarnessConnectionExclusive,
  buildLegacyCodexConnection,
  legacyDefaultModel,
  LEGACY_REVIEWER_MODEL,
  resolveCodexReviewer,
} from '../src/plugins/legacy.js';
import { buildRuntimeHost, collectRunnerInventory } from '../src/plugins/host.js';
import { resolveRoleRoute } from '../src/plugins/role-routing.js';
import {
  buildRunBinding,
  checkBindingCompatible,
  fingerprintConnectionConfig,
} from '../src/plugins/binding.js';
import { registerCodexPlugin } from '../src/plugins/codex/index.js';
import { CodexHarness } from '../src/plugins/codex/harness.js';
import { registerOpenCodePlugin } from '../src/plugins/opencode/index.js';
import { TEST_SINK_PLUGIN_ID } from '../src/plugins/telemetry/manifest.js';
import {
  registerTelemetryPlugins,
  createTestTelemetrySink,
} from '../src/plugins/telemetry/index.js';
import {
  fakeRuntimeManifest,
  createFakeAgentRuntime,
  FAKE_RUNTIME_PLUGIN_ID,
} from '../src/plugins/fake-runtime.js';

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith('--')));
const sectionFilter = (() => {
  const arg = args.find((value) => value.startsWith('--section'));

  if (!arg) return null;
  const value = arg.includes('=') ? arg.split('=')[1] : args[args.indexOf(arg) + 1];

  return value ? new Set(value.split(',').map((entry) => entry.trim())) : null;
})();

const keep = flags.has('--keep');
const stepMode = flags.has('--step');
const json = flags.has('--json');
const workspace = mkdtempSync(join(tmpdir(), 'clew-stand-'));
const results = [];
let currentSection = null;
let sectionSkip = false;

function enabled(section) {
  return !sectionFilter || sectionFilter.has(section);
}

function heading(title) {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);
}

async function pause() {
  if (!stepMode) return;

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  await new Promise((resolve) => rl.question('  [Enter для продолжения]', () => resolve()));
  rl.close();
}

async function section(id, title, run) {
  if (!enabled(id)) return;
  currentSection = id;
  sectionSkip = false;
  heading(`${id} — ${title}`);
  await run();
  await pause();
}

async function step(name, fn) {
  if (sectionSkip) return;
  try {
    const detail = await fn();

    results.push({ section: currentSection, name, status: 'PASS' });
    console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    results.push({
      section: currentSection,
      name,
      status: 'FAIL',
      error: error?.message ?? String(error),
    });
    console.log(`  ✘ ${name}\n      ${error?.message ?? error}`);
  }
}

function expectThrows(fn, pattern) {
  let thrown = null;

  try {
    fn();
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown, 'expected an error but the call succeeded');
  if (pattern) assert.match(String(thrown.message ?? thrown), pattern);

  return thrown;
}

async function expectRejects(promise, pattern) {
  let thrown = null;

  try {
    await promise;
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown, 'expected a rejection but the call resolved');
  if (pattern) assert.match(String(thrown.message ?? thrown), pattern);

  return thrown;
}

// ---------------------------------------------------------------------------
// Fixtures

const TASK = Object.freeze({
  id: 'STAND-1',
  title: 'Stand task',
  goal: 'Exercise the plugin stand',
  acceptance: [{ id: 'AC-1', criterion: 'the stand runs' }],
  profile: 'quick',
  base_ref: 'HEAD',
});

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeGitProject() {
  const project = join(workspace, `project-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  mkdirSync(project, { recursive: true });
  git(['init', '-b', 'main'], project);
  git(['config', 'user.email', 'stand@example.com'], project);
  git(['config', 'user.name', 'Stand'], project);
  writeFileSync(join(project, 'README.md'), 'base\n');
  git(['add', 'README.md'], project);
  git(['commit', '-m', 'base'], project);

  return project;
}

function makeStore(name = 'stand') {
  const directory = join(workspace, `${name}-${Math.random().toString(36).slice(2)}`);

  mkdirSync(join(directory, '.clew'), { recursive: true });

  return { directory, store: new Store(join(directory, '.clew', 'clew.sqlite')) };
}

/** Scripted Codex app-server over stdio JSON-RPC. */
function codexServer(handler) {
  const requests = [];
  const spawnImpl = (_command, _args, _options) => {
    const child = new EventEmitter();

    child.kill = () => {};
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    let input = '';
    const send = (message) =>
      Promise.resolve().then(() => child.stdout.write(`${JSON.stringify(message)}\n`));

    child.stdin.on('data', (chunk) => {
      input += chunk.toString();
      let newline;

      while ((newline = input.indexOf('\n')) >= 0) {
        const line = input.slice(0, newline).trim();

        input = input.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);

        requests.push(message);
        handler(message, send);
      }
    });

    return child;
  };

  return { spawnImpl, requests };
}

const defaultCodexHandler = {
  initialize: (message, send) => send({ id: message.id, result: {} }),
  'thread/start': (message, send) =>
    send({ id: message.id, result: { thread: { id: 'thr_stand' } } }),
  'thread/resume': (message, send) =>
    send({ id: message.id, result: { thread: { id: 'thr_resumed' } } }),
  'thread/name/set': (message, send) => send({ id: message.id, result: {} }),
  'turn/start': (message, send) => {
    send({ id: message.id, result: { turn: { id: 'turn_stand' } } });
    send({
      method: 'turn/completed',
      params: {
        turn: {
          status: 'completed',
          id: 'turn_stand',
          output: { output: { parallelizable: false, stages: [] } },
          usage: { inputTokens: 11, outputTokens: 22, model: 'fixture-model' },
        },
      },
    });
  },
};

function scriptedCodex(overrides = {}) {
  const handler = { ...defaultCodexHandler, ...overrides };

  return codexServer((message, send) => handler[message.method]?.(message, send));
}

/** Minimal OpenCode server stub over injected fetch. */
function openCodeServer({ eventMode = 'message', frames = [], hang = false } = {}) {
  const calls = [];
  const sessionId = frames[0]?.properties?.sessionID ?? 'sess_stand';
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
        id: 'msg_stand',
        parts: [],
        usage: { inputTokens: 3, outputTokens: 4 },
      });
    if (href.includes('/session?') && method === 'POST') return jsonResponse({ id: sessionId });
    if (href.includes('/event')) {
      if (hang) return { ok: true, status: 200, body: hangingBody(options.signal) };
      if (eventMode === 'sse') return { ok: true, status: 200, body: sseBody(frames) };

      return jsonResponse({ ok: true });
    }

    throw new Error(`unexpected OpenCode call: ${method} ${href}`);
  };

  return { fetchImpl, calls };
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

function codexHost(hostServices = {}) {
  const { connection } = buildLegacyCodexConnection({ codexBin: 'codex' });
  const host = createPluginHost({ plugins: [], connections: [connection], allowFake: false });

  registerCodexPlugin(host.registry, hostServices);

  return host;
}

function openCodeHost(server, baseUrl = 'http://oc-stand:4096') {
  const host = createPluginHost({
    plugins: [],
    connections: [
      {
        id: 'opencode-default',
        plugin: 'clew.runtime.opencode',
        enabled: true,
        config: { baseUrl },
      },
    ],
    allowFake: false,
  });

  registerOpenCodePlugin(host.registry, { fetchImpl: server.fetchImpl });

  return host;
}

function fakeHost(allowFake = true) {
  return createPluginHost({
    plugins: [{ manifest: fakeRuntimeManifest(), factory: createFakeAgentRuntime }],
    connections: [{ id: 'fake-test', plugin: FAKE_RUNTIME_PLUGIN_ID, enabled: true, config: {} }],
    allowFake,
  });
}

// ===========================================================================
// 127 — contracts, registry, resolver, DI rule, config safety

await section('127', 'Plugin API v1: registry, resolver, config safety', async () => {
  await step('manifest validation accepts a valid plugin and lists it', () => {
    const registry = new PluginRegistry();

    registry.register(fakeRuntimeManifest(), createFakeAgentRuntime);
    const list = registry.list();

    assert.equal(list.length, 1);
    assert.equal(list[0].id, FAKE_RUNTIME_PLUGIN_ID);

    return `${list[0].id} v${list[0].version} api v${list[0].apiVersion}`;
  });

  await step('duplicate plugin id is an error regardless of load order', () => {
    const registry = new PluginRegistry();

    registry.register(fakeRuntimeManifest(), createFakeAgentRuntime);
    const error = expectThrows(
      () =>
        registry.register({ ...fakeRuntimeManifest(), version: '9.9.9' }, createFakeAgentRuntime),
      /duplicate plugin id/,
    );

    assert.equal(error.code, PLUGIN_ERROR_CODE.DUPLICATE_ID);

    return error.code;
  });

  await step('unknown plugin id and unknown connection are explicit errors', () => {
    const registry = new PluginRegistry();
    const resolver = new ConnectionResolver({
      registry,
      connections: [{ id: 'ghost', plugin: 'clew.runtime.ghost', enabled: true, config: {} }],
      allowFake: true,
    });
    const unknownPlugin = expectThrows(
      () => resolver.resolve({ connectionId: 'ghost' }),
      /unknown plugin id/,
    );

    assert.equal(unknownPlugin.code, PLUGIN_ERROR_CODE.UNKNOWN_ID);

    const unknownConnection = expectThrows(
      () => resolver.resolve({ connectionId: 'nope' }),
      /unknown connection id/,
    );

    assert.equal(unknownConnection.code, PLUGIN_ERROR_CODE.UNKNOWN_ID);

    return `${unknownPlugin.code} / ${unknownConnection.code}`;
  });

  await step(
    'incompatible Plugin API and unsupported capability fail before execution',
    async () => {
      const registry = new PluginRegistry();

      registerCodexPlugin(registry, {});
      const apiError = expectThrows(
        () =>
          registry.register({ ...fakeRuntimeManifest(), apiVersion: '2' }, createFakeAgentRuntime),
        /requires Plugin API/,
      );

      assert.equal(apiError.code, PLUGIN_ERROR_CODE.INCOMPATIBLE_API);
      const { connection } = buildLegacyCodexConnection({ codexBin: 'codex' });
      const resolver = new ConnectionResolver({
        registry,
        connections: [connection],
        allowFake: false,
      });
      const capabilityError = expectThrows(
        () =>
          resolver.resolve({
            connectionId: 'codex-default',
            requireCapabilities: ['surface.attach'],
          }),
        /does not support capabilities/,
      );

      assert.equal(capabilityError.code, PLUGIN_ERROR_CODE.UNSUPPORTED_CAPABILITY);

      return `${apiError.code} / ${capabilityError.code}`;
    },
  );

  await step('fake runtime is gated behind an explicit test route', async () => {
    const closed = fakeHost(false);

    const refused = expectThrows(
      () => closed.resolver.resolve({ connectionId: 'fake-test' }),
      /explicit test route/,
    );

    assert.equal(refused.code, PLUGIN_ERROR_CODE.FAKE_NOT_ALLOWED);
    const open = fakeHost(true);

    open.resolver.resolve({ connectionId: 'fake-test' });

    return `${refused.code}; allowed=${!refused && 'yes'}`;
  });

  await step('repeated resolve returns one adapter; a fresh host rebuilds', async () => {
    const host = fakeHost();
    const first = host.resolver.resolve({ connectionId: 'fake-test' });
    const second = host.resolver.resolve({ connectionId: 'fake-test' });

    assert.equal(first, second);
    const other = fakeHost();

    assert.notEqual(first, other.resolver.resolve({ connectionId: 'fake-test' }));
    await host.resolver.dispose();
    await other.resolver.dispose();

    return 'stable within host, isolated across hosts';
  });

  await step('domain services do not import concrete runtimes or the registry', () => {
    const guarded = [
      'scheduler.js',
      'architect.js',
      'review.js',
      'control-service.js',
      'runner-execution.js',
      'session-surface.js',
      'daemon.js',
    ];
    const forbidden = /(?:from|import\()\s*['"][^'"]*plugins\/(registry|resolver|codex|opencode)/;
    const violations = [];

    for (const file of guarded) {
      const content = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

      if (forbidden.test(content)) violations.push(file);
    }

    assert.deepEqual(violations, []);

    return `${guarded.length} files clean`;
  });

  await step('project config cannot smuggle secrets or host-level binary fields', () => {
    const dir = join(workspace, `project-config-${Math.random().toString(36).slice(2)}`);

    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '.clew.json'),
      JSON.stringify({ agents: { worker: { connection: 'x', token: 'secret' } } }),
    );
    const secret = expectThrows(
      () => loadConfig(dir, { CLEW_USER_CONFIG: join(dir, 'missing.json') }),
      /must not contain secret field/,
    );

    writeFileSync(
      join(dir, '.clew.json'),
      JSON.stringify({
        connections: [{ id: 'sneaky', plugin: 'clew.runtime.codex', bin: '/tmp/evil' }],
      }),
    );
    const hostField = expectThrows(
      () => loadConfig(dir, { CLEW_USER_CONFIG: join(dir, 'missing.json') }),
      /must not define host-level field/,
    );

    return `${secret.message.slice(0, 34)}… / ${hostField.message.slice(0, 40)}…`;
  });
});

// ===========================================================================
// 128 — Codex runtime

await section('128', 'Codex runtime behind AgentRuntime', async () => {
  await step('adapter and direct harness agree on the happy path', async () => {
    const project = makeGitProject();
    const direct = new CodexHarness({
      command: 'codex',
      spawnImpl: scriptedCodex().spawnImpl,
      timeoutMs: 5_000,
    });
    const directEvents = [];
    const directResult = await direct.run({
      task: TASK,
      cwd: project,
      onEvent: (event) => directEvents.push(event.type),
    });
    const host = codexHost({ spawnImpl: scriptedCodex().spawnImpl });
    const adapter = host.resolver.resolve({ connectionId: 'codex-default' });
    const adapterEvents = [];
    const result = await adapter.run(
      { runId: 'stand-codex', brief: { task: TASK }, workspace: { cwd: project } },
      { onEvent: (event) => adapterEvents.push(event.type), requestApproval: () => 'accept' },
    );

    assert.equal(result.status, 'completed');
    assert.deepEqual(result.output.output, directResult.output);
    assert.deepEqual(adapterEvents, directEvents);
    assert.equal(result.session.nativeSessionId, directResult.sessionId);
    assert.equal(result.usage.status, 'reported');
    assert.equal(result.usage.inputTokens, 11);
    await host.resolver.dispose();

    return `${adapterEvents.join(' → ')}; usage=${result.usage.inputTokens}/${result.usage.outputTokens}`;
  });

  await step('approval, abort, and resume are preserved', async () => {
    const project = makeGitProject();
    const approvals = [];
    const approvalHost = codexHost({
      spawnImpl: codexServer((message, send) => {
        if (message.method === 'initialize') send({ id: message.id, result: {} });
        else if (message.method === 'thread/start')
          send({ id: message.id, result: { thread: { id: 'thr_a' } } });
        else if (message.method === 'thread/name/set') send({ id: message.id, result: {} });
        else if (message.method === 'turn/start') {
          send({ id: message.id, result: { turn: { id: 'turn_a' } } });
          send({ id: 77, method: 'test/requestApproval', params: { prompt: 'allow?' } });
        } else if (message.id === 77 && message.result?.decision) {
          approvals.push(message.result.decision);
          send({
            method: 'turn/completed',
            params: { turn: { status: 'completed', id: 'turn_a', output: { output: 'ok' } } },
          });
        }
      }).spawnImpl,
    });
    const approved = await approvalHost.resolver
      .resolve({ connectionId: 'codex-default' })
      .run(
        { runId: 'stand-approval', brief: { task: TASK }, workspace: { cwd: project } },
        { onEvent: () => {}, requestApproval: () => 'accept' },
      );

    assert.equal(approved.status, 'completed');
    assert.deepEqual(approvals, ['accept']);

    const abortHost = codexHost({
      spawnImpl: codexServer((message, send) => {
        if (message.method === 'initialize') send({ id: message.id, result: {} });
        else if (message.method === 'thread/start')
          send({ id: message.id, result: { thread: { id: 'thr_b' } } });
        else if (message.method === 'thread/name/set') send({ id: message.id, result: {} });
        else if (message.method === 'turn/start')
          send({ id: message.id, result: { turn: { id: 'turn_b' } } });
      }).spawnImpl,
    });
    const adapter = abortHost.resolver.resolve({ connectionId: 'codex-default' });

    adapter.asLegacyHarness().interruptTimeoutMs = 50;
    const controller = new AbortController();
    const pending = adapter.run(
      { runId: 'stand-abort', brief: { task: TASK }, workspace: { cwd: project } },
      {
        onEvent: (event) => {
          if (event.type === 'TURN_STARTED') controller.abort();
        },
        signal: controller.signal,
      },
    );
    const interrupted = await pending;

    assert.equal(interrupted.status, 'interrupted');

    const resumeServer = scriptedCodex({
      'thread/start': (message, send) =>
        send({ id: message.id, result: { thread: { id: 'thr_x' } } }),
      'thread/resume': (message, send) =>
        send({ id: message.id, result: { thread: { id: 'thr_resumed' } } }),
    });
    const resumeHost = codexHost({ spawnImpl: resumeServer.spawnImpl });
    const resumed = await resumeHost.resolver.resolve({ connectionId: 'codex-default' }).run(
      {
        runId: 'stand-resume',
        brief: { task: TASK },
        workspace: { cwd: project },
        resumeSessionRef: { runtime: 'codex', nativeSessionId: 'thr_old' },
      },
      { onEvent: () => {} },
    );

    assert.equal(resumed.session.nativeSessionId, 'thr_resumed');
    assert.ok(resumeServer.requests.some((message) => message.method === 'thread/resume'));
    await approvalHost.resolver.dispose();
    await abortHost.resolver.dispose();
    await resumeHost.resolver.dispose();

    return `approval=${approvals[0]}, abort=${interrupted.status}, resume=${resumed.session.nativeSessionId}`;
  });

  await step('legacy codexBin maps to a connection with a migration diagnostic', () => {
    const { connection, diagnostics } = buildLegacyCodexConnection({ codexBin: '/opt/codex' });

    assert.equal(connection.id, 'codex-default');
    assert.equal(connection.config.bin, '/opt/codex');
    assert.equal(diagnostics[0].source, 'codexBin');
    assert.doesNotMatch(JSON.stringify(diagnostics), /\/opt\/codex/);
    const conflict = expectThrows(
      () => assertHarnessConnectionExclusive({ harness: 'codex', connection: 'codex-default' }),
      /either --harness or --connection/,
    );

    return `bin→connection (path not leaked); conflict=${conflict.code}`;
  });
});

// ===========================================================================
// 129 — OpenCode runtime

await section('129', 'OpenCode runtime behind AgentRuntime', async () => {
  await step('message flow and resume work through the adapter', async () => {
    const project = makeGitProject();
    const server = openCodeServer();
    const host = openCodeHost(server);
    const adapter = host.resolver.resolve({ connectionId: 'opencode-default' });
    const events = [];
    const result = await adapter.run(
      { runId: 'stand-oc', brief: { task: TASK }, workspace: { cwd: project } },
      { onEvent: (event) => events.push(event.type) },
    );

    assert.equal(result.status, 'completed');
    assert.equal(result.session.nativeSessionId, 'sess_stand');
    const resumeServer = openCodeServer();
    const resumeHost = openCodeHost(resumeServer);
    const resumed = await resumeHost.resolver.resolve({ connectionId: 'opencode-default' }).run(
      {
        runId: 'stand-oc-resume',
        brief: { task: TASK },
        workspace: { cwd: project },
        resumeSessionRef: { runtime: 'opencode', nativeSessionId: 'sess_old' },
      },
      { onEvent: () => {} },
    );

    assert.equal(resumed.session.nativeSessionId, 'sess_old');
    assert.ok(!resumeServer.calls.some((call) => call.href.includes('/session?')));
    await host.resolver.dispose();
    await resumeHost.resolver.dispose();

    return `${events.join(' → ')}; resume skipped session creation`;
  });

  await step('SSE stream with approval reaches the permission endpoint', async () => {
    const project = makeGitProject();
    const frames = [
      {
        type: 'message.part.updated',
        properties: { sessionID: 'sess_s', part: { type: 'text', text: 'hi ' } },
      },
      {
        type: 'message.part.updated',
        properties: { sessionID: 'sess_s', part: { type: 'text', text: 'there' } },
      },
      { type: 'session.permission.requested', properties: { sessionID: 'sess_s', id: 'perm_1' } },
      {
        type: 'session.status',
        properties: {
          sessionID: 'sess_s',
          status: { type: 'idle' },
          usage: { inputTokens: 5, outputTokens: 6 },
        },
      },
    ];
    const server = openCodeServer({ eventMode: 'sse', frames });
    const host = openCodeHost(server);
    const result = await host.resolver
      .resolve({ connectionId: 'opencode-default' })
      .run(
        { runId: 'stand-sse', brief: { task: TASK }, workspace: { cwd: project } },
        { onEvent: () => {}, requestApproval: () => 'accept' },
      );

    assert.equal(result.status, 'completed');
    assert.equal(result.output.output, 'hi there');
    assert.ok(server.calls.some((call) => call.href.includes('/permissions/perm_1')));
    await host.resolver.dispose();

    return `output="${result.output.output}"; approval posted`;
  });

  await step('structured output is refused before any endpoint call', async () => {
    const server = openCodeServer();
    const host = openCodeHost(server);

    await expectRejects(
      host.resolver.resolve({ connectionId: 'opencode-default' }).run(
        {
          runId: 'stand-schema',
          brief: { task: TASK },
          workspace: { cwd: process.cwd() },
          outputSchema: { type: 'object' },
        },
        { onEvent: () => {} },
      ),
      /no verified schema-output mode/,
    );
    assert.equal(server.calls.length, 0);
    await host.resolver.dispose();

    return 'UNSUPPORTED_CAPABILITY, 0 HTTP calls';
  });

  await step('truncated SSE fails as a protocol error, never a fake answer', async () => {
    const project = makeGitProject();
    const rawChunks = ['event: message.part.updated\ndata: {"type": "broken"\n\n'];
    const base = openCodeServer();
    const host = createPluginHost({
      plugins: [],
      connections: [
        {
          id: 'opencode-default',
          plugin: 'clew.runtime.opencode',
          enabled: true,
          config: { baseUrl: 'http://oc' },
        },
      ],
      allowFake: false,
    });

    registerOpenCodePlugin(host.registry, {
      fetchImpl: async (url, options = {}) => {
        if (String(url).includes('/event'))
          return { ok: true, status: 200, body: rawBody(rawChunks) };

        return base.fetchImpl(url, options);
      },
    });
    const result = await host.resolver
      .resolve({ connectionId: 'opencode-default' })
      .run(
        { runId: 'stand-raw', brief: { task: TASK }, workspace: { cwd: project } },
        { onEvent: () => {} },
      );

    assert.equal(result.status, 'failed');
    assert.equal(result.error.class, 'protocol');
    await host.resolver.dispose();

    return `${result.status}/${result.error.class}`;
  });

  await step('malformed model is omitted, foreign resume is refused', async () => {
    const project = makeGitProject();
    const bodies = [];
    const base = openCodeServer();
    const host = createPluginHost({
      plugins: [],
      connections: [
        {
          id: 'opencode-default',
          plugin: 'clew.runtime.opencode',
          enabled: true,
          config: { baseUrl: 'http://oc' },
        },
      ],
      allowFake: false,
    });

    registerOpenCodePlugin(host.registry, {
      fetchImpl: async (url, options = {}) => {
        if (String(url).includes('/message') && (options.method ?? 'GET') === 'POST')
          bodies.push(JSON.parse(options.body));

        return base.fetchImpl(url, options);
      },
    });
    const adapter = host.resolver.resolve({ connectionId: 'opencode-default' });

    await adapter.run(
      {
        runId: 'stand-model',
        brief: { task: TASK },
        workspace: { cwd: project },
        model: 'not-a-model-id',
      },
      { onEvent: () => {} },
    );
    assert.equal('model' in bodies.at(-1), false);
    const foreign = await expectRejects(
      adapter.run(
        {
          runId: 'stand-foreign',
          brief: { task: TASK },
          workspace: { cwd: project },
          resumeSessionRef: { runtime: 'codex', nativeSessionId: 'thr' },
        },
        { onEvent: () => {} },
      ),
      /never move between runtimes/,
    );

    await host.resolver.dispose();

    return `model omitted; foreign=${foreign.code}`;
  });
});

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

// ===========================================================================
// 130 — role routing, doctor, safe projection

await section('130', 'Role routing, doctor, safe projection', async () => {
  await step('precedence resolves flag → env → project → user → default', () => {
    const sources = {
      flag: { connection: 'flag-conn', model: 'flag-model' },
      env: { connection: 'env-conn', model: 'env-model' },
      project: { connection: 'project-conn', model: 'project-model' },
      user: { connection: 'user-conn', model: 'user-model' },
    };
    const highest = resolveRoleRoute('worker', sources, { allowedConnections: null });
    const lower = resolveRoleRoute(
      'worker',
      { ...sources, flag: {}, env: {} },
      { allowedConnections: null },
    );
    const fallback = resolveRoleRoute('worker', {}, { allowedConnections: null });

    assert.equal(highest.connection, 'flag-conn');
    assert.equal(lower.connection, 'project-conn');
    assert.equal(fallback.connection, 'codex-default');
    assert.equal(fallback.model, null);

    return `${highest.source} → ${lower.source} → ${fallback.source}`;
  });

  await step('legacy reviewer default applies to codex only; foreign roles are refused', () => {
    assert.equal(legacyDefaultModel('reviewer', 'clew.runtime.codex'), LEGACY_REVIEWER_MODEL);
    assert.equal(legacyDefaultModel('reviewer', 'clew.runtime.opencode'), null);
    const host = buildRuntimeHost({ codexBin: 'codex', openCodeUrl: 'http://oc' });
    const refused = expectThrows(
      () =>
        resolveCodexReviewer({
          resolver: host.resolver,
          adapterConfig: {},
          connectionId: 'opencode-default',
        }),
      /requires the codex runtime/,
    );

    assert.equal(refused.code, PLUGIN_ERROR_CODE.UNSUPPORTED_CAPABILITY);
    const codexRoute = resolveCodexReviewer({ resolver: host.resolver, adapterConfig: {} });

    assert.ok(codexRoute);

    return `reviewer default=${LEGACY_REVIEWER_MODEL} (codex only); foreign=${refused.code}`;
  });

  await step('doctor explains unavailable connections without leaking paths', async () => {
    const { directory, store } = makeStore('doctor');
    const service = new ClewService({
      cwd: directory,
      store,
      config: {
        ...DEFAULT_CONFIG,
        codexBin: 'clew-command-that-does-not-exist',
        openCodeUrl: 'not-a-url',
      },
    });
    const report = await service.execute(['doctor']);
    const codex = report.checks.find((check) => check.name === 'connection:codex-default');

    assert.equal(codex.status, 'unavailable');
    assert.equal(codex.reason, 'binary-unavailable');
    assert.ok(Array.isArray(report.diagnostics));
    assert.doesNotMatch(JSON.stringify(report), /\/(bin|tmp|Users|home|opt|usr)\//);
    assert.doesNotMatch(JSON.stringify(report), /token|secret|credential/i);
    store.close();

    return `checks=${report.checks.length}, codex=${codex.status}/${codex.reason}`;
  });

  await step('connections list exposes only id/plugin/enabled/capabilities', async () => {
    const { directory, store } = makeStore('connections');
    const service = new ClewService({
      cwd: directory,
      store,
      config: { ...DEFAULT_CONFIG, codexBin: 'codex', openCodeUrl: 'http://127.0.0.1:4096' },
    });
    const result = await service.execute(['connections', 'list']);
    const serialized = JSON.stringify(result);
    const keys = [...new Set(result.connections.flatMap((entry) => Object.keys(entry)))].sort();

    assert.deepEqual(keys, ['capabilities', 'enabled', 'id', 'plugin']);
    assert.doesNotMatch(serialized, /https?:\/\//);
    assert.doesNotMatch(serialized, /token|secret|credential/i);
    store.close();

    return `${result.connections.map((entry) => entry.id).join(', ')}`;
  });

  await step('--harness and --connection together are an explicit error', async () => {
    const { directory, store } = makeStore('conflict');
    const service = new ClewService({ cwd: directory, store, config: { ...DEFAULT_CONFIG } });

    await expectRejects(
      service.execute(['run', 'missing', '--harness', 'codex', '--connection', 'x']),
      /either --harness or --connection/,
    );
    store.close();

    return 'PLUGIN_INVALID_CONFIG';
  });
});

// ===========================================================================
// 131 — bindings, migration, Runner compatibility

await section('131', 'Immutable run bindings, migration, Runner compatibility', async () => {
  await step('binding fingerprint is deterministic and ids are pinned', async () => {
    const host = codexHost();

    assert.equal(
      fingerprintConnectionConfig({ b: 2, a: 1 }),
      fingerprintConnectionConfig({ a: 1, b: 2 }),
    );
    const adapter = host.resolver.resolve({ connectionId: 'codex-default' });
    const binding = buildRunBinding({
      runId: 'stand-binding',
      taskId: TASK.id,
      stageId: 'worker',
      attempt: 1,
      connectionId: 'codex-default',
      adapter,
      registry: host.registry,
      model: 'worker-model',
      executionHost: 'local',
    });

    assert.equal(binding.pluginId, 'clew.runtime.codex');
    assert.equal(binding.connectionId, 'codex-default');
    assert.equal(binding.model, 'worker-model');
    assert.match(binding.configFingerprint, /^[0-9a-f]{64}$/);
    assert.deepEqual(
      checkBindingCompatible(binding, { registry: host.registry, resolver: host.resolver }),
      {
        compatible: true,
        binding,
      },
    );
    const drift = checkBindingCompatible(
      { ...binding, pluginVersion: '0.0.0' },
      { registry: host.registry, resolver: host.resolver },
    );

    assert.equal(drift.compatible, false);
    await host.resolver.dispose();

    return `fingerprint=${binding.configFingerprint.slice(0, 12)}…; drift=recovery`;
  });

  await step('local parallel stage run is pinned to a binding', async () => {
    const project = makeGitProject();
    const { directory, store } = makeStore('stage-binding');

    store.createTask({ ...TASK, id: 'STAGE-1' });

    const host = codexHost();
    const scheduler = new Scheduler(store, new GitWorktreeManager(join(directory, 'wt'), project), {
      runtimeResolver: host.resolver,
      adapterConfig: {},
    });

    await scheduler.executeStage({
      task: store.getTask('STAGE-1').contract,
      stage: { id: 'worker', kind: 'worker', goal: 'Implement' },
      harness: {
        run: async () => ({
          sessionId: 'sess-stage',
          verification: [{ type: 'command', command: 'npm test', result: 'passed' }],
          usage: null,
        }),
      },
      harnessName: 'codex',
      attempt: 1,
      policy: { name: 'quick', verification: 'targeted' },
    });
    const run = store.listRuns('STAGE-1')[0];
    const record = store.getRunBinding(run.id);

    assert.equal(record.status, 'bound');
    assert.equal(record.binding.connectionId, 'codex-default');
    store.close();

    return `run ${run.id} → bound (${record.binding.pluginId})`;
  });

  await step('old runs read as legacy-unknown, corrupt rows fail loudly', () => {
    const { store } = makeStore('legacy-binding');

    store.createTask({ ...TASK, id: 'OLD-1' });
    store.createRun({
      id: 'old-run',
      taskId: 'OLD-1',
      stageId: 'worker',
      attempt: 1,
      status: 'COMPLETED',
      harness: 'codex',
    });
    assert.equal(store.getRunBinding('old-run').status, 'legacy-unknown');
    store.createTask({ ...TASK, id: 'BAD-1' });
    store.createRun({
      id: 'bad-run',
      taskId: 'BAD-1',
      stageId: 'worker',
      attempt: 1,
      status: 'RUNNING',
      harness: 'codex',
    });
    store.db
      .prepare('INSERT INTO run_bindings (run_id,task_id,binding,created_at) VALUES (?,?,?,?)')
      .run('bad-run', 'BAD-1', 'not-json{{', new Date().toISOString());
    expectThrows(() => store.getRunBinding('bad-run'), /corrupt/);
    store.close();

    return 'legacy-unknown intact; corrupt row throws';
  });

  await step('Runner inventory is secret-free and v1 runners refuse plugin leases', async () => {
    const inventory = collectRunnerInventory({ codexBin: 'codex', openCodeUrl: 'http://oc:4096' });
    const serialized = JSON.stringify(inventory);

    assert.equal(inventory.length, 2);
    assert.doesNotMatch(serialized, /http:\/\/oc:4096/);
    assert.doesNotMatch(serialized, /token|secret|credential/i);
    const legacyPort = new RunnerExecutionPort({
      workspaces: [{ id: 'ws', path: '/tmp/clew-stand-ws' }],
      harnessFactory: () => ({ run: async () => ({ verification: [] }) }),
    });

    await expectRejects(
      legacyPort.accept(
        {
          leaseId: 'l',
          epoch: 1,
          workspaceId: 'ws',
          stageId: 'worker',
          runId: 'r',
          harness: 'codex',
          binding: { version: 1, pluginId: 'clew.runtime.codex' },
          requirements: { task: { id: 't', title: 't', goal: 'g', acceptance: [] } },
        },
        {},
      ),
      /does not support plugin-bound leases/,
    );

    return `inventory=${inventory.map((entry) => entry.plugin).join(',')}; v1 refuses`;
  });
});

// ===========================================================================
// 132 — telemetry sink

await section('132', 'OTel traces as a TelemetrySink', async () => {
  await step('disabled telemetry is a no-op without packages', async () => {
    const observability = new Observability({ config: { enabled: false } });

    observability.onEvent({ task_id: 'T', type: 'TASK_CREATED', payload: {} });
    assert.deepEqual(observability.status(), {
      state: 'disabled',
      installed: false,
      endpoint: null,
      dropped: 0,
      exportErrors: 0,
      error: null,
    });
    await observability.shutdown();

    return 'state=disabled, no packages touched';
  });

  await step('lifecycle flows through the test sink and persists correlation', async () => {
    const { store } = makeStore('telemetry');

    store.createTask({ ...TASK, id: 'TEL-1' });
    store.createRun({
      id: 'run-1',
      taskId: 'TEL-1',
      stageId: 'worker',
      attempt: 1,
      status: 'RUNNING',
      harness: 'codex',
    });
    const registry = new PluginRegistry();

    registerTelemetryPlugins(registry, {});
    const resolver = new ConnectionResolver({
      registry,
      connections: [{ id: 'test-main', plugin: TEST_SINK_PLUGIN_ID, enabled: true, config: {} }],
      allowFake: false,
    });
    const observability = new Observability({
      config: { enabled: true },
      store,
      plugins: { host: { resolver }, connectionId: 'test-main' },
    });

    observability.onEvent({
      task_id: 'TEL-1',
      type: 'STAGE_RUN_STARTED',
      payload: { stageId: 'worker', runId: 'run-1' },
    });
    observability.onEvent({
      task_id: 'TEL-1',
      type: 'HARNESS_EVENT',
      payload: { stageId: 'worker', runId: 'run-1', token: 'secret-token', prompt: 'hidden' },
    });
    observability.onEvent({ task_id: 'TEL-1', type: 'TASK_COMPLETED', payload: {} });
    const sink = resolver.resolve({ connectionId: 'test-main' });
    const taskContext = store.getTelemetryTask('TEL-1');
    const serialized = JSON.stringify(sink.received);

    assert.ok(taskContext);
    assert.ok(store.getTelemetryRun('run-1'));
    assert.doesNotMatch(serialized, /secret-token|hidden/);
    assert.ok(sink.received.length >= 3);
    await observability.shutdown();
    assert.equal(sink.disposed, true);
    store.close();

    return `records=${sink.received.length}; redacted; task+run correlation persisted`;
  });

  await step('failing sink drops visibly and never touches history', async () => {
    const { store } = makeStore('telemetry-fail');

    store.createTask({ ...TASK, id: 'TEL-2' });
    store.createRun({
      id: 'run-2',
      taskId: 'TEL-2',
      stageId: 'worker',
      attempt: 1,
      status: 'RUNNING',
      harness: 'codex',
    });
    const registry = new PluginRegistry();

    registerTelemetryPlugins(registry, {});
    const resolver = new ConnectionResolver({
      registry,
      connections: [{ id: 'test-main', plugin: TEST_SINK_PLUGIN_ID, enabled: true, config: {} }],
      allowFake: false,
    });
    const observability = new Observability({
      config: { enabled: true },
      store,
      plugins: { host: { resolver }, connectionId: 'test-main' },
    });
    const sink = resolver.resolve({ connectionId: 'test-main' });

    // Healthy at construction, then the exporter starts failing mid-flow.
    sink.failEmit = true;
    observability.onEvent({
      task_id: 'TEL-2',
      type: 'STAGE_RUN_STARTED',
      payload: { stageId: 'worker', runId: 'run-2' },
    });

    assert.ok(sink.status().dropped > 0);
    assert.ok(sink.status().exportErrors > 0);
    assert.ok(store.getTelemetryTask('TEL-2'));
    assert.ok(store.getTelemetryRun('run-2'));
    await observability.shutdown();
    store.close();

    return `dropped=${sink.status().dropped}, exportErrors=${sink.status().exportErrors}; history intact`;
  });

  await step('replayed span-starts never double-count', async () => {
    const registry = new PluginRegistry();

    registerTelemetryPlugins(registry, {});
    const sink = createTestTelemetrySink({ id: 'test-main' });
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
    assert.equal(sink.received.length, 1);
    assert.equal(sink.status().dropped, 1);

    return 'duplicate ignored, dropped=1';
  });
});

// ===========================================================================
// 133 — release conformance

await section('133', 'Release conformance and docs', async () => {
  await step('fourth runtime plugs in through generic paths only', async () => {
    const PLUGIN_ID = 'clew.runtime.stand-stub';
    const manifest = {
      id: PLUGIN_ID,
      version: '1.0.0',
      apiVersion: '1',
      extensionPoints: [{ point: 'AgentRuntime', version: '1' }],
      configSchema: { type: 'object', properties: {} },
      scope: 'execution-host',
      resources: { binaries: [], network: [], notes: 'stand stub' },
    };
    const host = createPluginHost({
      plugins: [
        {
          manifest,
          factory: () => ({
            describe: () => ({
              plugin: PLUGIN_ID,
              apiVersion: '1',
              capabilities: ['execution.headless'],
            }),
            probe: async () => ({ status: 'ready', connection: 'stub-1' }),
            run: async ({ runId }) => ({
              status: 'completed',
              session: { runtime: 'stub', connection: 'stub-1', nativeSessionId: `stub-${runId}` },
              output: {},
              evidence: [],
              usage: { status: 'unknown' },
            }),
            dispose: async () => {},
          }),
        },
      ],
      connections: [{ id: 'stub-1', plugin: PLUGIN_ID, enabled: true, config: {} }],
      allowFake: false,
    });
    const result = await host.resolver.resolve({ connectionId: 'stub-1' }).run({ runId: 'r1' }, {});

    assert.equal(result.session.nativeSessionId, 'stub-r1');
    for (const file of [
      'scheduler.js',
      'architect.js',
      'review.js',
      'control-service.js',
      'runner-execution.js',
      'session-surface.js',
      'daemon.js',
    ]) {
      const content = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

      assert.doesNotMatch(content, /clew\.runtime\.stand-stub/);
    }
    await host.resolver.dispose();

    return 'registered + executed; no domain branch';
  });

  await step('grep gate: no direct runtime imports, no core model names', () => {
    const files = [
      'scheduler.js',
      'architect.js',
      'review.js',
      'control-service.js',
      'runner-execution.js',
      'session-surface.js',
      'daemon.js',
    ];
    const forbidden =
      /(?:from|import\()\s*['"][^'"]*plugins\/(registry|resolver|codex|opencode)|import\s*\{[^}]*\b(CodexHarness|CodexArchitect|CodexReviewer|codexLaunchError)\b/;

    for (const file of files) {
      const content = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

      assert.doesNotMatch(content, forbidden, `${file} imports runtime internals`);
    }

    for (const file of ['config.js', 'scheduler.js', 'control-service.js']) {
      const content = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

      assert.doesNotMatch(content, /gpt-5\.6-luna/, `${file} names a runtime model`);
    }

    return `${files.length} files clean; no core model names`;
  });

  await step('runbook documents migration, deferred scope, and compatibility', () => {
    const doc = readFileSync(new URL('../docs/PLUGIN-DI.md', import.meta.url), 'utf8');
    const stand = readFileSync(new URL('../docs/PLUGIN-STAND.md', import.meta.url), 'utf8');

    for (const needle of ['Migration from legacy flags', 'Deferred', 'Compatibility']) {
      assert.ok(doc.includes(needle), `PLUGIN-DI.md missing "${needle}"`);
    }
    assert.ok(stand.includes('plugins-stand.js'));

    return 'PLUGIN-DI.md + PLUGIN-STAND.md present';
  });
});

// ===========================================================================
// Summary

const passed = results.filter((entry) => entry.status === 'PASS').length;
const failed = results.filter((entry) => entry.status === 'FAIL');

if (json) {
  console.log(JSON.stringify({ results, passed, failed: failed.length, workspace }, null, 2));
} else {
  heading('SUMMARY');
  const bySection = new Map();

  for (const entry of results) {
    const list = bySection.get(entry.section) ?? [];

    list.push(entry);
    bySection.set(entry.section, list);
  }

  for (const [sectionId, entries] of bySection) {
    const ok = entries.filter((entry) => entry.status === 'PASS').length;

    console.log(`  ${sectionId}: ${ok}/${entries.length} passed`);
  }
  console.log(`\n  TOTAL: ${passed}/${results.length} passed, ${failed.length} failed`);
  if (failed.length)
    for (const entry of failed) console.log(`    ✘ ${entry.section} ${entry.name}: ${entry.error}`);
  console.log(`\n  workspace: ${keep ? workspace : '(removed at exit)'}`);
}

if (!keep) rmSync(workspace, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
