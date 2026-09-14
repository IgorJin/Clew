import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/store.js';
import { applyMigrations } from '../src/migrations.js';
import { RunnerStore } from '../src/runner-store.js';
import { Scheduler } from '../src/scheduler.js';
import { RunnerExecutionPort } from '../src/runner-execution.js';
import { PairedExecutionPort } from '../src/execution-port.js';
import { GitWorktreeManager } from '../src/workspace.js';
import { createPluginHost } from '../src/plugins/index.js';
import { ConnectionResolver } from '../src/plugins/resolver.js';
import { PLUGIN_ERROR_CODE } from '../src/plugins/errors.js';
import {
  buildRunBinding,
  checkBindingCompatible,
  fingerprintConnectionConfig,
} from '../src/plugins/binding.js';
import {
  fakeRuntimeManifest,
  createFakeAgentRuntime,
  FAKE_RUNTIME_PLUGIN_ID,
} from '../src/plugins/fake-runtime.js';
import { registerCodexPlugin } from '../src/plugins/codex/index.js';
import { CODEX_RUNTIME_PLUGIN_ID } from '../src/plugins/codex/manifest.js';
import { collectRunnerInventory } from '../src/plugins/host.js';
import { buildLegacyCodexConnection } from '../src/plugins/legacy.js';
import {
  RUNNER_MESSAGE_KIND,
  createRunnerEnvelope,
  sanitizeRunnerPayload,
  validateRunnerEnvelope,
} from '../src/runner-protocol.js';

function testStore() {
  const directory = mkdtempSync(join(tmpdir(), 'clew-paired-'));
  const store = new Store(join(directory, 'clew.sqlite'));

  return {
    directory,
    store,
    dispose() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function seedTaskRun(store, { taskId = 'BIND-1', runId = 'run-1', harness = 'codex' } = {}) {
  store.createTask({
    id: taskId,
    title: 'Binding',
    goal: 'Exercise run bindings',
    acceptance: [{ id: 'AC-1', criterion: 'works' }],
    profile: 'quick',
    base_ref: 'HEAD',
  });
  store.createRun({
    id: runId,
    taskId,
    stageId: 'worker',
    attempt: 1,
    status: 'RUNNING',
    harness,
  });

  return { taskId, runId };
}

function fakeHost() {
  const host = createPluginHost({
    plugins: [{ manifest: fakeRuntimeManifest(), factory: createFakeAgentRuntime }],
    connections: [{ id: 'fake-test', plugin: FAKE_RUNTIME_PLUGIN_ID, enabled: true, config: {} }],
    allowFake: true,
  });

  return host;
}

test('plugins-paired group 1: binding contract builds and checks without a scheduler', () => {
  const host = fakeHost();
  const adapter = host.resolver.resolve({ connectionId: 'fake-test' });
  const binding = buildRunBinding({
    runId: 'run-contract',
    taskId: 'BIND-1',
    stageId: 'worker',
    attempt: 1,
    connectionId: 'fake-test',
    adapter,
    registry: host.registry,
    model: null,
    executionHost: 'local',
  });

  assert.equal(binding.version, 1);
  assert.equal(binding.pluginId, FAKE_RUNTIME_PLUGIN_ID);
  assert.deepEqual(
    checkBindingCompatible(binding, { registry: host.registry, resolver: host.resolver }),
    { compatible: true, binding },
  );
  assert.equal(
    checkBindingCompatible({ ...binding, pluginVersion: '0.0.0' }, { registry: host.registry })
      .compatible,
    false,
  );
  assert.equal(checkBindingCompatible(null, { registry: host.registry }).compatible, false);
});

function codexHost() {
  const { connection } = buildLegacyCodexConnection({ codexBin: 'codex' });
  const host = createPluginHost({ plugins: [], connections: [connection], allowFake: false });

  registerCodexPlugin(host.registry, {});

  return host;
}

// Group 1 (AC-1): local and paired runs pin equivalent canonical bindings.

test('plugins-paired group 1: local and paired snapshots agree modulo execution host', () => {
  const { store, dispose } = testStore();

  try {
    const { runId } = seedTaskRun(store, { runId: 'run-local' });
    const host = codexHost();
    const scheduler = new Scheduler(store, { root: null }, { runtimeResolver: host.resolver });
    const localBinding = scheduler.snapshotRunBinding({
      runId,
      taskId: 'BIND-1',
      stageId: 'worker',
      attempt: 1,
      harnessName: 'codex',
      model: 'worker-model',
      executionHost: 'local',
    });
    const pairedBinding = scheduler.snapshotRunBinding({
      runId: 'run-paired',
      taskId: 'BIND-1',
      stageId: 'worker',
      attempt: 1,
      harnessName: 'codex',
      model: 'worker-model',
      executionHost: 'runner-1',
      persist: false,
    });

    assert.equal(store.getRunBinding(runId).status, 'bound');
    assert.equal(localBinding.pluginId, CODEX_RUNTIME_PLUGIN_ID);
    assert.equal(localBinding.connectionId, 'codex-default');
    assert.equal(localBinding.model, 'worker-model');
    assert.deepEqual(
      {
        ...pairedBinding,
        runId: localBinding.runId,
        executionHost: localBinding.executionHost,
        createdAt: localBinding.createdAt,
      },
      { ...localBinding },
    );

    const offer = createRunnerEnvelope({
      kind: RUNNER_MESSAGE_KIND.LEASE_OFFER,
      messageId: 'm-1',
      idempotencyKey: 'lease-offer:lease-1:1',
      correlationId: 'lease-1',
      payload: {
        runnerId: 'runner-1',
        leaseId: 'lease-1',
        epoch: 1,
        taskId: 'BIND-1',
        stageId: 'worker',
        runId: 'run-paired',
        attempt: 1,
        workspaceId: 'ws',
        harness: 'codex',
        requirements: {},
        binding: pairedBinding,
      },
    });
    const validated = validateRunnerEnvelope(offer);

    assert.deepEqual(validated.payload.binding, pairedBinding);
    assert.equal(typeof validated.payload.binding.configFingerprint, 'string');
  } finally {
    dispose();
  }
});

test('plugins-paired group 1: fingerprint is deterministic and secret-free by construction', () => {
  const config = { bin: 'codex', timeoutMs: 1000, nested: { b: 2, a: 1 } };

  assert.equal(fingerprintConnectionConfig(config), fingerprintConnectionConfig({ ...config }));
  assert.equal(
    fingerprintConnectionConfig(config),
    fingerprintConnectionConfig({ nested: { a: 1, b: 2 }, timeoutMs: 1000, bin: 'codex' }),
  );
  assert.match(fingerprintConnectionConfig(config), /^[0-9a-f]{64}$/);
});

test('plugins-paired group 1: runner inventory carries ids and capabilities only', () => {
  const inventory = collectRunnerInventory({ codexBin: 'codex', openCodeUrl: 'http://oc:4096' });
  const serialized = JSON.stringify(inventory);

  assert.equal(inventory.length, 2);
  assert.ok(
    inventory.every((entry) => Array.isArray(entry.capabilities) && entry.capabilities.length > 0),
  );
  assert.ok(
    inventory.every((entry) => Array.isArray(entry.connections) && entry.connections.length > 0),
  );
  assert.doesNotMatch(serialized, /http:\/\/oc:4096/);
  assert.doesNotMatch(serialized, /token|secret|credential|password|passwd|api[_-]?key/i);
});

test('plugins-paired group 1: runner executes a bound fake lease when inventory matches', async () => {
  const inventory = [
    {
      plugin: FAKE_RUNTIME_PLUGIN_ID,
      version: '1.0.0',
      apiVersion: '1',
      capabilities: ['execution.headless'],
      connections: [{ id: 'fake-test', enabled: true }],
    },
  ];
  const port = new RunnerExecutionPort({
    workspaces: [{ id: 'ws', path: '/tmp/clew-paired-ws' }],
    harnessFactory: () => ({
      async run() {
        return { verification: [{ type: 'command', command: 'x', result: 'passed' }] };
      },
    }),
    runtimeInventory: inventory,
  });
  const binding = {
    version: 1,
    runId: 'run-fake',
    pluginId: FAKE_RUNTIME_PLUGIN_ID,
    pluginVersion: '1.0.0',
    pluginApiVersion: '1',
    connectionId: 'fake-test',
    executionHost: 'runner-1',
    cliVersion: null,
    capabilitySnapshot: ['execution.headless'],
    model: null,
    configFingerprint: 'abc',
    createdAt: new Date().toISOString(),
  };
  const result = await port.accept(
    {
      leaseId: 'lease-fake',
      epoch: 1,
      workspaceId: 'ws',
      stageId: 'worker',
      runId: 'run-fake',
      attempt: 1,
      harness: 'fake',
      binding,
      requirements: {
        task: { id: 't', title: 't', goal: 'g', acceptance: [] },
      },
    },
    {},
  );

  assert.equal(result.status, 'completed');
});

test('plugins-paired group 1: runner refuses bound leases without inventory or on mismatch', async () => {
  const baseOffer = {
    leaseId: 'lease-x',
    epoch: 1,
    workspaceId: 'ws',
    stageId: 'worker',
    runId: 'run-x',
    attempt: 1,
    harness: 'codex',
    requirements: { task: { id: 't', title: 't', goal: 'g', acceptance: [] } },
  };
  const binding = {
    version: 1,
    runId: 'run-x',
    pluginId: CODEX_RUNTIME_PLUGIN_ID,
    pluginVersion: '1.0.0',
    pluginApiVersion: '1',
    connectionId: 'codex-default',
    executionHost: 'runner-1',
    cliVersion: null,
    capabilitySnapshot: ['execution.headless'],
    model: null,
    configFingerprint: 'abc',
    createdAt: new Date().toISOString(),
  };
  const legacyPort = new RunnerExecutionPort({
    workspaces: [{ id: 'ws', path: '/tmp/clew-paired-ws' }],
    harnessFactory: () => ({
      async run() {
        return { verification: [] };
      },
    }),
  });

  await assert.rejects(
    legacyPort.accept({ ...baseOffer, binding }, {}),
    /does not support plugin-bound leases/,
  );

  const mismatched = new RunnerExecutionPort({
    workspaces: [{ id: 'ws', path: '/tmp/clew-paired-ws' }],
    harnessFactory: () => ({
      async run() {
        return { verification: [] };
      },
    }),
    runtimeInventory: [
      {
        plugin: CODEX_RUNTIME_PLUGIN_ID,
        version: '9.9.9',
        apiVersion: '1',
        capabilities: ['execution.headless'],
        connections: [{ id: 'codex-default', enabled: true }],
      },
    ],
  });

  await assert.rejects(
    mismatched.accept({ ...baseOffer, binding }, {}),
    /version 9\.9\.9 but the lease requires 1\.0\.0/,
  );
});

test('plugins-paired group 1: local parallel stages pin bindings like the worker path', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'clew-paired-stage-'));
  const project = join(directory, 'project');

  mkdirSync(project);
  const git = (args, cwd = project) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  try {
    git(['init', '-b', 'main']);
    git(['config', 'user.email', 't@t']);
    git(['config', 'user.name', 't']);
    writeFileSync(join(project, 'README.md'), 'base\n');
    git(['add', 'README.md']);
    git(['commit', '-m', 'base']);

    const store = new Store(join(directory, 'state.sqlite'));

    store.createTask({
      id: 'STAGE-1',
      title: 'Stage',
      goal: 'Pin the parallel stage binding',
      acceptance: [{ id: 'AC-1', criterion: 'works' }],
      profile: 'quick',
      base_ref: 'HEAD',
    });

    const host = codexHost();
    const scheduler = new Scheduler(
      store,
      new GitWorktreeManager(join(directory, 'worktrees'), project),
      { runtimeResolver: host.resolver, adapterConfig: {} },
    );

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

    const runs = store.listRuns('STAGE-1');

    assert.equal(runs.length, 1);
    assert.equal(store.getRunBinding(runs[0].id).status, 'bound');
    assert.equal(store.getRunBinding(runs[0].id).binding.pluginId, CODEX_RUNTIME_PLUGIN_ID);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Group 2 (AC-2): duplicates, reorder, and restarts never duplicate runs.

test('plugins-paired group 2: bindings are write-once per run', () => {
  const { store, dispose } = testStore();

  try {
    const { runId } = seedTaskRun(store);
    const host = codexHost();
    const scheduler = new Scheduler(store, { root: null }, { runtimeResolver: host.resolver });
    const first = scheduler.snapshotRunBinding({
      runId,
      taskId: 'BIND-1',
      stageId: 'worker',
      attempt: 1,
      harnessName: 'codex',
      model: null,
      executionHost: 'local',
    });

    assert.ok(first);
    assert.throws(() => store.saveRunBinding(runId, first), /UNIQUE|PRIMARY/i);
  } finally {
    dispose();
  }
});

test('plugins-paired group 2: duplicate inbound lease offers stay deduplicated', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clew-paired-dedup-'));

  try {
    const runnerStore = new RunnerStore(join(directory, 'runner.sqlite'), {
      configuredRunnerId: 'runner-1',
    });
    const envelope = createRunnerEnvelope({
      kind: RUNNER_MESSAGE_KIND.LEASE_OFFER,
      messageId: 'm-dup',
      idempotencyKey: 'lease-offer:lease-dup:1',
      correlationId: 'lease-dup',
      payload: {
        runnerId: 'runner-1',
        leaseId: 'lease-dup',
        epoch: 1,
        taskId: 'T',
        stageId: 'worker',
        runId: 'run-dup',
        attempt: 1,
        workspaceId: 'ws',
        harness: 'codex',
        requirements: {},
        binding: { version: 1, pluginId: CODEX_RUNTIME_PLUGIN_ID },
      },
    });
    const acceptResponse = () =>
      createRunnerEnvelope({
        kind: RUNNER_MESSAGE_KIND.LEASE_ACCEPTED,
        messageId: `m-accept-${Math.random().toString(36).slice(2)}`,
        idempotencyKey: 'lease-accepted:lease-dup:1',
        correlationId: 'm-dup',
        payload: { runnerId: 'runner-1', leaseId: 'lease-dup', epoch: 1 },
      });
    const first = runnerStore.recordInbound(envelope, () => ({ response: acceptResponse() }));
    const second = runnerStore.recordInbound(envelope, () => {
      throw new Error('must not re-execute a duplicate');
    });

    assert.equal(first.duplicate ?? false, false);
    assert.equal(second.duplicate, true);
    runnerStore.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('plugins-paired group 2: restart checks pass, then fail loudly on drift', () => {
  const { store, dispose } = testStore();

  try {
    const { runId } = seedTaskRun(store);
    const host = codexHost();
    const scheduler = new Scheduler(store, { root: null }, { runtimeResolver: host.resolver });

    scheduler.snapshotRunBinding({
      runId,
      taskId: 'BIND-1',
      stageId: 'worker',
      attempt: 1,
      harnessName: 'codex',
      model: null,
      executionHost: 'local',
    });

    // Simulated restart with the same registry: compatible.
    const restarted = new Scheduler(store, { root: null }, { runtimeResolver: host.resolver });

    assert.equal(restarted.requireCompatibleBinding(runId).status, 'bound');

    // Simulated plugin update: same id, bumped version.
    const upgraded = createPluginHost({ plugins: [], connections: [], allowFake: false });

    upgraded.registry.register(
      { ...host.registry.get(CODEX_RUNTIME_PLUGIN_ID).manifest, version: '9.9.9' },
      () => {
        throw new Error('must not instantiate on a compat check');
      },
    );

    const upgradedResolver = new ConnectionResolver({
      registry: upgraded.registry,
      connections: [
        {
          id: 'codex-default',
          plugin: CODEX_RUNTIME_PLUGIN_ID,
          enabled: true,
          config: { bin: 'codex' },
        },
      ],
      allowFake: false,
    });
    const upgradedScheduler = new Scheduler(
      store,
      { root: null },
      { runtimeResolver: upgradedResolver },
    );

    assert.throws(() => upgradedScheduler.requireCompatibleBinding(runId), /recovery required/);

    try {
      upgradedScheduler.requireCompatibleBinding(runId);
    } catch (error) {
      assert.equal(error.code, PLUGIN_ERROR_CODE.RECOVERY_REQUIRED);

      return;
    }

    assert.fail('expected a recovery error');
  } finally {
    dispose();
  }
});

test('plugins-paired group 2: disabled connections and legacy runs behave explicitly', () => {
  const { store, dispose } = testStore();

  try {
    const { runId } = seedTaskRun(store);
    const host = codexHost();
    const scheduler = new Scheduler(store, { root: null }, { runtimeResolver: host.resolver });

    scheduler.snapshotRunBinding({
      runId,
      taskId: 'BIND-1',
      stageId: 'worker',
      attempt: 1,
      harnessName: 'codex',
      model: null,
      executionHost: 'local',
    });

    const offHost = createPluginHost({ plugins: [], connections: [], allowFake: false });

    offHost.registry.register(host.registry.get(CODEX_RUNTIME_PLUGIN_ID).manifest, () => {
      throw new Error('must not instantiate on a compat check');
    });

    const offResolver = new ConnectionResolver({
      registry: offHost.registry,
      connections: [
        {
          id: 'codex-default',
          plugin: CODEX_RUNTIME_PLUGIN_ID,
          enabled: false,
          config: { bin: 'codex' },
        },
      ],
      allowFake: false,
    });
    const offScheduler = new Scheduler(store, { root: null }, { runtimeResolver: offResolver });

    assert.throws(() => offScheduler.requireCompatibleBinding(runId), /disabled/);

    // A run without a binding row predates plugins: history intact.
    const { runId: legacyRun } = seedTaskRun(store, { taskId: 'BIND-2', runId: 'run-legacy' });

    assert.equal(store.getRun(legacyRun).status, 'RUNNING');
    assert.equal(store.getRunBinding(legacyRun).status, 'legacy-unknown');
    assert.equal(offScheduler.requireCompatibleBinding(legacyRun).status, 'legacy-unknown');
  } finally {
    dispose();
  }
});

// Group 3 (AC-3): pre-plugin databases upgrade losslessly; old runs read
// as legacy-unknown without losing history.

test('plugins-paired group 3: v23 databases upgrade and old runs stay explainable', () => {
  const directory = mkdtempSync(join(tmpdir(), 'clew-paired-upgrade-'));
  const file = join(directory, 'clew.sqlite');
  const legacy = new DatabaseSync(file);

  try {
    applyMigrations(legacy, { through: 23 });
    legacy.exec(`
      INSERT INTO tasks (id, contract, state, created_at, updated_at)
      VALUES ('OLD-1', '{"id":"OLD-1","title":"Old","goal":"Stay","acceptance":[{"id":"AC-1","criterion":"works"}],"profile":"quick","base_ref":"HEAD"}', 'READY', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
    legacy.exec(`
      INSERT INTO runs (id, task_id, stage_id, attempt, status, harness)
      VALUES ('old-run-1', 'OLD-1', 'worker', 1, 'COMPLETED', 'codex');
    `);
  } finally {
    legacy.close();
  }

  const store = new Store(file);

  try {
    assert.equal(store.getTask('OLD-1').state, 'READY');
    assert.equal(store.getRun('old-run-1').status, 'COMPLETED');
    assert.equal(store.getRunBinding('old-run-1').status, 'legacy-unknown');

    const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();

    assert.ok(tables.some((row) => row.name === 'run_bindings'));
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('plugins-paired group 3: corrupt binding rows fail loudly', () => {
  const { store, dispose } = testStore();

  try {
    const { runId } = seedTaskRun(store);

    store.db
      .prepare('INSERT INTO run_bindings (run_id,task_id,binding,created_at) VALUES (?,?,?,?)')
      .run(runId, 'BIND-1', 'not-json{{{', new Date().toISOString());
    assert.throws(() => store.getRunBinding(runId), /corrupt/);
  } finally {
    dispose();
  }
});

// Group 4 (AC-4): v1 runners stay on the legacy route; plugin routes fail
// explicitly on both sides of the wire.

test('plugins-paired group 4: protocol stays additive for v1 runners', () => {
  const register = createRunnerEnvelope({
    kind: RUNNER_MESSAGE_KIND.REGISTER,
    messageId: 'm-reg',
    idempotencyKey: 'register:r:1',
    correlationId: 'c-reg',
    payload: {
      runnerId: 'runner-1',
      productVersion: '0.0.0',
      protocolVersions: [1],
      capabilities: ['execute'],
      workspaces: [{ id: 'ws' }],
    },
  });

  assert.doesNotThrow(() => validateRunnerEnvelope(register));

  const withInventory = createRunnerEnvelope({
    kind: RUNNER_MESSAGE_KIND.REGISTER,
    messageId: 'm-reg-2',
    idempotencyKey: 'register:r:2',
    correlationId: 'c-reg-2',
    payload: {
      runnerId: 'runner-1',
      productVersion: '0.0.0',
      protocolVersions: [1],
      capabilities: ['execute', 'plugin-bindings'],
      workspaces: [{ id: 'ws' }],
      runtimeInventory: collectRunnerInventory({}),
    },
  });
  const validated = validateRunnerEnvelope(withInventory);

  assert.equal(validated.payload.runtimeInventory.length, 2);

  const sanitized = sanitizeRunnerPayload('controller.lease_offer', {
    runnerId: 'r',
    leaseId: 'l',
    epoch: 1,
    taskId: 't',
    stageId: 's',
    runId: 'run',
    attempt: 1,
    workspaceId: 'ws',
    harness: 'codex',
    requirements: {},
    binding: { version: 1 },
    injected: 'nope',
  });

  assert.deepEqual(sanitized.binding, { version: 1 });
  assert.equal(sanitized.injected, undefined);
});

test('plugins-paired group 4: controller refuses plugin-bound leases for v1 runners', async () => {
  const { store, dispose } = testStore();

  try {
    store.createTask({
      id: 'PAIR-1',
      title: 'Paired',
      goal: 'Prove explicit v1 refusal',
      acceptance: [{ id: 'AC-1', criterion: 'works' }],
      profile: 'quick',
      base_ref: 'HEAD',
    });
    store.addStage('PAIR-1', 'worker', [], 'QUEUED');
    store.registerRunner({
      runnerId: 'runner-v1',
      protocolVersion: 1,
      productVersion: '0.0.0',
      capabilities: ['execute'],
      workspaces: [{ id: 'ws', path: '/tmp/clew-paired-ws' }],
    });

    const port = new PairedExecutionPort({
      store,
      transport: { send: async () => true },
      runnerId: 'runner-v1',
    });

    await assert.rejects(
      port.executeStage({
        run: { id: 'run-v1', taskId: 'PAIR-1', stageId: 'worker', binding: { version: 1 } },
        lease: {
          id: 'lease-v1',
          runnerId: 'runner-v1',
          epoch: 1,
          workspaceMappingId: 'ws',
          requirements: {},
        },
        offer: createRunnerEnvelope({
          kind: RUNNER_MESSAGE_KIND.LEASE_OFFER,
          messageId: 'm-v1',
          idempotencyKey: 'lease-offer:lease-v1:1',
          correlationId: 'lease-v1',
          payload: {
            runnerId: 'runner-v1',
            leaseId: 'lease-v1',
            epoch: 1,
            taskId: 'PAIR-1',
            stageId: 'worker',
            runId: 'run-v1',
            attempt: 1,
            workspaceId: 'ws',
            harness: 'codex',
            requirements: {},
          },
        }),
        requirements: {},
      }),
      /does not support plugin-bound leases/,
    );
    assert.equal(store.listRuns('PAIR-1').length, 0);
  } finally {
    dispose();
  }
});

test('plugins-paired group 4: bound leases flow to capable runners', async () => {
  const { store, dispose } = testStore();

  try {
    store.createTask({
      id: 'PAIR-2',
      title: 'Paired',
      goal: 'Prove bound flow',
      acceptance: [{ id: 'AC-1', criterion: 'works' }],
      profile: 'quick',
      base_ref: 'HEAD',
    });
    store.addStage('PAIR-2', 'worker', [], 'QUEUED');
    store.registerRunner({
      runnerId: 'runner-v2',
      protocolVersion: 1,
      productVersion: '0.0.0',
      capabilities: ['execute', 'plugin-bindings'],
      workspaces: [{ id: 'ws', path: '/tmp/clew-paired-ws' }],
    });

    const port = new PairedExecutionPort({
      store,
      transport: { send: async () => true },
      runnerId: 'runner-v2',
    });
    const host = codexHost();
    const scheduler = new Scheduler(store, { root: null }, { runtimeResolver: host.resolver });
    const binding = scheduler.snapshotRunBinding({
      runId: 'run-v2',
      taskId: 'PAIR-2',
      stageId: 'worker',
      attempt: 1,
      harnessName: 'codex',
      model: null,
      executionHost: 'runner-v2',
      persist: false,
    });

    assert.ok(binding);

    const outcome = await port.executeStage({
      run: {
        id: 'run-v2',
        taskId: 'PAIR-2',
        stageId: 'worker',
        attempt: 1,
        status: 'RUNNING',
        harness: 'codex',
        binding,
      },
      lease: {
        id: 'lease-v2',
        runnerId: 'runner-v2',
        epoch: 1,
        workspaceMappingId: 'ws',
        requirements: {},
      },
      offer: createRunnerEnvelope({
        kind: RUNNER_MESSAGE_KIND.LEASE_OFFER,
        messageId: 'm-v2',
        idempotencyKey: 'lease-offer:lease-v2:1',
        correlationId: 'lease-v2',
        payload: {
          runnerId: 'runner-v2',
          leaseId: 'lease-v2',
          epoch: 1,
          taskId: 'PAIR-2',
          stageId: 'worker',
          runId: 'run-v2',
          attempt: 1,
          workspaceId: 'ws',
          harness: 'codex',
          requirements: {},
          binding,
        },
      }),
      requirements: {},
    });

    assert.equal(outcome.mode, 'paired');
    store.saveRunBinding('run-v2', binding);

    assert.equal(store.getRunBinding('run-v2').status, 'bound');
  } finally {
    dispose();
  }
});
