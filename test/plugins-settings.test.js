import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClewService } from '../src/control-service.js';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { PLUGIN_ERROR_CODE } from '../src/plugins/errors.js';
import { validateConfigValue } from '../src/plugins/validate-config.js';
import { parseDeviceAuthOutput } from '../src/plugins/codex/adapter.js';
import { saveHostConnection, removeHostConnection } from '../src/plugins/host-config.js';

function setup({ bin = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'clew-settings-'));
  const userConfigPath = join(dir, 'user-config.json');
  const connections = bin
    ? [{ id: 'codex-fake', plugin: 'clew.runtime.codex', enabled: true, config: { bin } }]
    : [];

  writeFileSync(
    userConfigPath,
    JSON.stringify({
      connections,
      agents: { worker: { connection: connections[0]?.id ?? 'codex-default', model: null } },
    }),
  );
  const store = new Store(join(dir, 'state.sqlite'));
  const service = new ClewService({
    cwd: dir,
    store,
    config: loadConfig(dir, { CLEW_USER_CONFIG: userConfigPath }),
  });

  return {
    dir,
    userConfigPath,
    service,
    dispose() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function fakeCodexBin({ deviceCode = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'clew-fake-codex-'));
  const bin = join(dir, 'codex-stand');

  writeFileSync(
    bin,
    `#!/bin/sh
case "$1" in
  --version) echo "codex-cli 0.0.0-test"; exit 0;;
  login)
    if [ "$2" = "status" ]; then echo "Logged in"; exit 0; fi
    if [ "$2" = "--with-api-key" ]; then read key; [ -n "$key" ]; exit $?; fi
    ${deviceCode ? 'printf "\\nOpen this link in your browser: https://auth.openai.com/codex/device\\nEnter code ABCD-12345\\n"' : ''}
    sleep 0.4
    exit 0
    ;;
esac
exit 1
`,
  );
  chmodSync(bin, 0o755);

  return { dir, bin };
}

test('validate-config accepts the null JSON-Schema type used by manifests', () => {
  assert.doesNotThrow(() =>
    validateConfigValue(
      { type: 'object', properties: { model: { type: ['string', 'null'] } } },
      {
        model: null,
      },
    ),
  );
  assert.doesNotThrow(() =>
    validateConfigValue(
      { type: 'object', properties: { model: { type: ['string', 'null'] } } },
      {
        model: 'gpt-5',
      },
    ),
  );
});

test('connections show/save/remove persist host settings and reject reserved ids', async () => {
  const { service, userConfigPath, dispose } = setup();

  try {
    const saved = await service.execute([
      'connections',
      'save',
      'codex-work',
      '--plugin',
      'clew.runtime.codex',
      '--bin',
      '/opt/codex',
      '--model',
      'gpt-5.6-luna',
    ]);

    assert.equal(saved.saved, true);

    const listed = await service.execute(['connections', 'list']);

    assert.ok(listed.connections.some((entry) => entry.id === 'codex-work'));
    const shown = await service.execute(['connections', 'show', 'codex-work']);

    assert.equal(shown.source, 'user');
    assert.equal(shown.reserved, false);
    assert.equal(shown.config.bin, '/opt/codex');
    assert.equal(shown.config.model, 'gpt-5.6-luna');
    const persisted = JSON.parse(readFileSync(userConfigPath, 'utf8'));

    assert.equal(
      persisted.connections.find((entry) => entry.id === 'codex-work').config.bin,
      '/opt/codex',
    );

    // Invalid config is rejected before writing.
    await assert.rejects(
      service.execute(['connections', 'save', 'bad', '--plugin', 'clew.runtime.codex']),
      /missing required field "bin"/,
    );

    // Reserved legacy ids cannot be redefined or removed.
    await assert.rejects(
      service.execute([
        'connections',
        'save',
        'codex-default',
        '--plugin',
        'clew.runtime.codex',
        '--bin',
        'x',
      ]),
      /reserved legacy id/,
    );
    await assert.rejects(
      service.execute(['connections', 'remove', 'codex-default']),
      /reserved and cannot be removed/,
    );

    // Remove works for user connections.
    assert.equal((await service.execute(['connections', 'remove', 'codex-work'])).removed, true);
    assert.ok(
      !(await service.execute(['connections', 'list'])).connections.some(
        (e) => e.id === 'codex-work',
      ),
    );
  } finally {
    dispose();
  }
});

test('agents set/list persist role routing and validate the connection', async () => {
  const { service, dispose } = setup();

  try {
    const saved = await service.execute([
      'agents',
      'set',
      'reviewer',
      '--connection',
      'codex-default',
      '--model',
      'm',
    ]);

    assert.deepEqual(saved, {
      saved: true,
      role: 'reviewer',
      connection: 'codex-default',
      model: 'm',
    });

    const listed = await service.execute(['agents', 'list']);
    const reviewer = listed.roles.find((route) => route.role === 'reviewer');

    assert.equal(reviewer.connection, 'codex-default');
    assert.equal(reviewer.model, 'm');
    await assert.rejects(
      service.execute(['agents', 'set', 'worker', '--connection', 'ghost']),
      /not available on this execution host/,
    );
    await assert.rejects(
      service.execute(['agents', 'set', 'nope', '--connection', 'codex-default']),
      /usage: clew agents set/,
    );
  } finally {
    dispose();
  }
});

test('parseDeviceAuthOutput extracts the URL and one-time code', () => {
  const raw =
    '\u001b[90mOpen this link: \u001b[0m\u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n   \u001b[94m9G5C-VW89N\u001b[0m\n';

  assert.deepEqual(parseDeviceAuthOutput(raw), {
    verificationUrl: 'https://auth.openai.com/codex/device',
    userCode: '9G5C-VW89N',
  });
});

test('connections login returns a device code and settles to authenticated', async () => {
  const { bin } = fakeCodexBin();
  const { service, dispose } = setup({ bin });

  try {
    const started = await service.execute(['connections', 'login', 'codex-fake']);

    assert.equal(started.connectionId, 'codex-fake');
    assert.equal(started.status, 'pending');
    assert.equal(started.verificationUrl, 'https://auth.openai.com/codex/device');
    assert.equal(started.userCode, 'ABCD-12345');

    const deadline = Date.now() + 5_000;
    let state = started;

    while (state.status === 'pending' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = await service.execute(['connections', 'login-status', started.sessionId]);
    }
    assert.equal(state.status, 'authenticated');
    await assert.rejects(
      service.execute(['connections', 'login-status', 'nope']),
      (error) => error.code === PLUGIN_ERROR_CODE.UNKNOWN_ID,
    );
  } finally {
    dispose();
  }
});

test('connections login with an API key authenticates without a browser', async () => {
  const { bin } = fakeCodexBin();
  const { service, dispose } = setup({ bin });

  try {
    const started = await service.execute([
      'connections',
      'login',
      'codex-fake',
      '--with-api-key',
      '--api-key',
      'test-key',
    ]);

    assert.equal(started.connectionId, 'codex-fake');

    const deadline = Date.now() + 5_000;
    let state = started;

    while (state.status === 'pending' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      state = await service.execute(['connections', 'login-status', started.sessionId]);
    }
    assert.equal(state.status, 'authenticated');
  } finally {
    dispose();
  }
});

test('connections login rejects an empty API key', async () => {
  const { bin } = fakeCodexBin();
  const { service, dispose } = setup({ bin });

  try {
    await assert.rejects(
      service.execute(['connections', 'login', 'codex-fake', '--with-api-key', '--api-key', '']),
      (error) => error.code === PLUGIN_ERROR_CODE.INVALID_CONFIG,
    );
  } finally {
    dispose();
  }
});

test('connections login refuses runtimes without interactive auth', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-settings-oc-'));
  const userConfigPath = join(dir, 'user-config.json');

  writeFileSync(
    userConfigPath,
    JSON.stringify({
      connections: [
        {
          id: 'oc',
          plugin: 'clew.runtime.opencode',
          enabled: true,
          config: { baseUrl: 'http://127.0.0.1:1' },
        },
      ],
    }),
  );
  const store = new Store(join(dir, 'state.sqlite'));
  const service = new ClewService({
    cwd: dir,
    store,
    config: loadConfig(dir, { CLEW_USER_CONFIG: userConfigPath }),
  });

  try {
    await assert.rejects(
      service.execute(['connections', 'login', 'oc']),
      (error) => error.code === PLUGIN_ERROR_CODE.UNSUPPORTED_CAPABILITY,
    );
    await assert.rejects(
      service.execute(['connections', 'login', 'oc', '--with-api-key', '--api-key', 'x']),
      (error) => error.code === PLUGIN_ERROR_CODE.UNSUPPORTED_CAPABILITY,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('host-config refuses reserved ids directly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-settings-reserved-'));
  const path = join(dir, 'user.json');

  writeFileSync(path, JSON.stringify({ connections: [] }));
  assert.throws(
    () =>
      saveHostConnection(path, {
        id: 'otel-main',
        plugin: 'clew.telemetry.otel',
        enabled: true,
        config: {},
      }),
    /reserved legacy id/,
  );
  assert.throws(() => removeHostConnection(path, 'codex-default'), /reserved/);
  rmSync(dir, { recursive: true, force: true });
});
