import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitWorktreeManager, IntegrationConflictError } from '../src/workspace.js';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

test('creates, inspects, and removes an isolated worktree', () => {
  const root = mkdtempSync(join(tmpdir(), 'clew-worktree-'));
  const worktrees = join(root, 'worktrees');
  try {
    git(['init', '-b', 'main'], root);
    git(['config', 'user.email', 'test@example.com'], root);
    git(['config', 'user.name', 'Clew Test'], root);
    writeFileSync(join(root, 'README.md'), 'fixture\n');
    git(['add', 'README.md'], root);
    git(['commit', '-m', 'fixture'], root);
    const manager = new GitWorktreeManager(worktrees, root);
    const workspace = manager.create('T-3', 'worker');
    assert.equal(manager.status(workspace.path).dirty, false);
    manager.remove(workspace.path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('commits worker outputs and integrates them into a target worktree', () => {
  const root = mkdtempSync(join(tmpdir(), 'clew-integration-'));
  const worktrees = join(root, 'worktrees');
  try {
    git(['init', '-b', 'main'], root);
    git(['config', 'user.email', 'test@example.com'], root);
    git(['config', 'user.name', 'Clew Test'], root);
    writeFileSync(join(root, 'README.md'), 'fixture\n');
    git(['add', 'README.md'], root);
    git(['commit', '-m', 'fixture'], root);
    const manager = new GitWorktreeManager(worktrees, root);
    const backend = manager.create('T-11', 'backend');
    const frontend = manager.create('T-11', 'frontend');
    writeFileSync(join(backend.path, 'backend.txt'), 'backend\n');
    writeFileSync(join(frontend.path, 'frontend.txt'), 'frontend\n');
    const backendCommit = manager.commit(backend.path, 'backend');
    const frontendCommit = manager.commit(frontend.path, 'frontend');
    const integration = manager.create('T-11', 'integration');
    const result = manager.integrate(integration.path, [backendCommit, frontendCommit]);
    assert.equal(result.integrated.length, 2);
    assert.equal(readFileSync(join(integration.path, 'backend.txt'), 'utf8'), 'backend\n');
    assert.equal(readFileSync(join(integration.path, 'frontend.txt'), 'utf8'), 'frontend\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reports integration conflicts and aborts the cherry-pick', () => {
  const root = mkdtempSync(join(tmpdir(), 'clew-conflict-'));
  const worktrees = join(root, 'worktrees');
  try {
    git(['init', '-b', 'main'], root);
    git(['config', 'user.email', 'test@example.com'], root);
    git(['config', 'user.name', 'Clew Test'], root);
    writeFileSync(join(root, 'shared.txt'), 'base\n');
    git(['add', 'shared.txt'], root);
    git(['commit', '-m', 'fixture'], root);
    const manager = new GitWorktreeManager(worktrees, root);
    const first = manager.create('T-12', 'first');
    const second = manager.create('T-12', 'second');
    writeFileSync(join(first.path, 'shared.txt'), 'first\n');
    writeFileSync(join(second.path, 'shared.txt'), 'second\n');
    const firstCommit = manager.commit(first.path, 'first');
    const secondCommit = manager.commit(second.path, 'second');
    const integration = manager.create('T-12', 'integration');
    assert.throws(
      () => manager.integrate(integration.path, [firstCommit, secondCommit]),
      IntegrationConflictError,
    );
    assert.equal(git(['status', '--porcelain'], integration.path), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
