import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { CodexReviewer } from '../src/review.js';
import { CodexHarness } from '../src/harness.js';
import { GitWorktreeManager, IntegrationConflictError } from '../src/workspace.js';

function runGitCommand(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('runs a quick task with a fake workspace and records evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-scheduler-'));
  const store = new Store(join(dir, 'state.sqlite'));
  const workspaceManager = {
    createWorktree: () => ({ path: dir, branch: 'test', baseSha: 'abc' }),
    getWorktreeStatus: () => ({ path: dir, sha: 'abc', dirty: false }),
  };
  store.createTask({
    id: 'T-2',
    title: 'Run',
    goal: 'Run',
    profile: 'quick',
    acceptance: [{ id: 'AC-1', criterion: 'works' }],
  });
  const result = await new Scheduler(store, workspaceManager).runTask('T-2', 'quick', 'fake');
  assert.equal(result.state, 'READY');
  assert.equal(store.listRuns('T-2')[0].status, 'COMPLETED');
  assert.ok(store.listEvents('T-2').some((event) => event.type === 'VERIFICATION_RECORDED'));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('runs standard profile through a review decision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-standard-'));
  const store = new Store(join(dir, 'state.sqlite'));
  const workspaceManager = {
    createWorktree: () => ({ path: dir, branch: 'test', baseSha: 'abc' }),
    getWorktreeStatus: () => ({ path: dir, sha: 'abc', dirty: false }),
  };
  store.createTask({
    id: 'T-4',
    title: 'Review',
    goal: 'Review',
    profile: 'standard',
    acceptance: [{ id: 'AC-1', criterion: 'works' }],
  });
  const result = await new Scheduler(store, workspaceManager).runTask('T-4', 'standard', 'fake');
  assert.equal(result.state, 'READY');
  assert.ok(store.listEvents('T-4').some((event) => event.type === 'REVIEW_RECORDED'));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('routes blocking review findings into bounded retries', async () => {
  const previous = process.env.CLEW_FAKE_REVIEW;
  process.env.CLEW_FAKE_REVIEW = 'request_changes';
  const dir = mkdtempSync(join(tmpdir(), 'clew-retry-'));
  const store = new Store(join(dir, 'state.sqlite'));
  const workspaceManager = {
    createWorktree: () => ({ path: dir, branch: 'test', baseSha: 'abc' }),
    getWorktreeStatus: () => ({ path: dir, sha: 'abc', dirty: false }),
  };
  store.createTask({
    id: 'T-5',
    title: 'Retry',
    goal: 'Retry',
    profile: 'standard',
    acceptance: [{ id: 'AC-1', criterion: 'works' }],
  });
  const result = await new Scheduler(store, workspaceManager).runTask('T-5', 'standard', 'fake');
  assert.equal(result.state, 'FAILED');
  assert.equal(store.listRuns('T-5').length, 3);
  assert.equal(
    store.listEvents('T-5').filter((event) => event.type === 'RETRY_SCHEDULED').length,
    2,
  );
  store.close();
  rmSync(dir, { recursive: true, force: true });
  if (previous === undefined) delete process.env.CLEW_FAKE_REVIEW;
  else process.env.CLEW_FAKE_REVIEW = previous;
});

test('runs deep profile through planned worker and integration stages', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-deep-'));
  const store = new Store(join(dir, 'state.sqlite'));
  const workspaceManager = {
    createWorktree: (_task, stage) => ({ path: dir, branch: `test-${stage}`, baseSha: 'abc' }),
    getWorktreeStatus: () => ({ path: dir, sha: 'abc', dirty: false }),
  };
  store.createTask({
    id: 'T-6',
    title: 'Deep',
    goal: 'Deep',
    profile: 'deep',
    acceptance: [{ id: 'AC-1', criterion: 'works' }],
  });
  const result = await new Scheduler(store, workspaceManager, {
    requirePlanApproval: false,
  }).runTask('T-6', 'deep', 'fake');
  assert.equal(result.state, 'READY');
  assert.deepEqual(
    store.listStages('T-6').map((stage) => stage.id),
    ['backend', 'frontend', 'integration'],
  );
  assert.ok(store.listEvents('T-6').some((event) => event.type === 'INTEGRATION_COMPLETED'));
  assert.equal(store.listRuns('T-6').length, 3);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('requires an audited human approval before Deep execution', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-approval-'));
  const store = new Store(join(dir, 'state.sqlite'));
  let allocatedWorktrees = 0;
  const workspaceManager = {
    createWorktree: (_task, stage) => {
      allocatedWorktrees += 1;
      return { path: dir, branch: `test-${stage}`, baseSha: 'abc' };
    },
    getWorktreeStatus: () => ({ path: dir, sha: 'abc', dirty: false }),
  };
  store.createTask({
    id: 'T-20',
    title: 'Approval',
    goal: 'Approval',
    profile: 'deep',
    acceptance: [{ id: 'AC-1', criterion: 'works' }],
  });
  const scheduler = new Scheduler(store, workspaceManager);

  const waitingResult = await scheduler.runTask('T-20', 'deep', 'fake');

  assert.equal(waitingResult.state, 'WAITING_FOR_HUMAN');
  assert.equal(waitingResult.attention, 'PLAN_APPROVAL_REQUIRED');
  assert.equal(store.getLatestPlan('T-20').status, 'PENDING_APPROVAL');
  assert.equal(store.listRuns('T-20').length, 0);
  assert.equal(allocatedWorktrees, 0);

  store.decideLatestPlan('T-20', 'APPROVED', { actor: 'fixture-user' });
  const completedResult = await scheduler.runTask('T-20', 'deep', 'fake');

  assert.equal(completedResult.state, 'READY');
  assert.equal(store.getLatestPlan('T-20').status, 'APPROVED');
  assert.equal(store.listApprovals('T-20')[0].actor, 'fixture-user');
  assert.equal(store.listRuns('T-20').length, 3);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('rejected Deep plans are replaced by a new approval-gated version', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-rejected-plan-'));
  const store = new Store(join(dir, 'state.sqlite'));
  const workspaceManager = {
    createWorktree: () => {
      throw new Error('a rejected or pending plan must not allocate worktrees');
    },
  };
  store.createTask({
    id: 'T-21',
    title: 'Rejected plan',
    goal: 'Rejected plan',
    profile: 'deep',
    acceptance: [{ id: 'AC-1', criterion: 'works' }],
  });
  const scheduler = new Scheduler(store, workspaceManager);
  await scheduler.runTask('T-21', 'deep', 'fake');
  store.decideLatestPlan('T-21', 'REJECTED', {
    actor: 'fixture-user',
    reason: 'Split the work differently',
  });

  const result = await scheduler.runTask('T-21', 'deep', 'fake');

  assert.equal(result.state, 'WAITING_FOR_HUMAN');
  assert.equal(store.getLatestPlan('T-21').version, 2);
  assert.equal(store.getLatestPlan('T-21').status, 'PENDING_APPROVAL');
  assert.equal(store.listApprovals('T-21')[0].decision, 'REJECTED');
  assert.equal(store.listRuns('T-21').length, 0);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('runs independent deep stages concurrently before integration', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-concurrency-'));
  const store = new Store(join(dir, 'state.sqlite'));
  let active = 0;
  let maxActive = 0;
  const harness = {
    run: async ({ stageId }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, stageId === 'integration' ? 5 : 30));
      active -= 1;
      return { sessionId: `session-${stageId}`, verification: [{ result: 'passed' }] };
    },
  };
  const workspaceManager = {
    createWorktree: (_task, stage) => ({ path: dir, branch: `test-${stage}`, baseSha: 'abc' }),
    getWorktreeStatus: () => ({ path: dir, sha: 'abc', dirty: false }),
  };
  store.createTask({
    id: 'T-9',
    title: 'Parallel',
    goal: 'Parallel',
    profile: 'deep',
    acceptance: [{ id: 'AC-1', criterion: 'works' }],
  });
  const scheduler = new Scheduler(store, workspaceManager, {
    harnessFactory: () => harness,
    requirePlanApproval: false,
  });
  const result = await scheduler.runTask('T-9', 'deep', 'fake');
  assert.equal(result.state, 'READY');
  assert.equal(maxActive, 2);
  const events = store.listEvents('T-9');
  const integrationStart = events.findIndex((event) => event.type === 'INTEGRATION_STARTED');
  const workerCompletions = events
    .map((event, index) => ({ event, index }))
    .filter(
      ({ event }) => event.type === 'STAGE_STATE_CHANGED' && event.payload.status === 'COMPLETED',
    );
  assert.ok(
    workerCompletions
      .filter(({ event }) => event.payload.stageId !== 'integration')
      .every(({ index }) => index < integrationStart),
  );
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('blocks integration when a parallel dependency fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-blocked-'));
  const store = new Store(join(dir, 'state.sqlite'));
  const harness = {
    run: async ({ stageId }) => {
      if (stageId === 'frontend') throw new Error('frontend failed');
      return { sessionId: `session-${stageId}`, verification: [{ result: 'passed' }] };
    },
  };
  const workspaceManager = {
    createWorktree: (_task, stage) => ({ path: dir, branch: `test-${stage}`, baseSha: 'abc' }),
    getWorktreeStatus: () => ({ path: dir, sha: 'abc', dirty: false }),
  };
  store.createTask({
    id: 'T-10',
    title: 'Blocked',
    goal: 'Blocked',
    profile: 'deep',
    acceptance: [{ id: 'AC-1', criterion: 'works' }],
  });
  const scheduler = new Scheduler(store, workspaceManager, {
    harnessFactory: () => harness,
    requirePlanApproval: false,
  });
  await assert.rejects(() => scheduler.runTask('T-10', 'deep', 'fake'), /plan stages failed/);
  assert.equal(store.getTask('T-10').state, 'FAILED');
  assert.equal(
    store.listStages('T-10').find((stage) => stage.id === 'integration').status,
    'BLOCKED',
  );
  assert.equal(
    store.listRuns('T-10').some((run) => run.stage_id === 'integration'),
    false,
  );
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('runs an arbitrary multi-level DAG in dependency order', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-dag-'));
  const store = new Store(join(dir, 'state.sqlite'));
  const started = [];
  const completed = [];
  const harness = {
    run: async ({ stageId }) => {
      started.push(stageId);
      await new Promise((resolve) => setTimeout(resolve, 5));
      completed.push(stageId);
      return { sessionId: `session-${stageId}`, verification: [{ result: 'passed' }] };
    },
  };
  const workspaceManager = {
    createWorktree: (_task, stage) => ({
      path: dir,
      branch: `test-${stage}`,
      baseSha: 'abc',
    }),
    getWorktreeStatus: () => ({ path: dir, sha: 'abc', dirty: false }),
  };
  const planFactory = () => ({
    parallelizable: true,
    stages: [
      { id: 'foundation', goal: 'Foundation', dependsOn: [] },
      { id: 'api', goal: 'API', dependsOn: ['foundation'] },
      { id: 'ui', goal: 'UI', dependsOn: ['foundation'] },
      { id: 'docs', goal: 'Docs', dependsOn: ['api'] },
      {
        id: 'integration',
        kind: 'integration',
        goal: 'Integration',
        dependsOn: ['ui', 'docs'],
      },
    ],
  });
  store.createTask({
    id: 'T-13',
    title: 'DAG',
    goal: 'DAG',
    profile: 'deep',
    acceptance: [{ id: 'AC-1', criterion: 'works' }],
  });
  const scheduler = new Scheduler(store, workspaceManager, {
    harnessFactory: () => harness,
    planFactory,
    requirePlanApproval: false,
  });

  const result = await scheduler.runTask('T-13', 'deep', 'fake');

  assert.equal(result.state, 'READY');
  assert.equal(started[0], 'foundation');
  assert.ok(started.indexOf('api') > completed.indexOf('foundation'));
  assert.ok(started.indexOf('ui') > completed.indexOf('foundation'));
  assert.ok(started.indexOf('docs') > completed.indexOf('api'));
  assert.equal(started.at(-1), 'integration');
  assert.equal(store.listRuns('T-13').length, 5);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('enforces the Deep profile worker concurrency limit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-limit-'));
  const store = new Store(join(dir, 'state.sqlite'));
  let active = 0;
  let maxActive = 0;
  const harness = {
    run: async ({ stageId }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, stageId === 'integration' ? 1 : 15));
      active -= 1;
      return { sessionId: `session-${stageId}`, verification: [{ result: 'passed' }] };
    },
  };
  const workspaceManager = {
    createWorktree: (_task, stage) => ({
      path: dir,
      branch: `test-${stage}`,
      baseSha: 'abc',
    }),
    getWorktreeStatus: () => ({ path: dir, sha: 'abc', dirty: false }),
  };
  const workerIds = ['worker-a', 'worker-b', 'worker-c', 'worker-d', 'worker-e'];
  const planFactory = () => ({
    parallelizable: true,
    stages: [
      ...workerIds.map((id) => ({ id, goal: id, dependsOn: [] })),
      {
        id: 'integration',
        kind: 'integration',
        goal: 'Integration',
        dependsOn: workerIds,
      },
    ],
  });
  store.createTask({
    id: 'T-14',
    title: 'Limit',
    goal: 'Limit',
    profile: 'deep',
    acceptance: [{ id: 'AC-1', criterion: 'works' }],
  });
  const scheduler = new Scheduler(store, workspaceManager, {
    harnessFactory: () => harness,
    planFactory,
    requirePlanApproval: false,
  });

  const result = await scheduler.runTask('T-14', 'deep', 'fake');

  assert.equal(result.state, 'READY');
  assert.equal(maxActive, 3);
  assert.equal(store.listRuns('T-14').length, 6);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('carries transitive stage commits into the integration worktree', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'clew-dag-git-'));
  const stateDir = join(repo, '.clew');
  let store;
  try {
    runGitCommand(['init', '-b', 'main'], repo);
    runGitCommand(['config', 'user.email', 'test@example.com'], repo);
    runGitCommand(['config', 'user.name', 'Clew Test'], repo);
    writeFileSync(join(repo, 'README.md'), 'fixture\n');
    runGitCommand(['add', 'README.md'], repo);
    runGitCommand(['commit', '-m', 'fixture'], repo);
    store = new Store(join(stateDir, 'state.sqlite'));
    const workspaceManager = new GitWorktreeManager(join(stateDir, 'worktrees'), repo);
    const planFactory = () => ({
      parallelizable: true,
      stages: [
        { id: 'foundation', goal: 'Foundation', dependsOn: [] },
        { id: 'feature', goal: 'Feature', dependsOn: ['foundation'] },
        {
          id: 'integration',
          kind: 'integration',
          goal: 'Integration',
          dependsOn: ['feature'],
        },
      ],
    });
    store.createTask({
      id: 'T-15',
      title: 'Git DAG',
      goal: 'Git DAG',
      profile: 'deep',
      base_ref: 'main',
      acceptance: [{ id: 'AC-1', criterion: 'works' }],
    });
    const scheduler = new Scheduler(store, workspaceManager, {
      planFactory,
      requirePlanApproval: false,
    });

    const result = await scheduler.runTask('T-15', 'deep', 'fake');

    assert.equal(result.state, 'READY');
    const integrationRun = store.listRuns('T-15').find((run) => run.stage_id === 'integration');
    assert.equal(
      readFileSync(join(integrationRun.workspace, '.clew-runs', 'foundation.log'), 'utf8'),
      'T-15/foundation\n',
    );
    assert.equal(
      readFileSync(join(integrationRun.workspace, '.clew-runs', 'feature.log'), 'utf8'),
      'T-15/feature\n',
    );
    assert.equal(
      readFileSync(join(integrationRun.workspace, '.clew-runs', 'integration.log'), 'utf8'),
      'T-15/integration\n',
    );
  } finally {
    store?.close();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('records an integration conflict as an explicit failed stage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-scheduler-conflict-'));
  const store = new Store(join(dir, 'state.sqlite'));
  const workspaceManager = {
    createWorktree: (_task, stage) => ({
      path: dir,
      branch: `test-${stage}`,
      baseSha: 'abc',
    }),
    getWorktreeStatus: () => ({ path: dir, sha: 'abc', dirty: false }),
    integrateCommits: () => {
      throw new IntegrationConflictError('deadbeef', 'fixture conflict');
    },
  };
  store.createTask({
    id: 'T-16',
    title: 'Conflict',
    goal: 'Conflict',
    profile: 'deep',
    acceptance: [{ id: 'AC-1', criterion: 'works' }],
  });
  const scheduler = new Scheduler(store, workspaceManager, { requirePlanApproval: false });

  await assert.rejects(() => scheduler.runTask('T-16', 'deep', 'fake'), /plan stages failed/);

  assert.equal(store.getTask('T-16').state, 'FAILED');
  assert.equal(
    store.listStages('T-16').find((stage) => stage.id === 'integration').status,
    'FAILED',
  );
  assert.ok(store.listEvents('T-16').some((event) => event.type === 'INTEGRATION_CONFLICT'));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('resumes a persisted DAG without rerunning completed stages', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-resume-'));
  const databaseFile = join(dir, 'state.sqlite');
  const plan = {
    parallelizable: true,
    stages: [
      { id: 'foundation', goal: 'Foundation', dependsOn: [] },
      { id: 'feature', goal: 'Feature', dependsOn: ['foundation'] },
      {
        id: 'integration',
        kind: 'integration',
        goal: 'Integration',
        dependsOn: ['feature'],
      },
    ],
  };
  const workspaceManager = {
    createWorktree: (_task, stage, _baseRef, attempt) => ({
      path: dir,
      branch: `test-${stage}-${attempt}`,
      baseSha: 'abc',
    }),
    getWorktreeStatus: () => ({ path: dir, sha: 'abc', dirty: false }),
  };
  let store = new Store(databaseFile);
  store.createTask({
    id: 'T-17',
    title: 'Resume',
    goal: 'Resume',
    profile: 'deep',
    acceptance: [{ id: 'AC-1', criterion: 'works' }],
  });
  const failingHarness = {
    run: async ({ stageId }) => {
      if (stageId === 'feature') throw new Error('fixture crash');
      return { sessionId: `session-${stageId}`, verification: [{ result: 'passed' }] };
    },
  };
  const firstScheduler = new Scheduler(store, workspaceManager, {
    harnessFactory: () => failingHarness,
    planFactory: () => plan,
    requirePlanApproval: false,
  });
  await assert.rejects(() => firstScheduler.runTask('T-17', 'deep', 'fake'), /plan stages failed/);
  store.close();

  store = new Store(databaseFile);
  const resumedStages = [];
  const resumedHarness = {
    run: async ({ stageId }) => {
      resumedStages.push(stageId);
      return { sessionId: `session-${stageId}`, verification: [{ result: 'passed' }] };
    },
  };
  const resumedScheduler = new Scheduler(store, workspaceManager, {
    harnessFactory: () => resumedHarness,
    planFactory: () => {
      throw new Error('persisted plan was not reused');
    },
    requirePlanApproval: false,
  });

  const result = await resumedScheduler.runTask('T-17', 'deep', 'fake');

  assert.equal(result.state, 'READY');
  assert.deepEqual(resumedStages, ['feature', 'integration']);
  assert.equal(store.getLatestPlan('T-17').version, 1);
  assert.equal(store.listRuns('T-17').filter((run) => run.stage_id === 'foundation').length, 1);
  assert.equal(store.listRuns('T-17').filter((run) => run.stage_id === 'feature').length, 2);
  assert.ok(store.listEvents('T-17').some((event) => event.type === 'TASK_RECOVERY_STARTED'));
  assert.ok(
    store
      .listEvents('T-17')
      .some((event) => event.type === 'STAGE_RECOVERED' && event.payload.stageId === 'foundation'),
  );
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('interrupts a persisted running attempt before resuming it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-interrupted-'));
  const databaseFile = join(dir, 'state.sqlite');
  let store = new Store(databaseFile);
  store.createTask({
    id: 'T-18',
    title: 'Interrupted',
    goal: 'Interrupted',
    profile: 'deep',
    acceptance: [{ id: 'AC-1', criterion: 'works' }],
  });
  store.savePlan(
    'T-18',
    {
      parallelizable: false,
      stages: [
        { id: 'worker', goal: 'Worker', dependsOn: [] },
        {
          id: 'integration',
          kind: 'integration',
          goal: 'Integration',
          dependsOn: ['worker'],
        },
      ],
    },
    'APPROVED',
  );
  store.addStage('T-18', 'worker', [], 'RUNNING');
  store.addStage('T-18', 'integration', ['worker'], 'QUEUED');
  store.setTaskState('T-18', 'QUEUED');
  store.setTaskState('T-18', 'EXECUTING');
  store.createRun({
    id: 'abandoned-run',
    taskId: 'T-18',
    stageId: 'worker',
    attempt: 1,
    status: 'RUNNING',
    harness: 'fake',
    workspace: dir,
    startedAt: new Date().toISOString(),
  });
  store.close();

  store = new Store(databaseFile);
  const workspaceManager = {
    createWorktree: (_task, stage, _baseRef, attempt) => ({
      path: dir,
      branch: `test-${stage}-${attempt}`,
      baseSha: 'abc',
    }),
    getWorktreeStatus: () => ({ path: dir, sha: 'abc', dirty: false }),
  };
  const scheduler = new Scheduler(store, workspaceManager, { requirePlanApproval: false });

  const result = await scheduler.runTask('T-18', 'deep', 'fake');

  assert.equal(result.state, 'READY');
  const workerRuns = store.listRuns('T-18').filter((run) => run.stage_id === 'worker');
  assert.deepEqual(
    workerRuns.map((run) => [run.attempt, run.status]),
    [
      [1, 'INTERRUPTED'],
      [2, 'COMPLETED'],
    ],
  );
  assert.ok(store.listEvents('T-18').some((event) => event.type === 'RUN_INTERRUPTED'));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('blocks recovery when a completed stage has no persisted revision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-recovery-blocked-'));
  const store = new Store(join(dir, 'state.sqlite'));
  store.createTask({
    id: 'T-19',
    title: 'Blocked recovery',
    goal: 'Blocked recovery',
    profile: 'deep',
    acceptance: [{ id: 'AC-1', criterion: 'works' }],
  });
  store.savePlan(
    'T-19',
    {
      parallelizable: false,
      stages: [
        { id: 'worker', goal: 'Worker', dependsOn: [] },
        {
          id: 'integration',
          kind: 'integration',
          goal: 'Integration',
          dependsOn: ['worker'],
        },
      ],
    },
    'APPROVED',
  );
  store.addStage('T-19', 'worker', [], 'COMPLETED');
  store.addStage('T-19', 'integration', ['worker'], 'QUEUED');
  store.setTaskState('T-19', 'QUEUED');
  store.setTaskState('T-19', 'EXECUTING');
  store.createRun({
    id: 'unverifiable-run',
    taskId: 'T-19',
    stageId: 'worker',
    attempt: 1,
    status: 'COMPLETED',
    harness: 'fake',
    workspace: dir,
    startedAt: new Date().toISOString(),
  });
  const scheduler = new Scheduler(
    store,
    {
      createWorktree: () => {
        throw new Error('recovery must stop before allocating a worktree');
      },
    },
    { requirePlanApproval: false },
  );

  await assert.rejects(
    () => scheduler.runTask('T-19', 'deep', 'fake'),
    /without a persisted revision/,
  );

  assert.equal(store.getTask('T-19').state, 'BLOCKED');
  assert.equal(store.listRuns('T-19').length, 1);
  assert.ok(store.listEvents('T-19').some((event) => event.type === 'RECOVERY_BLOCKED'));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('normalizes a native reviewer output behind the reviewer boundary', async () => {
  const reviewer = new CodexReviewer({
    run: async () => ({ output: { verdict: 'pass', findings: [] } }),
  });
  const result = await reviewer.review({
    task: {
      id: 'T-7',
      title: 'Review',
      goal: 'Review',
      acceptance: [{ id: 'AC-1', criterion: 'works' }],
    },
    evidence: [],
    revision: 'abc',
  });
  assert.equal(result.verdict, 'pass');
});

test('Codex adapter follows the app-server handshake and completion event', async () => {
  const harness = new CodexHarness({
    command: process.execPath,
    args: ['fixtures/fake-codex-server.js'],
    timeoutMs: 2000,
  });
  const events = [];
  const result = await harness.run({
    task: {
      id: 'T-8',
      title: 'Fixture',
      goal: 'Test protocol',
      acceptance: [{ id: 'AC-1', criterion: 'works' }],
    },
    cwd: process.cwd(),
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.sessionId.startsWith('codex-'), true);
  assert.ok(events.some((event) => event.type === 'HARNESS_COMPLETED'));
});
