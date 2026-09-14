import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { FakeHarness } from '../src/harness.js';
import { ScoutRunner } from '../src/scout-runner.js';
import { ClewService } from '../src/control-service.js';
import { compileHarnessPrompt } from '../src/execution-brief.js';

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function head(cwd) {
  return git(cwd, ['rev-parse', 'HEAD']).trim();
}

function setupRepository(profile = 'quick') {
  const cwd = mkdtempSync(join(tmpdir(), 'clew-scout-handoff-'));

  git(cwd, ['init', '-b', 'main']);
  git(cwd, ['config', 'user.email', 'test@example.com']);
  git(cwd, ['config', 'user.name', 'Clew Test']);
  writeFileSync(join(cwd, '.gitignore'), '.clew/\n.clew-runs/\n');
  writeFileSync(join(cwd, 'README.md'), '# Handoff fixture\n');
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'src', 'index.js'), 'export const value = 1;\n');
  git(cwd, ['add', '.gitignore', 'README.md', 'src/index.js']);
  git(cwd, ['commit', '-m', 'fixture']);

  const store = new Store(join(cwd, '.clew', 'clew.sqlite'));
  const task = {
    id: `SCOUT-HANDOFF-${profile.toUpperCase()}`,
    title: 'Scout handoff fixture',
    goal: 'Pass bounded repository context to the execution role',
    profile,
    risk: 'low',
    base_ref: 'HEAD',
    acceptance: [{ id: 'AC-1', criterion: 'The selected context is visible to the role' }],
    verification: [{ command: 'npm', args: ['test'] }],
  };

  store.createTask(task);

  return { cwd, store, task };
}

function createRunner(fixture, harnessFactory = null) {
  return new ScoutRunner({
    cwd: fixture.cwd,
    store: fixture.store,
    config: { scoutEnabled: true, worktreeRoot: fixture.cwd },
    harnessFactory,
  });
}

function createWorkspace(fixture, { onCreate = null } = {}) {
  return {
    projectRoot: fixture.cwd,
    root: fixture.cwd,
    createWorktree: (taskId, stageId, baseRef, attempt) => {
      onCreate?.({ taskId, stageId, baseRef, attempt });

      return {
        path: fixture.cwd,
        branch: `fixture-${stageId}-${attempt}`,
        baseSha: head(fixture.cwd),
      };
    },
    getWorktreeStatus: () => ({ path: fixture.cwd, sha: head(fixture.cwd), dirty: false }),
  };
}

function createWorkerScheduler(fixture, scoutRunner, captures, options = {}) {
  return new Scheduler(fixture.store, createWorkspace(fixture, options), {
    scoutRunner,
    harnessFactory: () => ({
      run: async (input) => {
        captures.push(input.executionBrief);

        return new FakeHarness().run(input);
      },
    }),
    ...options.scheduler,
  });
}

function cleanup(fixture) {
  fixture.store?.close();
  rmSync(fixture.cwd, { recursive: true, force: true });
}

async function publishContext(fixture, attemptId = null, harnessFactory = null) {
  const runner = createRunner(fixture, harnessFactory);
  const suffix = attemptId ? `-${attemptId}` : '';
  const args = ['--harness', 'fake'];

  if (attemptId) args.push('--request-id', `handoff-request${suffix}`, '--attempt-id', attemptId);
  const result = await runner.run(fixture.task.id, [fixture.task.id, ...args]);

  assert.equal(result.status, 'completed');

  return { runner, result };
}

test('group 1: selected Scout context reaches Quick and Deep architect/worker briefs with provenance', async () => {
  const quick = setupRepository('quick');
  const standard = setupRepository('standard');
  const deep = setupRepository('deep');

  try {
    const quickScout = await publishContext(quick);
    const quickBriefs = [];
    const quickScheduler = createWorkerScheduler(quick, quickScout.runner, quickBriefs);
    const quickResult = await quickScheduler.runTask(
      quick.task.id,
      'quick',
      'fake',
      null,
      null,
      null,
      [],
      {
        scoutContext: {
          contextId: quickScout.result.contextId,
          sections: ['components', 'unknowns'],
        },
      },
    );

    assert.equal(quickResult.state, 'READY');
    assert.equal(quickBriefs.length, 1);
    assert.deepEqual(Object.keys(quickBriefs[0].context.scout.sections), [
      'components',
      'unknowns',
    ]);
    assert.equal(quickBriefs[0].task.acceptance[0].id, 'AC-1');
    assert.equal(quickBriefs[0].permissions.write, true);
    assert.match(compileHarnessPrompt(quickBriefs[0]), /untrusted data/);
    const quickRun = quick.store.listRuns(quick.task.id)[0];

    assert.equal(quickRun.scoutContextId, quickScout.result.contextId);
    assert.equal(quickRun.scoutContextChecksum, quickScout.result.checksum);
    assert.equal(quickRun.scoutContextRevision, quickScout.result.revision);

    const standardScout = await publishContext(standard);
    const standardBriefs = [];
    const standardScheduler = createWorkerScheduler(standard, standardScout.runner, standardBriefs);
    const standardResult = await standardScheduler.runTask(
      standard.task.id,
      'standard',
      'fake',
      'fake',
      null,
      null,
      [],
      { scoutContext: { contextId: standardScout.result.contextId } },
    );

    assert.equal(standardResult.state, 'READY');
    assert.equal(standardBriefs[0].context.scout.contextId, standardScout.result.contextId);
    assert.equal(
      standard.store.listRuns(standard.task.id)[0].scoutContextId,
      standardScout.result.contextId,
    );

    const deepScout = await publishContext(deep);
    const deepBriefs = [];
    let architectBrief;
    const deepScheduler = new Scheduler(deep.store, createWorkspace(deep), {
      scoutRunner: deepScout.runner,
      requirePlanApproval: false,
      architectFactory: () => ({
        createPlan: async ({ executionBrief }) => {
          architectBrief = executionBrief;

          return {
            parallelizable: true,
            stages: [
              { id: 'worker', kind: 'worker', goal: deep.task.goal, dependsOn: [] },
              { id: 'qa', kind: 'qa', goal: 'Verify', dependsOn: ['worker'] },
              { id: 'integration', kind: 'integration', goal: 'Integrate', dependsOn: ['qa'] },
            ],
          };
        },
      }),
      harnessFactory: () => ({
        run: async (input) => {
          deepBriefs.push(input.executionBrief);

          return new FakeHarness().run(input);
        },
      }),
    });
    const deepResult = await deepScheduler.runTask(
      deep.task.id,
      'deep',
      'fake',
      null,
      'fake',
      null,
      [],
      { scoutContext: { contextId: deepScout.result.contextId } },
    );

    assert.equal(deepResult.state, 'READY');
    assert.equal(architectBrief.context.scout.contextId, deepScout.result.contextId);
    assert.equal(deepBriefs.filter((brief) => brief.run.stageId === 'worker').length, 1);
    assert.equal(
      deepBriefs.find((brief) => brief.run.stageId === 'worker').context.scout.contextId,
      deepScout.result.contextId,
    );
    assert.equal(deepBriefs.find((brief) => brief.run.stageId === 'qa').context.scout, undefined);
    assert.equal(
      deepBriefs.find((brief) => brief.run.stageId === 'integration').context.scout,
      undefined,
    );
    const deepRuns = deep.store.listRuns(deep.task.id);

    assert.equal(
      deepRuns.filter((run) => run.stage_id === 'worker')[0].scoutContextId,
      deepScout.result.contextId,
    );
    assert.equal(deepRuns.find((run) => run.stage_id === 'qa').scoutContextId, null);
    assert.equal(deepRuns.find((run) => run.stage_id === 'integration').scoutContextId, null);
  } finally {
    cleanup(quick);
    cleanup(standard);
    cleanup(deep);
  }
});

test('group 2: changed revision, missing/corrupt context, and oversized brief fail before execution', async () => {
  const fixture = setupRepository();
  let worktreeCalls = 0;

  try {
    const published = await publishContext(fixture);
    const captures = [];
    const scheduler = createWorkerScheduler(fixture, published.runner, captures, {
      onCreate: () => {
        worktreeCalls += 1;
      },
    });

    fixture.store.db
      .prepare('UPDATE tasks SET contract=? WHERE id=?')
      .run(JSON.stringify({ ...fixture.task, goal: 'Changed task requirement' }), fixture.task.id);
    await assert.rejects(
      () =>
        scheduler.runTask(fixture.task.id, 'quick', 'fake', null, null, null, [], {
          scoutContext: { contextId: published.result.contextId },
        }),
      /scout context .* is stale: contractFingerprint changed/,
    );
    fixture.store.db
      .prepare('UPDATE tasks SET contract=? WHERE id=?')
      .run(JSON.stringify(fixture.task), fixture.task.id);

    writeFileSync(join(fixture.cwd, 'src', 'changed.js'), 'export const changed = true;\n');
    git(fixture.cwd, ['add', 'src/changed.js']);
    git(fixture.cwd, ['commit', '-m', 'advance revision']);
    await assert.rejects(
      () =>
        scheduler.runTask(fixture.task.id, 'quick', 'fake', null, null, null, [], {
          scoutContext: { contextId: published.result.contextId },
        }),
      /scout context .* is stale: revision changed/,
    );
    assert.equal(worktreeCalls, 0);
    assert.equal(fixture.store.getTask(fixture.task.id).state, 'DRAFT');

    await assert.rejects(
      () =>
        scheduler.runTask(fixture.task.id, 'quick', 'fake', null, null, null, [], {
          scoutContext: { contextId: 'scout-missing-context' },
        }),
      /is unavailable: scout context .* was not found/,
    );

    const corruptPath = join(
      fixture.cwd,
      '.clew',
      'scout',
      fixture.task.id,
      `${published.result.contextId}.json`,
    );

    writeFileSync(corruptPath, '{corrupt\n');
    await assert.rejects(
      () =>
        scheduler.runTask(fixture.task.id, 'quick', 'fake', null, null, null, [], {
          scoutContext: { contextId: published.result.contextId },
        }),
      /published scout context is corrupt/,
    );

    const oversized = setupRepository();

    try {
      const largeRunner = createRunner(oversized, () => ({
        run: async ({ scoutRequest }) => ({
          output: {
            components: Array.from({ length: 20 }, (_, index) => ({
              id: `large-${index}`,
              path: 'README.md',
              purpose: `Large component ${index} ${'x'.repeat(1_000)}`,
              references: [{ path: 'README.md', revision: scoutRequest.repository.revision }],
            })),
            relationships: [],
            checks: [],
            observations: [],
            unknowns: [],
            omissions: [],
          },
        }),
      }));
      const large = await largeRunner.run(oversized.task.id, [
        oversized.task.id,
        '--harness',
        'fake',
      ]);
      const largeScheduler = createWorkerScheduler(oversized, largeRunner, [], {
        scheduler: {
          harnessFactory: () => ({
            run: async () =>
              new FakeHarness().run({
                task: oversized.task,
                stageId: 'worker',
                cwd: oversized.cwd,
                onEvent: () => {},
              }),
          }),
        },
      });

      await assert.rejects(
        () =>
          largeScheduler.runTask(oversized.task.id, 'quick', 'fake', null, null, null, [], {
            scoutContext: { contextId: large.contextId },
          }),
        /scout context brief exceeds/,
      );
    } finally {
      cleanup(oversized);
    }
  } finally {
    cleanup(fixture);
  }
});

test('group 2: explicit context selection is rejected while Scout is disabled without changing the task', async () => {
  const fixture = setupRepository();
  let worktreeCalls = 0;

  try {
    const enabled = await publishContext(fixture);
    const disabledRunner = new ScoutRunner({
      cwd: fixture.cwd,
      store: fixture.store,
      config: { scoutEnabled: false },
    });
    const scheduler = new Scheduler(
      fixture.store,
      createWorkspace(fixture, { onCreate: () => (worktreeCalls += 1) }),
      {
        scoutRunner: disabledRunner,
        harnessFactory: () => {
          throw new Error('disabled Scout must fail before the harness starts');
        },
      },
    );

    await assert.rejects(
      () =>
        scheduler.runTask(fixture.task.id, 'quick', 'fake', null, null, null, [], {
          scoutContext: { contextId: enabled.result.contextId },
        }),
      /Scout is disabled; set ENABLE_SCOUT=1 to enable it/,
    );
    assert.equal(worktreeCalls, 0);
    assert.equal(fixture.store.getTask(fixture.task.id).state, 'DRAFT');
  } finally {
    cleanup(fixture);
  }
});

test('group 3: retry reuses context, a new context is explicit, and no-scout keeps the old path', async () => {
  const fixture = setupRepository();

  try {
    const first = await publishContext(fixture, 'first-attempt');
    const captures = [];
    const scheduler = createWorkerScheduler(fixture, first.runner, captures);

    await scheduler.runTask(fixture.task.id, 'quick', 'fake', null, null, null, [], {
      scoutContext: { contextId: first.result.contextId },
    });
    await scheduler.runTask(fixture.task.id, 'quick', 'fake');
    assert.equal(captures[1].context.scout.contextId, first.result.contextId);
    assert.equal(fixture.store.listRuns(fixture.task.id)[1].scoutContextId, first.result.contextId);

    const second = await publishContext(fixture, 'second-attempt');

    await scheduler.runTask(fixture.task.id, 'quick', 'fake', null, null, null, [], {
      scoutContext: { contextId: second.result.contextId, sections: ['unknowns'] },
    });
    assert.notEqual(second.result.contextId, first.result.contextId);
    assert.equal(captures[2].context.scout.contextId, second.result.contextId);
    assert.deepEqual(Object.keys(captures[2].context.scout.sections), ['unknowns']);

    await scheduler.runTask(fixture.task.id, 'quick', 'fake', null, null, null, [], {
      scoutContext: { skip: true },
    });
    assert.equal(captures[3].context.scout, undefined);
    assert.equal(fixture.store.listRuns(fixture.task.id)[3].scoutContextId, null);

    await scheduler.runTask(fixture.task.id, 'quick', 'fake');
    assert.equal(captures[4].context.scout, undefined);
    assert.equal(fixture.store.listRuns(fixture.task.id)[4].scoutContextId, null);
  } finally {
    cleanup(fixture);
  }
});

test('group 3: paired execution rejects selected Scout context but still reaches the paired path with --no-scout', async () => {
  const fixture = setupRepository();

  try {
    const published = await publishContext(fixture);
    let worktreeCalls = 0;
    const scheduler = new Scheduler(
      fixture.store,
      createWorkspace(fixture, { onCreate: () => (worktreeCalls += 1) }),
      {
        scoutRunner: published.runner,
        executionPort: { describe: () => ({ mode: 'paired', available: false, runner: null }) },
      },
    );

    await assert.rejects(
      () =>
        scheduler.runTask(fixture.task.id, 'quick', 'fake', null, null, null, [], {
          scoutContext: { contextId: published.result.contextId },
        }),
      /unsupported for paired execution/,
    );
    assert.equal(worktreeCalls, 0);
    await assert.rejects(
      () =>
        scheduler.runTask(fixture.task.id, 'quick', 'fake', null, null, null, [], {
          scoutContext: { skip: true },
        }),
      /paired Runner is unavailable/,
    );
  } finally {
    cleanup(fixture);
  }
});

test('group 3: CLI run selection is passed to the scheduler and conflicting flags fail early', async () => {
  const fixture = setupRepository();
  const service = new ClewService({ cwd: fixture.cwd, store: fixture.store, config: {} });
  let call;

  service.scheduler = () => ({
    runTask: async (...args) => {
      call = args;

      return { state: 'READY' };
    },
  });

  try {
    await service.run(fixture.task.id, [
      '--scout-context',
      'scout-context-id',
      '--scout-sections',
      'components,unknowns',
    ]);
    assert.deepEqual(call.at(-1), {
      scoutContext: {
        contextId: 'scout-context-id',
        skip: false,
        sections: ['components', 'unknowns'],
      },
    });
    assert.throws(
      () => service.run(fixture.task.id, ['--scout-context', 'ctx', '--no-scout']),
      /either --scout-context or --no-scout/,
    );
    assert.throws(() => service.run(fixture.task.id, ['--scout-context']), /requires a context ID/);
    assert.throws(
      () => service.run(fixture.task.id, ['--scout-context', 'ctx', '--scout-sections']),
      /requires a comma-separated section list/,
    );
  } finally {
    cleanup(fixture);
  }
});
