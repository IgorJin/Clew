import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPluginHost,
  createRuntimeError,
  fakeRuntimeManifest,
  FAKE_RUNTIME_PLUGIN_ID,
  validatePluginManifest,
  validateRuntimeResult,
} from '../src/plugins/index.js';
import { PLUGIN_ERROR_CODE } from '../src/plugins/errors.js';
import { ConnectionResolver } from '../src/plugins/resolver.js';
import { PluginRegistry } from '../src/plugins/registry.js';
import { createFakeAgentRuntime } from '../src/plugins/fake-runtime.js';
import { assertSafeProjectPluginConfig } from '../src/plugins/project-config.js';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '..', 'src');
const fixtureDir = join(here, '..', 'fixtures', 'plugins');

function readFixture(name) {
  return JSON.parse(readFileSync(join(fixtureDir, name), 'utf8'));
}

function fakePluginEntry() {
  return { manifest: fakeRuntimeManifest(), factory: createFakeAgentRuntime };
}

function hostWithFake({ connections, allowFake = true, hostPolicy = null } = {}) {
  return createPluginHost({
    plugins: [fakePluginEntry()],
    connections: connections ?? readFixture('connections.json').connections,
    hostPolicy,
    allowFake,
  });
}

async function errorOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  assert.fail('expected an error but the call succeeded');

  return null;
}

// Group 1 (AC-1): unknown id, duplicate id, incompatible API, and
// unsupported capability fail explicitly before execution.

test('plugins-contracts group 1: unknown connection id fails before execution', async () => {
  const { resolver } = hostWithFake();
  const error = await errorOf(
    Promise.resolve().then(() => resolver.resolve({ connectionId: 'nope' })),
  );

  assert.equal(error.code, PLUGIN_ERROR_CODE.UNKNOWN_ID);
  assert.match(error.message, /unknown connection id/);
});

test('plugins-contracts group 1: unknown plugin id fails before execution', () => {
  const registry = new PluginRegistry();
  const resolver = new ConnectionResolver({
    registry,
    connections: [{ id: 'ghost', plugin: 'clew.runtime.ghost', enabled: true, config: {} }],
    allowFake: true,
  });

  assert.throws(() => resolver.resolve({ connectionId: 'ghost' }), /unknown plugin id/);

  try {
    resolver.resolve({ connectionId: 'ghost' });
  } catch (error) {
    assert.equal(error.code, PLUGIN_ERROR_CODE.UNKNOWN_ID);
    assert.equal(error.pluginId, 'clew.runtime.ghost');

    return;
  }

  assert.fail('expected an error');
});

test('plugins-contracts group 1: duplicate plugin id is an error regardless of load order', () => {
  const first = new PluginRegistry();

  first.register(fakeRuntimeManifest(), createFakeAgentRuntime);
  assert.throws(
    () => first.register(fakeRuntimeManifest(), createFakeAgentRuntime),
    /duplicate plugin id/,
  );

  const second = new PluginRegistry();
  const evilTwin = { ...fakeRuntimeManifest(), version: '9.9.9' };

  second.register(evilTwin, createFakeAgentRuntime);
  assert.throws(
    () => second.register(fakeRuntimeManifest(), createFakeAgentRuntime),
    /duplicate plugin id/,
  );
});

test('plugins-contracts group 1: incompatible Plugin API is rejected at registration', () => {
  const registry = new PluginRegistry();
  const manifest = readFixture('incompatible-manifest.json');

  assert.throws(() => registry.register(manifest, createFakeAgentRuntime), /requires Plugin API/);

  try {
    registry.register(manifest, createFakeAgentRuntime);
  } catch (error) {
    assert.equal(error.code, PLUGIN_ERROR_CODE.INCOMPATIBLE_API);

    return;
  }

  assert.fail('expected an error');
});

test('plugins-contracts group 1: manifest fixtures validate against the documented contract', () => {
  const manifest = readFixture('valid-manifest.json');

  assert.equal(validatePluginManifest(manifest).id, FAKE_RUNTIME_PLUGIN_ID);
  assert.throws(() => validatePluginManifest({ ...manifest, id: 'nope' }), /must match/);
  assert.throws(
    () => validatePluginManifest({ ...manifest, extensionPoints: [] }),
    /at least one extension point/,
  );
});

test('plugins-contracts group 1: unsupported capability is refused before execution', async () => {
  const { resolver } = hostWithFake();
  const error = await errorOf(
    Promise.resolve().then(() =>
      resolver.resolve({ connectionId: 'fake-test', requireCapabilities: ['surface.attach'] }),
    ),
  );

  assert.equal(error.code, PLUGIN_ERROR_CODE.UNSUPPORTED_CAPABILITY);
  assert.match(error.message, /surface\.attach/);
});

test('plugins-contracts group 1: disabled connection is refused with its reason', async () => {
  const { resolver } = hostWithFake();
  const error = await errorOf(
    Promise.resolve().then(() => resolver.resolve({ connectionId: 'fake-off' })),
  );

  assert.equal(error.code, PLUGIN_ERROR_CODE.DISABLED);
});

test('plugins-contracts group 1: host policy allowlist denies unlisted connections', async () => {
  const { resolver } = hostWithFake({ hostPolicy: { allowedConnections: ['other'] } });
  const error = await errorOf(
    Promise.resolve().then(() => resolver.resolve({ connectionId: 'fake-test' })),
  );

  assert.equal(error.code, PLUGIN_ERROR_CODE.HOST_POLICY_DENIED);
});

// Group 2 (AC-2): the fake runtime is reachable only on an explicit test route.

test('plugins-contracts group 2: default route cannot pick up the fake runtime', async () => {
  const { resolver } = hostWithFake({ allowFake: false });
  const error = await errorOf(
    Promise.resolve().then(() => resolver.resolve({ connectionId: 'fake-test' })),
  );

  assert.equal(error.code, PLUGIN_ERROR_CODE.FAKE_NOT_ALLOWED);
  assert.match(error.message, /explicit test route/);
});

test('plugins-contracts group 2: explicit fake route runs deterministically', async () => {
  const { resolver } = hostWithFake({ allowFake: true });
  const runtime = resolver.resolve({ connectionId: 'fake-test' });
  const checkpoints = [];
  const result = await runtime.run(
    { runId: 'run-1' },
    { onCheckpoint: (cp) => checkpoints.push(cp) },
  );

  assert.equal(validateRuntimeResult(result, FAKE_RUNTIME_PLUGIN_ID).status, 'completed');
  assert.equal(result.session.nativeSessionId, 'fake-run-1');
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].runId, 'run-1');
});

// Group 3 (AC-3): domain services stay free of concrete runtime imports;
// adapter instances are stable per host and isolated across restarts.

test('plugins-contracts group 3: domain services do not import the plugin registry', () => {
  const guarded = [
    'scheduler.js',
    'architect.js',
    'review.js',
    'control-service.js',
    'runner-execution.js',
    'session-surface.js',
    'daemon.js',
  ];
  // The registry, the resolver, and concrete runtime modules live only in
  // the composition root. The transition bridge `plugins/legacy.js` is the
  // single allowed exception until CLEW-133 removes it.
  const forbidden = /(?:from|import\()\s*['"][^'"]*plugins\/(registry|resolver|codex|opencode)/;
  const violations = [];

  for (const file of guarded) {
    const content = readFileSync(join(srcDir, file), 'utf8');

    if (forbidden.test(content)) violations.push(file);
  }

  assert.deepEqual(violations, []);
});

test('plugins-contracts group 3: repeated resolve returns one adapter per connection', () => {
  const { resolver } = hostWithFake();
  const first = resolver.resolve({ connectionId: 'fake-test' });
  const second = resolver.resolve({ connectionId: 'fake-test' });

  assert.equal(first, second);
});

test('plugins-contracts group 3: a fresh host build creates fresh adapters', async () => {
  const first = hostWithFake();
  const second = hostWithFake();
  const adapterA = first.resolver.resolve({ connectionId: 'fake-test' });
  const adapterB = second.resolver.resolve({ connectionId: 'fake-test' });

  assert.notEqual(adapterA, adapterB);
  await first.resolver.dispose();
  await second.resolver.dispose();
});
test('plugins-contracts group 3: runtime errors and results keep their contract shape', () => {
  const error = createRuntimeError({
    code: 'FAKE_TIMEOUT',
    message: 'timed out',
    errorClass: 'timeout',
  });

  assert.equal(error.class, 'timeout');
  assert.throws(
    () => createRuntimeError({ code: 'X', message: 'Y', errorClass: 'nope' }),
    /runtime error class/,
  );
  assert.throws(
    () => validateRuntimeResult({ status: 'completed', session: {} }, FAKE_RUNTIME_PLUGIN_ID),
    /nativeSessionId/,
  );
  // CLEW-128 amendment: interrupted/failed results may carry an unknown
  // session (e.g. abort before the native thread exists).
  assert.equal(
    validateRuntimeResult(
      {
        status: 'interrupted',
        session: { runtime: 'fake', connection: 'fake-test', nativeSessionId: null },
        error: { code: 'HARNESS_INTERRUPTED', message: 'interrupted', class: 'execution-failure' },
      },
      FAKE_RUNTIME_PLUGIN_ID,
    ).status,
    'interrupted',
  );
});

// Group 4 (AC-4): project config cannot smuggle secrets or host-level fields.

test('plugins-contracts group 4: valid project plugin config passes', () => {
  assertSafeProjectPluginConfig(readFixture('valid-project-config.json'));
  assertSafeProjectPluginConfig({});
  assertSafeProjectPluginConfig(null);
});

test('plugins-contracts group 4: secrets in plugin sections are rejected', () => {
  const config = readFixture('secret-project-config.json');

  assert.throws(() => assertSafeProjectPluginConfig(config), /must not contain secret field/);

  try {
    assertSafeProjectPluginConfig(config);
  } catch (error) {
    assert.equal(error.code, PLUGIN_ERROR_CODE.INVALID_CONFIG);
    assert.match(error.message, /agents\.worker\.token/);

    return;
  }

  assert.fail('expected an error');
});

test('plugins-contracts group 4: module paths and binaries in project config are rejected', () => {
  const config = readFixture('module-path-project-config.json');

  assert.throws(() => assertSafeProjectPluginConfig(config), /host-level field/);

  try {
    assertSafeProjectPluginConfig(config);
  } catch (error) {
    assert.equal(error.code, PLUGIN_ERROR_CODE.INVALID_CONFIG);
    assert.match(error.message, /connections\.0\.bin/);

    return;
  }

  assert.fail('expected an error');
});
