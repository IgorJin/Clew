import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { CodexReviewer } from '../src/review.js';

test('runs a quick task with a fake workspace and records evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-scheduler-'));
  const store = new Store(join(dir, 'state.sqlite'));
  const workspaceManager = {
    create: () => ({ path: dir, branch: 'test', baseSha: 'abc' }),
    status: () => ({ path: dir, sha: 'abc', dirty: false }),
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
  assert.equal(store.runs('T-2')[0].status, 'COMPLETED');
  assert.ok(store.events('T-2').some((event) => event.type === 'VERIFICATION_RECORDED'));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('runs standard profile through a review decision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-standard-'));
  const store = new Store(join(dir, 'state.sqlite'));
  const workspaceManager = {
    create: () => ({ path: dir, branch: 'test', baseSha: 'abc' }),
    status: () => ({ path: dir, sha: 'abc', dirty: false }),
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
  assert.ok(store.events('T-4').some((event) => event.type === 'REVIEW_RECORDED'));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('routes blocking review findings into bounded retries', async () => {
  const previous = process.env.CLEW_FAKE_REVIEW;
  process.env.CLEW_FAKE_REVIEW = 'request_changes';
  const dir = mkdtempSync(join(tmpdir(), 'clew-retry-'));
  const store = new Store(join(dir, 'state.sqlite'));
  const workspaceManager = {
    create: () => ({ path: dir, branch: 'test', baseSha: 'abc' }),
    status: () => ({ path: dir, sha: 'abc', dirty: false }),
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
  assert.equal(store.runs('T-5').length, 3);
  assert.equal(store.events('T-5').filter((event) => event.type === 'RETRY_SCHEDULED').length, 2);
  store.close();
  rmSync(dir, { recursive: true, force: true });
  if (previous === undefined) delete process.env.CLEW_FAKE_REVIEW;
  else process.env.CLEW_FAKE_REVIEW = previous;
});

test('runs deep profile through planned worker and integration stages', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-deep-'));
  const store = new Store(join(dir, 'state.sqlite'));
  const workspaceManager = {
    create: (_task, stage) => ({ path: dir, branch: `test-${stage}`, baseSha: 'abc' }),
    status: () => ({ path: dir, sha: 'abc', dirty: false }),
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
    store.stages('T-6').map((stage) => stage.id),
    ['backend', 'frontend', 'integration'],
  );
  assert.ok(store.events('T-6').some((event) => event.type === 'INTEGRATION_COMPLETED'));
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
