import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';

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
