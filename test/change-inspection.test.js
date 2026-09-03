import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitChangeInspectionService } from '../src/change-inspection.js';
import { Store } from '../src/store.js';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

test('inspects committed, working, and untracked changes from persisted run provenance', () => {
  const root = mkdtempSync(join(tmpdir(), 'clew-change-inspection-'));
  const state = mkdtempSync(join(tmpdir(), 'clew-change-state-'));

  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'test']);
  writeFileSync(join(root, 'tracked.txt'), 'before\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'base']);
  const base = git(root, ['rev-parse', 'HEAD']);

  writeFileSync(join(root, 'tracked.txt'), 'before\nafter\n');
  writeFileSync(join(root, 'new.txt'), 'new\n');
  const store = new Store(join(state, 'clew.sqlite'));

  try {
    store.createTask({ id: 'CHANGES-1', title: 'changes', description: 'inspect' });
    store.createRun({
      id: 'run-1', taskId: 'CHANGES-1', stageId: 'worker', attempt: 1,
      status: 'RUNNING', harness: 'fake', workspace: root, baseSha: base,
    });
    const result = new GitChangeInspectionService(store).inspect('run-1');

    assert.equal(result.state, 'available');
    assert.deepEqual(result.files.sort(), ['new.txt', 'tracked.txt']);
    assert.equal(result.additions, 2);
    assert.match(result.patch, /tracked\.txt/);
    assert.match(result.patch, /new\.txt/);
    assert.equal(result.dirty, true);
  } finally {
    store.close();
  }
});

test('returns explicit unavailable state for paired and missing persisted workspaces', () => {
  const state = mkdtempSync(join(tmpdir(), 'clew-change-state-'));
  const store = new Store(join(state, 'clew.sqlite'));

  try {
    store.createTask({ id: 'CHANGES-2', title: 'changes', description: 'inspect' });
    store.createRun({ id: 'paired', taskId: 'CHANGES-2', stageId: 'worker', attempt: 1, status: 'RUNNING', harness: 'fake', executionMode: 'paired' });
    store.createRun({ id: 'missing', taskId: 'CHANGES-2', stageId: 'worker', attempt: 2, status: 'RUNNING', harness: 'fake', workspace: '/definitely/missing', baseSha: 'abc' });
    const service = new GitChangeInspectionService(store);

    assert.equal(service.inspect('paired').reason, 'runner-local-unavailable');
    assert.equal(service.inspect('missing').reason, 'missing-worktree');
  } finally {
    store.close();
  }
});
