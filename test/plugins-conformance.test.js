import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { CodexHarness } from '../src/plugins/codex/harness.js';
import { CodexArchitect, CodexReviewer } from '../src/plugins/codex/role-services.js';
import { OpenCodeHarness } from '../src/plugins/opencode/harness.js';
import { ConnectionResolver } from '../src/plugins/resolver.js';
import { createPluginHost } from '../src/plugins/index.js';
import {
  buildLegacyCodexConnection,
  buildLegacyOpenCodeConnection,
  assertHarnessConnectionExclusive,
} from '../src/plugins/legacy.js';
import { ROLE_FLAGS, collectRoleSources } from '../src/plugins/role-routing.js';
import { registerOpenCodePlugin } from '../src/plugins/opencode/index.js';
import { ClewService } from '../src/control-service.js';
import { Store } from '../src/store.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { HARNESS_NAME } from '../src/domain.js';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');

function suiteHas(suiteFile, testName) {
  const content = readFileSync(join(here, suiteFile), 'utf8');

  return content.includes(`'${testName}'`);
}

// Part A (AC-1): the release matrix. Every row names the suite and test
// that proves it; the mapping itself is asserted below, so rows cannot
// silently lose their evidence.
const MATRIX = [
  {
    id: 'worker/headless',
    suite: 'plugins-codex.test.js',
    test: 'plugins-codex group 1: adapter and direct harness agree on the happy path',
  },
  {
    id: 'worker/failure-paths',
    suite: 'plugins-codex.test.js',
    test: 'plugins-codex group 1: adapter and direct harness agree on failures',
  },
  {
    id: 'worker/approval',
    suite: 'plugins-codex.test.js',
    test: 'plugins-codex group 3: approval decisions reach the native turn',
  },
  {
    id: 'worker/abort',
    suite: 'plugins-codex.test.js',
    test: 'plugins-codex group 3: abort maps to an interrupted result without a duplicate run',
  },
  {
    id: 'worker/resume',
    suite: 'plugins-codex.test.js',
    test: 'plugins-codex group 3: resume continues the native session',
  },
  {
    id: 'worker/single-writer',
    suite: 'plugins-codex.test.js',
    test: 'plugins-codex group 3: one adapter owns one writer',
  },
  {
    id: 'worker/missing-binary',
    suite: 'plugins-codex.test.js',
    test: 'plugins-codex group 3: probe reports unavailable binaries without throwing',
  },
  {
    id: 'worker/duplicate-completion',
    suite: 'plugins-conformance.test.js',
    test: 'conformance: duplicate native completion settles once',
  },
  {
    id: 'architect/structured',
    suite: 'architect.test.js',
    test: 'Codex architect requests a read-only structured plan',
  },
  {
    id: 'architect/invalid-plan',
    suite: 'plugins-conformance.test.js',
    test: 'conformance: invalid structured plan is an explicit error',
  },
  {
    id: 'reviewer/needs-human',
    suite: 'plugins-conformance.test.js',
    test: 'conformance: invalid review report degrades to needs-human',
  },
  {
    id: 'opencode/message-flow',
    suite: 'plugins-opencode.test.js',
    test: 'plugins-opencode group 1: message worker flow through the adapter',
  },
  {
    id: 'opencode/sse-approval',
    suite: 'plugins-opencode.test.js',
    test: 'plugins-opencode group 1: streaming worker flow with approval through fixtures',
  },
  {
    id: 'opencode/resume',
    suite: 'plugins-opencode.test.js',
    test: 'plugins-opencode group 1: resume skips session creation',
  },
  {
    id: 'opencode/structured-refusal',
    suite: 'plugins-opencode.test.js',
    test: 'plugins-opencode group 1: structured output is refused before execution',
  },
  {
    id: 'opencode/malformed-model',
    suite: 'plugins-conformance.test.js',
    test: 'conformance: malformed model is omitted, never substituted',
  },
  {
    id: 'opencode/harness-identity',
    suite: 'plugins-conformance.test.js',
    test: 'conformance: opencode adapter owns one harness',
  },
  {
    id: 'opencode/truncated',
    suite: 'plugins-opencode.test.js',
    test: 'plugins-opencode group 4: truncated JSON fails as protocol error',
  },
  {
    id: 'opencode/timeout',
    suite: 'plugins-opencode.test.js',
    test: 'plugins-opencode group 4: timeout maps to a timeout failure',
  },
  {
    id: 'opencode/duplicates',
    suite: 'plugins-opencode.test.js',
    test: 'plugins-opencode group 4: duplicate events complete without double usage',
  },
  {
    id: 'opencode/abort',
    suite: 'plugins-opencode.test.js',
    test: 'plugins-opencode group 4: abort maps to an interrupted result',
  },
  {
    id: 'registry/unknown-id',
    suite: 'plugins-contracts.test.js',
    test: 'plugins-contracts group 1: unknown connection id fails before execution',
  },
  {
    id: 'registry/duplicate-id',
    suite: 'plugins-contracts.test.js',
    test: 'plugins-contracts group 1: duplicate plugin id is an error regardless of load order',
  },
  {
    id: 'registry/incompatible-api',
    suite: 'plugins-contracts.test.js',
    test: 'plugins-contracts group 1: incompatible Plugin API is rejected at registration',
  },
  {
    id: 'registry/unsupported-capability',
    suite: 'plugins-contracts.test.js',
    test: 'plugins-contracts group 1: unsupported capability is refused before execution',
  },
  {
    id: 'registry/disabled',
    suite: 'plugins-contracts.test.js',
    test: 'plugins-contracts group 1: disabled connection is refused with its reason',
  },
  {
    id: 'registry/fake-route',
    suite: 'plugins-contracts.test.js',
    test: 'plugins-contracts group 2: explicit fake route runs deterministically',
  },
  {
    id: 'routing/precedence',
    suite: 'plugins-routing.test.js',
    test: 'plugins-routing group 1: flag beats env beats project beats user beats defaults',
  },
  {
    id: 'routing/malformed-model',
    suite: 'plugins-routing.test.js',
    test: 'plugins-routing group 1: unknown connections and malformed models are refused',
  },
  {
    id: 'routing/foreign-role',
    suite: 'plugins-routing.test.js',
    test: 'plugins-routing group 1: reviewer/architect on a non-codex connection are refused before execution',
  },
  {
    id: 'routing/conflict',
    suite: 'plugins-routing.test.js',
    test: 'plugins-routing group 2: conflicting selectors are an explicit error',
  },
  {
    id: 'routing/doctor',
    suite: 'plugins-routing.test.js',
    test: 'plugins-routing group 3: doctor reports unavailable binaries with reason codes',
  },
  {
    id: 'routing/projection',
    suite: 'plugins-routing.test.js',
    test: 'plugins-routing group 4: connections list exposes only the safe projection',
  },
  {
    id: 'paired/equivalence',
    suite: 'plugins-paired.test.js',
    test: 'plugins-paired group 1: local and paired snapshots agree modulo execution host',
  },
  {
    id: 'paired/idempotency',
    suite: 'plugins-paired.test.js',
    test: 'plugins-paired group 2: duplicate inbound lease offers stay deduplicated',
  },
  {
    id: 'paired/restart-drift',
    suite: 'plugins-paired.test.js',
    test: 'plugins-paired group 2: restart checks pass, then fail loudly on drift',
  },
  {
    id: 'paired/legacy-migration',
    suite: 'plugins-paired.test.js',
    test: 'plugins-paired group 3: v23 databases upgrade and old runs stay explainable',
  },
  {
    id: 'paired/v1-refusal',
    suite: 'plugins-paired.test.js',
    test: 'plugins-paired group 4: controller refuses plugin-bound leases for v1 runners',
  },
  {
    id: 'paired/stale-epoch',
    suite: 'runner-lease-store.test.js',
    test: 'deduplicates inbound transitions and rejects conflicting or stale fencing identities',
  },
  {
    id: 'lifecycle/restart',
    suite: 'continuation.test.js',
    test: 'restart after worker completion resumes the same continuation Run and only reviews once',
  },
  {
    id: 'lifecycle/reclaim',
    suite: 'continuation.test.js',
    test: 'restart after Run allocation reuses the claimed continuation Run',
  },
  {
    id: 'conformance/codex-lifecycle',
    suite: 'harness-conformance.test.js',
    test: 'Codex harness conforms and persists native thread and turn identity',
  },
  {
    id: 'conformance/fake-lifecycle',
    suite: 'harness-conformance.test.js',
    test: 'Fake harness conforms to the normalized successful lifecycle',
  },
];

test('conformance: every matrix row maps to an existing test', () => {
  const missing = MATRIX.filter((row) => !suiteHas(row.suite, row.test));

  assert.deepEqual(
    missing.map((row) => row.id),
    [],
  );

  const ids = MATRIX.map((row) => row.id);

  assert.equal(new Set(ids).size, ids.length);
});

// Part B: gap coverage discovered while assembling the matrix.

function codexFakeServer({ onRequest = () => {} } = {}) {
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
        onRequest(message, send);
      }
    });

    return child;
  };

  return { spawnImpl, requests };
}

const fixtureTask = Object.freeze({
  id: 'CONF-1',
  title: 'Conformance',
  goal: 'Prove matrix gaps',
  acceptance: [{ id: 'AC-1', criterion: 'works' }],
});

function withTempDir(run) {
  return async () => {
    const directory = mkdtempSync(join(tmpdir(), 'clew-conformance-'));

    try {
      await run(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

test(
  'conformance: duplicate native completion settles once',
  withTempDir(async (directory) => {
    const server = codexFakeServer({
      onRequest: (message, send) => {
        if (message.method === 'initialize') send({ id: message.id, result: {} });
        else if (message.method === 'thread/start')
          send({ id: message.id, result: { thread: { id: 'thr_dup' } } });
        else if (message.method === 'thread/name/set') send({ id: message.id, result: {} });
        else if (message.method === 'turn/start') {
          send({ id: message.id, result: { turn: { id: 'turn_dup' } } });
          send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
          send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
        }
      },
    });
    const events = [];
    const harness = new CodexHarness({
      command: 'codex',
      spawnImpl: server.spawnImpl,
      timeoutMs: 5_000,
    });
    const result = await harness.run({
      task: fixtureTask,
      cwd: directory,
      onEvent: (event) => events.push(event),
    });

    assert.equal(result.sessionId, 'thr_dup');
    assert.equal(events.filter((event) => event.type === 'HARNESS_COMPLETED').length, 1);
  }),
);

test('conformance: invalid structured plan is an explicit error', async () => {
  const architect = new CodexArchitect({
    run: async () => ({ output: { output: { parallelizable: 'yes' } } }),
  });

  await assert.rejects(
    architect.createPlan({ task: fixtureTask, cwd: process.cwd() }),
    /did not return a structured plan/,
  );
});

test('conformance: invalid review report degrades to needs-human', async () => {
  const reviewer = new CodexReviewer({
    run: async () => ({ output: { output: { verdict: 'bogus' } } }),
  });
  const report = await reviewer.review({
    task: fixtureTask,
    evidence: [],
    revision: 'abc',
    cwd: process.cwd(),
  });

  assert.equal(report.verdict, 'needs_human');
});

function jsonResponse(data, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => data };
}

test(
  'conformance: malformed model is omitted, never substituted',
  withTempDir(async (directory) => {
    const bodies = [];
    const fetchImpl = async (url, options = {}) => {
      const href = String(url);

      if (href.includes('/session?') && (options.method ?? 'GET') === 'POST')
        return jsonResponse({ id: 'sess_m' });

      if (href.includes('/event')) return jsonResponse({ ok: true });

      if (href.includes('/message')) {
        bodies.push(JSON.parse(options.body));

        return jsonResponse({ id: 'msg_m', parts: [], usage: null });
      }

      throw new Error(`unexpected stub call: ${href}`);
    };
    const harness = new OpenCodeHarness({ baseUrl: 'http://oc:4096', fetchImpl });
    const result = await harness.run({
      task: fixtureTask,
      cwd: directory,
      onEvent: () => {},
      model: 'badmodel',
    });

    assert.equal(result.sessionId, 'sess_m');
    assert.equal('model' in bodies[0], false);
  }),
);

test('conformance: opencode adapter owns one harness', () => {
  const host = createPluginHost({ plugins: [], connections: [], allowFake: false });

  registerOpenCodePlugin(host.registry, {});

  const { connection } = buildLegacyOpenCodeConnection({ openCodeUrl: 'http://oc:4096' });
  const resolver = new ConnectionResolver({
    registry: host.registry,
    connections: [connection],
    allowFake: false,
  });
  const adapter = resolver.resolve({ connectionId: connection.id });

  assert.equal(adapter.asLegacyHarness(), adapter.asLegacyHarness());
});

// Part C (AC-1/User outcome): a fourth runtime plugs in through generic
// paths only — no new branches in scheduler, roles, lifecycle, or UI.

test('conformance: fourth runtime registers and runs without domain branches', async () => {
  const STUB_PLUGIN_ID = 'clew.runtime.stub';
  const manifest = {
    id: STUB_PLUGIN_ID,
    version: '1.0.0',
    apiVersion: '1',
    extensionPoints: [{ point: 'AgentRuntime', version: '1' }],
    configSchema: { type: 'object', properties: {} },
    scope: 'execution-host',
    resources: { binaries: [], network: [], notes: 'conformance stub' },
  };
  const factory = () => ({
    describe: () => ({
      plugin: STUB_PLUGIN_ID,
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
  });
  const host = createPluginHost({
    plugins: [{ manifest, factory }],
    connections: [{ id: 'stub-1', plugin: STUB_PLUGIN_ID, enabled: true, config: {} }],
    allowFake: false,
  });
  const adapter = host.resolver.resolve({ connectionId: 'stub-1' });
  const result = await adapter.run({ runId: 'r1' }, {});

  assert.equal(result.status, 'completed');
  assert.equal(result.session.nativeSessionId, 'stub-r1');

  const guarded = [
    'scheduler.js',
    'architect.js',
    'review.js',
    'control-service.js',
    'runner-execution.js',
    'session-surface.js',
    'daemon.js',
  ];

  for (const file of guarded) {
    const content = readFileSync(join(srcDir, file), 'utf8');

    assert.doesNotMatch(
      content,
      /clew\.runtime\.stub/,
      `${file} must not branch on the new runtime`,
    );
  }
  await host.resolver.dispose();
});

// Part D (AC-2): production always resolves through the registry.

test('conformance: production schedulers always carry a resolver', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clew-conformance-sched-'));
  const stateDirectory = join(directory, '.clew');

  mkdirSync(stateDirectory);

  const store = new Store(join(stateDirectory, 'clew.sqlite'));
  const service = new ClewService({ cwd: directory, store, config: { ...DEFAULT_CONFIG } });

  try {
    const scheduler = service.scheduler([]);

    assert.ok(scheduler.runtimeResolver);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// Part E (AC-3): every legacy input maps to a connection, a diagnostic, or
// an explicit rejection.

test('conformance: legacy flag matrix maps every old input', () => {
  // CLI harness names stay valid aliases.
  assert.deepEqual(Object.values(HARNESS_NAME).sort(), ['codex', 'fake', 'opencode']);

  // Role flags exist per role.
  assert.deepEqual(ROLE_FLAGS.worker, { connection: '--connection', model: '--worker-model' });
  assert.deepEqual(ROLE_FLAGS.architect, { connection: '--architect-connection', model: null });
  assert.deepEqual(ROLE_FLAGS.reviewer, { connection: '--review-connection', model: null });

  // Legacy binary/endpoint settings map with diagnostics.
  const codex = buildLegacyCodexConnection({ codexBin: '/bin/codex' });

  assert.equal(codex.connection.config.bin, '/bin/codex');
  assert.ok(codex.diagnostics.length > 0);

  const opencode = buildLegacyOpenCodeConnection({ openCodeUrl: 'http://oc:4096' });

  assert.equal(opencode.connection.config.baseUrl, 'http://oc:4096');
  assert.ok(opencode.diagnostics.length > 0);

  // Flag conflicts are explicit errors.
  assert.throws(
    () => assertHarnessConnectionExclusive({ harness: 'codex', connection: 'x' }),
    /either --harness or --connection/,
  );

  // Legacy models.* surface a migration diagnostic instead of vanishing.
  const { diagnostics } = collectRoleSources({
    getFlag: () => undefined,
    config: {
      layers: { agents: { user: {}, project: {} }, models: { user: { worker: 'm' }, project: {} } },
    },
    env: {},
  });

  assert.ok(diagnostics.some((entry) => entry.source === 'models'));
});
