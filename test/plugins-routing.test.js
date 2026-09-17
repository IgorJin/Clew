import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../src/config.js';
import { ClewService } from '../src/control-service.js';
import { Store } from '../src/store.js';
import { PLUGIN_ERROR_CODE } from '../src/plugins/errors.js';
import {
  AGENT_ROLES,
  collectRoleSources,
  resolveAgentRoutes,
  resolveRoleRoute,
} from '../src/plugins/role-routing.js';
import {
  legacyDefaultModel,
  LEGACY_REVIEWER_MODEL,
  resolveCodexArchitect,
  resolveCodexReviewer,
} from '../src/plugins/legacy.js';
import { buildRuntimeHost } from '../src/plugins/host.js';
import { CODEX_RUNTIME_PLUGIN_ID } from '../src/plugins/codex/manifest.js';
import { OPENCODE_RUNTIME_PLUGIN_ID } from '../src/plugins/opencode/manifest.js';
import { createCodexAgentRuntime } from '../src/plugins/codex/index.js';

const ALLOW_ALL = ['codex-default', 'opencode-default', 'custom'];

function serviceWith(configOverrides = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'clew-routing-'));
  const stateDirectory = join(cwd, '.clew');

  mkdirSync(stateDirectory);
  const store = new Store(join(stateDirectory, 'clew.sqlite'));
  const service = new ClewService({
    cwd,
    store,
    config: {
      ...DEFAULT_CONFIG,
      codexBin: 'codex',
      // Hermetic default: keeps doctor probes off the real network.
      openCodeUrl: 'not-a-url',
      ...configOverrides,
    },
  });

  return {
    cwd,
    service,
    async dispose() {
      store.close();
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

// Group 1 (AC-1): one connection + model per role, strict precedence, no
// silent substitution or cross-connection carryover.

test('plugins-routing group 1: flag beats env beats project beats user beats defaults', () => {
  const sources = {
    flag: { connection: 'flag-conn', model: 'flag-model' },
    env: { connection: 'env-conn', model: 'env-model' },
    project: { connection: 'project-conn', model: 'project-model' },
    user: { connection: 'user-conn', model: 'user-model' },
    defaults: { connection: 'default-conn', model: 'default-model' },
  };

  assert.deepEqual(resolveRoleRoute('worker', sources, { allowedConnections: null }), {
    role: 'worker',
    connection: 'flag-conn',
    model: 'flag-model',
    source: 'flag',
  });
  assert.deepEqual(
    resolveRoleRoute('worker', { ...sources, flag: {} }, { allowedConnections: null }).source,
    'env',
  );
  assert.deepEqual(resolveRoleRoute('worker', { defaults: {} }, { allowedConnections: null }), {
    role: 'worker',
    connection: 'codex-default',
    model: null,
    source: 'default',
  });
});

test('plugins-routing group 1: roles resolve independently without model carryover', () => {
  const routes = resolveAgentRoutes(
    {
      sources: {
        worker: { user: { connection: 'custom', model: 'worker-model' } },
        reviewer: { user: { connection: 'custom' } },
      },
    },
    { options: { allowedConnections: ALLOW_ALL } },
  );

  assert.equal(routes.worker.model, 'worker-model');
  assert.equal(routes.reviewer.model, null);
  assert.equal(routes.reviewer.connection, 'custom');
  assert.deepEqual(Object.keys(routes).sort(), [...AGENT_ROLES].sort());
});

test('plugins-routing group 1: unknown connections and malformed models are refused', () => {
  assert.throws(
    () =>
      resolveRoleRoute(
        'worker',
        { user: { connection: 'ghost' } },
        { allowedConnections: ALLOW_ALL },
      ),
    /not available on this execution host/,
  );

  try {
    resolveRoleRoute(
      'worker',
      { user: { connection: 'ghost' } },
      { allowedConnections: ALLOW_ALL },
    );
  } catch (error) {
    assert.equal(error.code, PLUGIN_ERROR_CODE.HOST_POLICY_DENIED);

    return;
  }

  assert.fail('expected an error');
  assert.throws(
    () => resolveRoleRoute('worker', { flag: { model: '' } }, { allowedConnections: null }),
    /must be a non-empty string or null/,
  );
  assert.throws(
    () => resolveRoleRoute('nope', {}, { allowedConnections: null }),
    /unknown agent role/,
  );
});

test('plugins-routing group 1: legacy reviewer default applies to Codex only', () => {
  assert.equal(legacyDefaultModel('reviewer', CODEX_RUNTIME_PLUGIN_ID), LEGACY_REVIEWER_MODEL);
  assert.equal(legacyDefaultModel('reviewer', OPENCODE_RUNTIME_PLUGIN_ID), null);
  assert.equal(legacyDefaultModel('worker', CODEX_RUNTIME_PLUGIN_ID), null);
});

test('plugins-routing group 1: role model reaches the harness default per model', () => {
  const adapter = createCodexAgentRuntime({ id: 'codex-default', config: { bin: 'codex' } });
  const reviewerHarness = adapter.asLegacyHarness({ model: 'review-model' });
  const workerHarness = adapter.asLegacyHarness({ model: 'worker-model' });

  assert.equal(reviewerHarness.model, 'review-model');
  assert.equal(workerHarness.model, 'worker-model');
  assert.notEqual(reviewerHarness, workerHarness);
  assert.equal(adapter.asLegacyHarness({ model: 'review-model' }), reviewerHarness);
});

test('plugins-routing group 1: session refs carry runtime identity and refuse foreign resume', async () => {
  const adapter = createCodexAgentRuntime({ id: 'codex-default', config: { bin: 'codex' } });

  await assert.rejects(
    adapter.run(
      {
        runId: 'run-foreign',
        brief: {
          task: { id: 'T', title: 't', goal: 'g', acceptance: [{ id: 'A', criterion: 'c' }] },
        },
        workspace: { cwd: process.cwd() },
        resumeSessionRef: { runtime: 'opencode', connection: 'x', nativeSessionId: 'sess' },
      },
      { onEvent: () => {} },
    ),
    /never move between runtimes/,
  );
});

test('plugins-routing group 1: sources collect flags, env, layers, and legacy diagnostics', () => {
  const flags = { '--connection': 'flag-conn', '--worker-model': 'flag-model' };
  const { sources, diagnostics } = collectRoleSources({
    getFlag: (name) => flags[name],
    config: {
      layers: {
        agents: { user: {}, project: {} },
        models: { user: {}, project: { reviewer: 'legacy-model' } },
      },
    },
    env: {},
  });

  assert.equal(sources.worker.flag.connection, 'flag-conn');
  assert.equal(sources.worker.flag.model, 'flag-model');
  assert.equal(sources.reviewer.project.model, 'legacy-model');
  assert.ok(diagnostics.some((entry) => entry.source === 'models' && entry.role === 'reviewer'));
});

test('plugins-routing group 1: reviewer/architect on a non-codex connection are refused before execution', () => {
  const host = buildRuntimeHost({ codexBin: 'codex', openCodeUrl: 'not-a-url' });

  for (const [label, factory] of [
    ['reviewer', resolveCodexReviewer],
    ['architect', resolveCodexArchitect],
  ]) {
    assert.throws(
      () =>
        factory({ resolver: host.resolver, adapterConfig: {}, connectionId: 'opencode-default' }),
      (error) =>
        error.code === PLUGIN_ERROR_CODE.UNSUPPORTED_CAPABILITY &&
        /requires the codex runtime/.test(error.message) &&
        /opencode-default/.test(error.message),
      `${label} must be refused on a non-codex connection`,
    );
  }

  // The codex connection still resolves normally.
  assert.ok(resolveCodexReviewer({ resolver: host.resolver, adapterConfig: {} }));
  assert.ok(resolveCodexArchitect({ resolver: host.resolver, adapterConfig: {} }));
});

// Group 2 (AC-2): harness/connection exclusivity and legacy migration.

test('plugins-routing group 2: conflicting selectors are an explicit error', async () => {
  const { service, dispose } = serviceWith();

  try {
    const { routes } = service.resolveRunRoutes([]);

    assert.equal(routes.worker.source, 'default');

    await assert.rejects(
      service.execute(['run', 'missing-task', '--harness', 'codex', '--connection', 'x']),
      /either --harness or --connection/,
    );
    await assert.rejects(
      service.execute(['doctor', '--harness', 'codex', '--connection', 'x']),
      /either/,
    );
  } finally {
    await dispose();
  }
});

test('plugins-routing group 2: core config carries no runtime model names', () => {
  const serialized = JSON.stringify(DEFAULT_CONFIG);

  assert.doesNotMatch(serialized, /gpt-5\.6-luna/);

  for (const file of ['scheduler.js', 'control-service.js', 'config.js']) {
    const content = readFileSync(join(import.meta.dirname, '..', 'src', file), 'utf8');

    assert.doesNotMatch(content, /gpt-5\.6-luna/, `${file} must not name runtime models`);
  }
});

// Group 3 (AC-3): doctor explains unavailability without changing auth state.

test('plugins-routing group 3: doctor reports unavailable binaries with reason codes', async () => {
  const { service, dispose } = serviceWith({ codexBin: 'clew-command-that-does-not-exist' });

  try {
    const first = await service.execute(['doctor']);
    const codex = first.checks.find((check) => check.name === 'connection:codex-default');

    assert.equal(first.ok, true);
    assert.equal(codex.ok, false);
    assert.equal(codex.required, false);
    assert.equal(codex.status, 'unavailable');
    assert.equal(codex.reason, 'binary-unavailable');
    assert.ok(Array.isArray(first.diagnostics));
    assert.ok(
      first.diagnostics.some((entry) => entry.source === 'codexBin'),
      'doctor surfaces the legacy codexBin migration diagnostic',
    );
    assert.doesNotMatch(JSON.stringify(first.diagnostics), /\/(bin|tmp|Users|home|opt|usr)\//);

    const second = await service.execute(['doctor']);

    assert.deepEqual(
      second.checks.map((check) => [check.name, check.status]),
      first.checks.map((check) => [check.name, check.status]),
    );
  } finally {
    await dispose();
  }
});

test('plugins-routing group 3: doctor shows disabled connections explicitly', async () => {
  const { service, dispose } = serviceWith({
    connections: [
      { id: 'off', plugin: 'clew.runtime.codex', enabled: false, config: { bin: 'codex' } },
    ],
  });

  try {
    const result = await service.execute(['doctor']);
    const entry = result.checks.find((check) => check.name === 'connection:off');

    assert.equal(entry.ok, false);
    assert.equal(entry.status, 'disabled');
  } finally {
    await dispose();
  }
});

test('plugins-routing group 3: probe only reads, never changes auth state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-probe-readonly-'));
  const log = join(dir, 'argv.log');
  const bin = join(dir, 'codex-stub');

  writeFileSync(
    bin,
    `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\nif [ "$1" = "--version" ]; then echo "codex-cli 0.0.0-test"; exit 0; fi\nexit 1\n`,
  );
  chmodSync(bin, 0o755);

  const { service, dispose } = serviceWith({ codexBin: bin });

  try {
    const result = await service.execute(['doctor', '--connection', 'codex-default']);
    const entry = result.checks.find((check) => check.name === 'connection:codex-default');
    const logged = readFileSync(log, 'utf8').trim().split('\n');

    assert.equal(entry.status, 'unavailable');
    assert.equal(entry.reason, 'auth-unavailable');
    assert.ok(logged.includes('--version'));
    assert.ok(logged.includes('login status'));
  } finally {
    await dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Group 4 (AC-4): the exposed projection is secret- and path-free.

test('plugins-routing group 4: connections list exposes only the safe projection', async () => {
  const { service, dispose } = serviceWith({
    codexBin: 'codex',
    openCodeUrl: 'http://127.0.0.1:4096',
  });

  try {
    const result = await service.execute(['connections', 'list']);
    const serialized = JSON.stringify(result);

    assert.ok(result.connections.length >= 2);
    assert.ok(
      result.connections.every(
        (entry) => Object.keys(entry).sort().join(',') === 'capabilities,enabled,id,plugin',
      ),
    );
    assert.doesNotMatch(serialized, /\/(bin|tmp|Users|home|opt|usr)\//);
    assert.doesNotMatch(serialized, /https?:\/\//);
    assert.doesNotMatch(serialized, /token|secret|credential|password|passwd|api[_-]?key/i);
    await assert.rejects(service.execute(['connections', 'bogus']), /usage: clew connections list/);
  } finally {
    await dispose();
  }
});

test('plugins-routing group 4: project-defined connections are ignored with diagnostics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-routing-project-'));
  const stateDirectory = join(dir, '.clew');

  mkdirSync(stateDirectory);
  writeFileSync(
    join(dir, '.clew.json'),
    JSON.stringify({ connections: [{ id: 'sneaky', plugin: 'clew.runtime.codex' }] }),
  );

  const store = new Store(join(stateDirectory, 'clew.sqlite'));
  const { loadConfig } = await import('../src/config.js');
  const service = new ClewService({
    cwd: dir,
    store,
    config: loadConfig(dir, { CLEW_USER_CONFIG: join(dir, 'missing.json') }),
  });

  try {
    const result = await service.execute(['connections', 'list']);
    const serialized = JSON.stringify(result);

    assert.ok(!result.connections.some((entry) => entry.id === 'sneaky'));
    assert.ok(result.diagnostics.some((entry) => /project-defined connection/.test(entry.message)));
    assert.doesNotMatch(serialized, /sneaky/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
