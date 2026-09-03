import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  for (const name of ['committed.txt', 'staged.txt', 'unstaged.txt', 'rename-old.txt'])
    writeFileSync(join(root, name), 'before\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'base']);
  const base = git(root, ['rev-parse', 'HEAD']);

  writeFileSync(join(root, 'committed.txt'), 'before\nafter\n');
  git(root, ['add', 'committed.txt']);
  git(root, ['commit', '-qm', 'committed change']);
  writeFileSync(join(root, 'staged.txt'), 'before\nafter\n');
  git(root, ['add', 'staged.txt']);
  writeFileSync(join(root, 'unstaged.txt'), 'before\nafter\n');
  git(root, ['mv', 'rename-old.txt', 'rename-new.txt']);
  writeFileSync(join(root, 'new.txt'), 'new\n');
  writeFileSync(join(root, '-leading-dash.txt'), 'dash\n');
  writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 1, 2, 0, 255]));
  const store = new Store(join(state, 'clew.sqlite'));

  try {
    store.createTask({ id: 'CHANGES-1', title: 'changes', description: 'inspect' });
    store.createRun({
      id: 'run-1',
      taskId: 'CHANGES-1',
      stageId: 'worker',
      attempt: 1,
      status: 'RUNNING',
      harness: 'fake',
      workspace: root,
      baseSha: base,
    });
    const result = new GitChangeInspectionService(store).inspect('run-1');

    assert.equal(result.state, 'available');
    assert.deepEqual(result.files.sort(), [
      '-leading-dash.txt',
      'binary.bin',
      'committed.txt',
      'new.txt',
      'rename-new.txt',
      'staged.txt',
      'unstaged.txt',
    ]);
    assert.equal(result.additions, 5);
    assert.equal(result.deletions, 0);
    assert.equal(result.binary, true);
    assert.match(result.patch, /committed\.txt/);
    assert.match(result.patch, /staged\.txt/);
    assert.match(result.patch, /unstaged\.txt/);
    assert.match(result.patch, /new\.txt/);
    assert.match(result.patch, /leading-dash\.txt/);
    assert.match(result.patch, /binary\.bin/);
    assert.deepEqual(
      result.statuses.find((item) => item.status.includes('R')),
      { path: 'rename-new.txt', oldPath: 'rename-old.txt', status: 'R ' },
    );
    assert.equal(result.dirty, true);
    assert.equal(result.revisions.base, base);
  } finally {
    store.close();
  }
});

test('returns an available empty diff for an unchanged run', () => {
  const root = mkdtempSync(join(tmpdir(), 'clew-change-empty-'));
  const state = mkdtempSync(join(tmpdir(), 'clew-change-state-'));

  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'test']);
  writeFileSync(join(root, 'tracked.txt'), 'unchanged\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'base']);
  const base = git(root, ['rev-parse', 'HEAD']);
  const store = new Store(join(state, 'clew.sqlite'));

  try {
    store.createTask({ id: 'CHANGES-EMPTY', title: 'empty', description: 'inspect' });
    store.createRun({
      id: 'run-empty',
      taskId: 'CHANGES-EMPTY',
      stageId: 'worker',
      attempt: 1,
      status: 'COMPLETED',
      harness: 'fake',
      workspace: root,
      baseSha: base,
    });
    const result = new GitChangeInspectionService(store).inspect('run-empty');

    assert.equal(result.state, 'available');
    assert.deepEqual(result.summary, { files: 0, additions: 0, deletions: 0 });
    assert.equal(result.patch, '');
    assert.equal(result.dirty, false);
  } finally {
    store.close();
  }
});

test('returns explicit unavailable state for paired and missing persisted workspaces', () => {
  const state = mkdtempSync(join(tmpdir(), 'clew-change-state-'));
  const store = new Store(join(state, 'clew.sqlite'));

  try {
    store.createTask({ id: 'CHANGES-2', title: 'changes', description: 'inspect' });
    store.createRun({
      id: 'paired',
      taskId: 'CHANGES-2',
      stageId: 'worker',
      attempt: 1,
      status: 'RUNNING',
      harness: 'fake',
      executionMode: 'paired',
    });
    store.createRun({
      id: 'missing',
      taskId: 'CHANGES-2',
      stageId: 'worker',
      attempt: 2,
      status: 'RUNNING',
      harness: 'fake',
      workspace: '/definitely/missing',
      baseSha: 'abc',
    });
    const service = new GitChangeInspectionService(store);

    assert.equal(service.inspect('paired').reason, 'runner-local-unavailable');
    assert.equal(service.inspect('missing').reason, 'missing-worktree');

    const root = mkdtempSync(join(tmpdir(), 'clew-change-invalid-base-'));

    git(root, ['init', '-q']);
    git(root, ['config', 'user.email', 'test@example.com']);
    git(root, ['config', 'user.name', 'test']);
    writeFileSync(join(root, 'tracked.txt'), 'content\n');
    git(root, ['add', '.']);
    git(root, ['commit', '-qm', 'base']);
    store.createRun({
      id: 'invalid-base',
      taskId: 'CHANGES-2',
      stageId: 'worker',
      attempt: 3,
      status: 'RUNNING',
      harness: 'fake',
      workspace: root,
      baseSha: 'not-a-revision',
    });
    assert.equal(service.inspect('invalid-base').reason, 'git-inspection-failed');
    rmSync(root, { recursive: true, force: true });
  } finally {
    store.close();
  }
});
