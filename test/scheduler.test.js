import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { CodexReviewer } from '../src/review.js';
import { CodexHarness } from '../src/harness.js';

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
  const result = await new Scheduler(store, workspaceManager).runTask('T-6', 'deep', 'fake');
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
  const scheduler = new Scheduler(store, workspaceManager, { harnessFactory: () => harness });
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
  const scheduler = new Scheduler(store, workspaceManager, { harnessFactory: () => harness });
  await assert.rejects(() => scheduler.runTask('T-10', 'deep', 'fake'), /parallel stages failed/);
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
