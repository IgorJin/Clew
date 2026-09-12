import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { Store } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { FakeHarness } from '../src/harness.js';
import { ScoutRunner } from '../src/scout-runner.js';
import { compileHarnessPrompt } from '../src/execution-brief.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const pilotFixture = JSON.parse(
  readFileSync(join(projectRoot, 'fixtures/scout/pilot.v1.json'), 'utf8'),
);
const pilotSchema = JSON.parse(
  readFileSync(join(projectRoot, 'schemas/scout-pilot.v1.schema.json'), 'utf8'),
);

const PROJECT_ID = 'PRJ-SCOUT-PILOT';
const GIT_DATE = '2026-09-01T00:00:00Z';

function git(cwd, args, env = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function head(cwd) {
  return git(cwd, ['rev-parse', 'HEAD']).trim();
}

function sourceReference(path, revision) {
  return { path, revision };
}

function writeFixtureFiles(cwd, scenario) {
  const files = {
    '.gitignore': '.clew/\n.clew-runs/\n',
    'package.json': '{"name":"clew-126-pilot","scripts":{"test":"node --check src/entry.js"}}\n',
    'README.md': '# CLEW-126 pilot fixture\n',
  };

  if (scenario.id === 'local-bug-fix') {
    files['src/auth.js'] = 'export function canRead(user) {\n  return user?.active === true;\n}\n';
    files['test/auth.test.js'] =
      "import { canRead } from '../src/auth.js';\n\nif (!canRead({ active: true })) throw new Error('fixture');\n";
  } else if (scenario.id === 'cross-module-change') {
    files['src/orders/service.js'] =
      "import { charge } from '../billing/client.js';\n\nexport function placeOrder(order) {\n  return charge(order.total);\n}\n";
    files['src/orders/mapper.js'] =
      'export function orderTotal(order) {\n  return Number(order.total);\n}\n';
    files['src/billing/client.js'] =
      "export function charge(amount) {\n  return { amount, status: 'queued' };\n}\n";
    files['test/orders.test.js'] =
      "import { placeOrder } from '../src/orders/service.js';\n\nif (placeOrder({ total: 2 }).amount !== 2) throw new Error('fixture');\n";
  } else {
    files['src/cli.js'] =
      "import { startDaemon } from './daemon.js';\n\nexport function configure(options) {\n  return startDaemon(options);\n}\n";
    files['src/daemon.js'] =
      "export function startDaemon(options) {\n  return { options, owner: 'unknown' };\n}\n";
    files['src/config.js'] =
      "export function readConfig(env) {\n  return { mode: env.CLEW_MODE ?? 'local' };\n}\n";
  }

  for (const [path, content] of Object.entries(files)) {
    const target = join(cwd, path);

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

function setupScenario(scenario) {
  const cwd = mkdtempSync(join(tmpdir(), `clew-126-${scenario.id}-`));

  git(cwd, ['init', '-b', 'main']);
  git(cwd, ['config', 'user.email', 'pilot@example.com']);
  git(cwd, ['config', 'user.name', 'Clew Pilot']);
  writeFixtureFiles(cwd, scenario);
  git(cwd, ['add', '.'], {
    GIT_AUTHOR_DATE: GIT_DATE,
    GIT_COMMITTER_DATE: GIT_DATE,
  });
  git(cwd, ['commit', '-m', `fixture: ${scenario.id}`], {
    GIT_AUTHOR_DATE: GIT_DATE,
    GIT_COMMITTER_DATE: GIT_DATE,
  });

  const store = new Store(join(cwd, '.clew', 'clew.sqlite'));
  const task = {
    id: scenario.taskId,
    projectId: PROJECT_ID,
    title: scenario.title,
    goal: scenario.title,
    profile: scenario.profile,
    risk: 'medium',
    base_ref: 'HEAD',
    acceptance: [
      {
        id: 'AC-1',
        criterion: 'The selected repository context is treated as untrusted input.',
      },
      { id: 'AC-2', criterion: 'The consumer preserves the required verification path.' },
    ],
    verification: [{ command: 'npm', args: ['test'] }],
  };

  store.createProject({
    id: PROJECT_ID,
    name: 'CLEW-126 pilot fixture',
    localPath: cwd,
    repositoryRoot: cwd,
    defaultBranch: 'main',
  });
  store.createTask(task);

  return { cwd, store, task };
}

function outputForScenario(scenario, revision) {
  const ref = (path) => sourceReference(path, revision);

  if (scenario.id === 'local-bug-fix')
    return {
      components: [
        {
          id: 'auth-guard',
          path: 'src/auth.js',
          symbol: 'canRead',
          purpose: 'Applies the local active-user authorization guard.',
          references: [ref('src/auth.js')],
        },
        {
          id: 'auth-test',
          path: 'test/auth.test.js',
          purpose: 'Exercises the authorization guard fixture.',
          references: [ref('test/auth.test.js')],
        },
      ],
      relationships: [],
      checks: [
        {
          kind: 'recommended',
          command: 'node',
          args: ['--check', 'src/auth.js'],
          reason: 'The change is local to one module and has a focused syntax check.',
          references: [ref('src/auth.js')],
        },
      ],
      observations: [
        {
          kind: 'observed',
          statement: 'The focused test imports the guarded module directly.',
          references: [ref('test/auth.test.js')],
        },
      ],
      unknowns: [],
      omissions: [],
    };

  if (scenario.id === 'cross-module-change')
    return {
      components: [
        {
          id: 'order-service',
          path: 'src/orders/service.js',
          symbol: 'placeOrder',
          purpose: 'Coordinates order placement and billing.',
          references: [ref('src/orders/service.js')],
        },
        {
          id: 'billing-client',
          path: 'src/billing/client.js',
          symbol: 'charge',
          purpose: 'Provides the billing boundary consumed by orders.',
          references: [ref('src/billing/client.js')],
        },
        {
          id: 'order-test',
          path: 'test/orders.test.js',
          purpose: 'Checks the cross-module order path.',
          references: [ref('test/orders.test.js')],
        },
      ],
      relationships: [
        {
          sourceComponentId: 'order-service',
          targetComponentId: 'billing-client',
          kind: 'imports',
          description: 'The order service calls the billing client.',
          references: [ref('src/orders/service.js')],
        },
      ],
      checks: [
        {
          kind: 'recommended',
          command: 'npm',
          args: ['test'],
          reason: 'The focused test traverses the order-to-billing relationship.',
          references: [ref('test/orders.test.js')],
        },
      ],
      observations: [
        {
          kind: 'observed',
          statement: 'The order test reaches the billing result through placeOrder.',
          references: [ref('test/orders.test.js')],
        },
      ],
      unknowns: [],
      omissions: [],
    };

  return {
    components: [
      {
        id: 'cli-boundary',
        path: 'src/cli.js',
        symbol: 'configure',
        purpose: 'Maps command configuration into the daemon boundary.',
        references: [ref('src/cli.js')],
      },
      {
        id: 'daemon-boundary',
        path: 'src/daemon.js',
        symbol: 'startDaemon',
        purpose: 'Owns the runtime options once the command delegates.',
        references: [ref('src/daemon.js')],
      },
      {
        id: 'config-reader',
        path: 'src/config.js',
        symbol: 'readConfig',
        purpose: 'Reads the environment-backed configuration.',
        references: [ref('src/config.js')],
      },
    ],
    relationships: [
      {
        sourceComponentId: 'cli-boundary',
        targetComponentId: 'daemon-boundary',
        kind: 'delegates',
        description: 'The command delegates configuration to the daemon.',
        references: [ref('src/cli.js')],
      },
    ],
    checks: [],
    observations: [
      {
        kind: 'observed',
        statement:
          'The command and daemon are linked, but the ownership of configuration is unresolved.',
        references: [ref('src/cli.js'), ref('src/daemon.js')],
      },
      {
        kind: 'inferred',
        statement: 'Configuration may belong at the command boundary or the daemon boundary.',
        references: [],
      },
    ],
    unknowns: [
      {
        question: 'Which module owns the requested configuration change?',
        reason: 'The selected scope exposes two plausible boundaries without a contract decision.',
        references: [ref('src/cli.js'), ref('src/daemon.js')],
      },
    ],
    omissions: [
      {
        reason: 'scope_limit',
        detail: 'The pilot did not inspect callers outside the selected src scope.',
      },
    ],
  };
}

function createScoutRunner(fixture, scenario, calls) {
  return new ScoutRunner({
    cwd: fixture.cwd,
    store: fixture.store,
    config: { scoutEnabled: true, worktreeRoot: fixture.cwd },
    harnessFactory: () => ({
      run: async ({ scoutRequest, cwd }) => {
        const output = outputForScenario(scenario, scoutRequest.repository.revision);

        calls.push({
          cwd,
          request: scoutRequest,
          snapshotRead: output.components.every(
            (component) => readFileSync(join(cwd, component.path), 'utf8').trim().length > 0,
          ),
        });

        return {
          sessionId: `pilot-scout-${scenario.id}`,
          output,
        };
      },
    }),
  });
}

function createWorkspace(fixture) {
  return {
    projectRoot: fixture.cwd,
    root: fixture.cwd,
    createWorktree: (taskId, stageId, attempt) => ({
      path: fixture.cwd,
      branch: `pilot-${stageId}-${attempt}`,
      baseSha: head(fixture.cwd),
    }),
    getWorktreeStatus: () => ({ path: fixture.cwd, sha: head(fixture.cwd), dirty: false }),
  };
}

function createConsumerScheduler(fixture, scoutRunner, captures, scenario) {
  const schedulerOptions = {
    scoutRunner,
    requirePlanApproval: false,
    harnessFactory: () => ({
      run: async (input) => {
        const brief = input.executionBrief;

        captures.push({
          role: brief.role,
          stageId: brief.run.stageId,
          contextId: brief.context.scout?.contextId ?? null,
          sections: brief.context.scout ? Object.keys(brief.context.scout.sections) : [],
          prompt: compileHarnessPrompt(brief),
          brief,
        });

        return new FakeHarness().run(input);
      },
    }),
  };

  if (scenario.profile === 'deep')
    schedulerOptions.architectFactory = () => ({
      createPlan: async ({ executionBrief }) => {
        captures.push({
          role: executionBrief.role,
          stageId: executionBrief.run.stageId,
          contextId: executionBrief.context.scout?.contextId ?? null,
          sections: executionBrief.context.scout
            ? Object.keys(executionBrief.context.scout.sections)
            : [],
          prompt: compileHarnessPrompt(executionBrief),
          brief: executionBrief,
        });

        return {
          parallelizable: false,
          stages: [
            { id: 'worker', kind: 'worker', goal: scenario.title, dependsOn: [] },
            {
              id: 'integration',
              kind: 'integration',
              goal: 'Integrate the worker result',
              dependsOn: ['worker'],
            },
          ],
        };
      },
    });

  return new Scheduler(fixture.store, createWorkspace(fixture), schedulerOptions);
}

async function runPilotScenario(scenario) {
  const fixture = setupScenario(scenario);
  const scoutCalls = [];
  const captures = [];
  const beforeTask = fixture.store.getTask(scenario.taskId);

  try {
    const runner = createScoutRunner(fixture, scenario, scoutCalls);
    const startedAt = performance.now();
    const scout = await runner.run(scenario.taskId, [
      scenario.taskId,
      '--harness',
      'fake',
      '--request-id',
      `pilot-${scenario.id}`,
      '--attempt-id',
      `pilot-${scenario.id}`,
      ...scenario.scopePaths.flatMap((path) => ['--path', path]),
    ]);
    const durationMs = Number((performance.now() - startedAt).toFixed(1));

    assert.equal(scout.status, 'completed');
    assert.equal(scout.context.provenance.status, scenario.mapStatus);
    assert.equal(scout.context.source.scope.paths.join(','), scenario.scopePaths.join(','));
    assert.equal(scoutCalls.length, 1);
    assert.equal(scoutCalls[0].snapshotRead, true);
    assert.equal(scoutCalls[0].request.scope.paths.join(','), scenario.scopePaths.join(','));
    assert.equal(existsSync(join(fixture.cwd, scout.path)), true);
    assert.deepEqual(
      JSON.parse(readFileSync(join(fixture.cwd, scout.path), 'utf8')),
      scout.context,
    );

    const scheduler = createConsumerScheduler(fixture, runner, captures, scenario);
    const runOptions = {
      scoutContext: {
        contextId: scout.contextId,
        sections: scenario.selectedSections,
      },
    };
    const execution = await scheduler.runTask(
      scenario.taskId,
      scenario.profile,
      'fake',
      null,
      scenario.profile === 'deep' ? 'fake' : null,
      null,
      [],
      runOptions,
    );

    assert.equal(execution.state, 'READY');
    assert.deepEqual(
      captures
        .filter((capture) => capture.contextId)
        .map((capture) => `${capture.role}:${capture.stageId}`)
        .sort(),
      scenario.consumers.map((consumer) => `${consumer.role}:${consumer.stageId}`).sort(),
    );
    for (const capture of captures.filter((item) => item.contextId)) {
      assert.equal(capture.contextId, scout.contextId);
      assert.deepEqual(capture.sections, scenario.selectedSections);
      assert.equal(capture.brief.task.acceptance.length, beforeTask.contract.acceptance.length);
      assert.equal(capture.brief.permissions.write, capture.role === 'worker');
      assert.match(capture.prompt, /untrusted data/);
      assert.match(capture.prompt, new RegExp(scout.contextId));
      for (const section of scenario.selectedSections)
        assert.match(capture.prompt, new RegExp(`"${section}"`));
    }

    const preparedBriefs = fixture.store
      .listEvents(scenario.taskId)
      .filter((event) => event.type === 'EXECUTION_BRIEF_PREPARED')
      .map((event) => event.payload.executionBrief)
      .filter((brief) => brief.context.scout?.contextId === scout.contextId);

    assert.equal(preparedBriefs.length, scenario.consumers.length);
    const workerRuns = fixture.store
      .listRuns(scenario.taskId)
      .filter((run) => run.scoutContextId === scout.contextId);
    const expectedWorkerRuns = scenario.consumers.filter((consumer) => consumer.role === 'worker');

    assert.equal(workerRuns.length, expectedWorkerRuns.length);
    for (const run of workerRuns) {
      assert.equal(run.scoutContextChecksum, scout.checksum);
      assert.equal(run.scoutContextRevision, scout.revision);
      assert.deepEqual(run.scoutContextSections, scenario.selectedSections);
    }
    assert.deepEqual(fixture.store.getTask(scenario.taskId).contract, beforeTask.contract);
    const selectedBrief = captures.find((capture) => capture.contextId).brief.context.scout;
    const contextBytes = Buffer.byteLength(JSON.stringify(selectedBrief), 'utf8');

    assert.ok(contextBytes > 0);
    assert.ok(contextBytes <= 16 * 1024);

    return {
      scenario: scenario.id,
      taskId: scenario.taskId,
      contextId: scout.contextId,
      checksum: scout.checksum,
      revision: scout.revision,
      mapPath: scout.path,
      consumers: captures
        .filter((capture) => capture.contextId)
        .map((capture) => ({
          role: capture.role,
          stageId: capture.stageId,
          sections: capture.sections,
        })),
      contextBytes,
      tokenEstimate: Math.ceil(contextBytes / 4),
      scoutDurationMs: durationMs,
      usage: null,
      snapshotRead: scoutCalls[0].snapshotRead,
    };
  } finally {
    fixture.store.close();
    rmSync(fixture.cwd, { recursive: true, force: true });
  }
}

function assertPilotFixture() {
  assert.equal(pilotFixture.schemaVersion, pilotSchema.properties.schemaVersion.const);
  assert.equal(pilotFixture.pilotId, 'CLEW-126');
  assert.equal(pilotFixture.scenarios.length, 3);
  assert.deepEqual(
    pilotFixture.scenarios.map((scenario) => scenario.kind),
    ['local_bug_fix', 'cross_module_change', 'ambiguous_scope'],
  );
  for (const scenario of pilotFixture.scenarios) {
    assert.ok(scenario.selectedSections.length > 0);
    assert.ok(scenario.consumers.length > 0);
    assert.ok(
      scenario.findings.helpful.every((section) => scenario.selectedSections.includes(section)),
    );
    assert.ok(
      scenario.findings.extra.every((section) => scenario.selectedSections.includes(section)),
    );
    assert.equal(scenario.findings.incorrect.length, 0);
    if (scenario.mapStatus === 'partial') {
      assert.ok(scenario.selectedSections.includes('unknowns'));
      assert.ok(scenario.selectedSections.includes('omissions'));
    }
  }
}

test('group 1: three isolated pilot maps are saved and consumed by real architect/worker brief paths', async () => {
  assertPilotFixture();
  const results = [];

  for (const scenario of pilotFixture.scenarios) results.push(await runPilotScenario(scenario));

  assert.equal(results.length, 3);
  assert.ok(results.every((result) => result.contextId.startsWith('scout-')));
  assert.ok(results.every((result) => result.revision.length === 40));
  assert.ok(results.every((result) => result.contextBytes > 0));
  assert.ok(results.every((result) => result.snapshotRead));

  if (process.env.CLEW_PILOT_REPORT === '1')
    console.log(`CLEW-126 pilot evidence: ${JSON.stringify(results)}`);
});

test('group 2: pilot consumers preserve freshness, source evidence, and mandatory Task criteria', async () => {
  const scenario = pilotFixture.scenarios[1];
  const fixture = setupScenario(scenario);
  const scoutCalls = [];
  let worktreeCalls = 0;

  try {
    const runner = createScoutRunner(fixture, scenario, scoutCalls);
    const scout = await runner.run(scenario.taskId, [
      scenario.taskId,
      '--harness',
      'fake',
      '--request-id',
      'freshness-request',
      '--attempt-id',
      'freshness-attempt',
      ...scenario.scopePaths.flatMap((path) => ['--path', path]),
    ]);
    const captures = [];
    const scheduler = createConsumerScheduler(fixture, runner, captures, scenario);
    const workspace = scheduler.workspaceManager;
    const originalCreateWorktree = workspace.createWorktree;

    workspace.createWorktree = (...args) => {
      worktreeCalls += 1;

      return originalCreateWorktree(...args);
    };
    const originalContract = fixture.store.getTask(scenario.taskId).contract;

    fixture.store.db
      .prepare('UPDATE tasks SET contract=? WHERE id=?')
      .run(
        JSON.stringify({ ...originalContract, goal: 'Changed after the scout run' }),
        scenario.taskId,
      );
    await assert.rejects(
      () =>
        scheduler.runTask(scenario.taskId, 'standard', 'fake', null, null, null, [], {
          scoutContext: { contextId: scout.contextId, sections: scenario.selectedSections },
        }),
      /scout context .* is stale: contractFingerprint changed/,
    );
    assert.equal(worktreeCalls, 0);

    fixture.store.db
      .prepare('UPDATE tasks SET contract=? WHERE id=?')
      .run(JSON.stringify(originalContract), scenario.taskId);
    const context = scout.context;
    const allReferences = [
      ...context.components.flatMap((component) => component.references),
      ...context.relationships.flatMap((relationship) => relationship.references),
      ...context.checks.flatMap((check) => check.references),
      ...context.observations.flatMap((observation) => observation.references),
    ];

    assert.ok(allReferences.length > 0);
    assert.ok(allReferences.every((reference) => reference.revision === scout.revision));
    assert.ok(allReferences.every((reference) => !reference.path.startsWith('/')));

    const noScoutFixture = setupScenario(scenario);

    try {
      const noScoutCaptures = [];
      const noScoutRunner = createScoutRunner(noScoutFixture, scenario, []);
      const noScoutScheduler = createConsumerScheduler(
        noScoutFixture,
        noScoutRunner,
        noScoutCaptures,
        scenario,
      );
      const noScoutResult = await noScoutScheduler.runTask(
        scenario.taskId,
        'standard',
        'fake',
        null,
        null,
        null,
        [],
        { scoutContext: { skip: true } },
      );

      assert.equal(noScoutResult.state, 'READY');
      assert.equal(noScoutCaptures.filter((capture) => capture.contextId).length, 0);
      assert.equal(noScoutFixture.store.listRuns(scenario.taskId)[0].scoutContextId, null);
    } finally {
      noScoutFixture.store.close();
      rmSync(noScoutFixture.cwd, { recursive: true, force: true });
    }
  } finally {
    fixture.store.close();
    rmSync(fixture.cwd, { recursive: true, force: true });
  }
});

test('group 3: the pilot fixture freezes the downstream checkpoint and role-brief decisions', () => {
  assert.equal(pilotSchema.properties.scenarios.maxItems, 3);
  assert.equal(pilotSchema.$defs.findings.required.includes('decision'), true);
  const report = readFileSync(join(projectRoot, 'docs/CLEW-126-REPORT.md'), 'utf8');
  const checkpointCard = readFileSync(join(projectRoot, 'tasks/CLEW-114.md'), 'utf8');
  const roleBriefCard = readFileSync(join(projectRoot, 'tasks/CLEW-115.md'), 'utf8');

  assert.match(report, /PILOT-LOCAL-FIX/);
  assert.match(report, /Scheduler.*Execution Brief/);
  assert.match(report, /Provider usage.*null/);
  assert.match(report, /benchmark/i);
  assert.match(checkpointCard, /RepositoryContext IDs/);
  assert.match(roleBriefCard, /context IDs, checksums, source revisions/);
  assert.match(roleBriefCard, /repository context и накопленный progress/i);
});
