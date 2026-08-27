import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitWorktreeManager, IntegrationConflictError } from '../src/workspace.js';

function runGitCommand(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

test('creates, inspects, and removes an isolated worktree', () => {
  const root = mkdtempSync(join(tmpdir(), 'clew-worktree-'));
  const worktrees = join(root, 'worktrees');

  try {
    runGitCommand(['init', '-b', 'main'], root);
    runGitCommand(['config', 'user.email', 'test@example.com'], root);
    runGitCommand(['config', 'user.name', 'Clew Test'], root);
    writeFileSync(join(root, 'README.md'), 'fixture\n');
    runGitCommand(['add', 'README.md'], root);
    runGitCommand(['commit', '-m', 'fixture'], root);
    const manager = new GitWorktreeManager(worktrees, root);
    const workspace = manager.createWorktree('T-3', 'worker');

    assert.equal(manager.getWorktreeStatus(workspace.path).dirty, false);
    assert.equal(
      manager.listWorktrees().some((entry) => entry.path === workspace.path),
      true,
    );
    manager.removeWorktree(workspace.path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('prunes only clean inactive owned worktrees', () => {
  const root = mkdtempSync(join(tmpdir(), 'clew-worktree-prune-'));
  const worktrees = join(root, 'worktrees');

  try {
    runGitCommand(['init', '-b', 'main'], root);
    runGitCommand(['config', 'user.email', 'test@example.com'], root);
    runGitCommand(['config', 'user.name', 'Clew Test'], root);
    writeFileSync(join(root, 'README.md'), 'fixture\n');
    runGitCommand(['add', 'README.md'], root);
    runGitCommand(['commit', '-m', 'fixture'], root);
    const manager = new GitWorktreeManager(worktrees, root);
    const active = manager.createWorktree('T-PRUNE', 'active');
    const clean = manager.createWorktree('T-PRUNE', 'clean');
    const dirty = manager.createWorktree('T-PRUNE', 'dirty');

    writeFileSync(join(dirty.path, 'dirty.txt'), 'uncommitted\n');
    const result = manager.pruneWorktrees({ protectedPaths: [active.path] });

    assert.deepEqual(
      result.removed.map((entry) => entry.path),
      [clean.path],
    );
    assert.deepEqual(result.skipped.map((entry) => entry.reason).sort(), ['active run', 'dirty']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('commits worker outputs and integrates them into a target worktree', () => {
  const root = mkdtempSync(join(tmpdir(), 'clew-integration-'));
  const worktrees = join(root, 'worktrees');

  try {
    runGitCommand(['init', '-b', 'main'], root);
    runGitCommand(['config', 'user.email', 'test@example.com'], root);
    runGitCommand(['config', 'user.name', 'Clew Test'], root);
    writeFileSync(join(root, 'README.md'), 'fixture\n');
    runGitCommand(['add', 'README.md'], root);
    runGitCommand(['commit', '-m', 'fixture'], root);
    const manager = new GitWorktreeManager(worktrees, root);
    const backend = manager.createWorktree('T-11', 'backend');
    const frontend = manager.createWorktree('T-11', 'frontend');

    writeFileSync(join(backend.path, 'backend.txt'), 'backend\n');
    writeFileSync(join(frontend.path, 'frontend.txt'), 'frontend\n');
    const backendCommit = manager.commitWorktreeChanges(backend.path, 'backend');
    const frontendCommit = manager.commitWorktreeChanges(frontend.path, 'frontend');
    const integration = manager.createWorktree('T-11', 'integration');
    const result = manager.integrateCommits(integration.path, [backendCommit, frontendCommit]);

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
    runGitCommand(['init', '-b', 'main'], root);
    runGitCommand(['config', 'user.email', 'test@example.com'], root);
    runGitCommand(['config', 'user.name', 'Clew Test'], root);
    writeFileSync(join(root, 'shared.txt'), 'base\n');
    runGitCommand(['add', 'shared.txt'], root);
    runGitCommand(['commit', '-m', 'fixture'], root);
    const manager = new GitWorktreeManager(worktrees, root);
    const first = manager.createWorktree('T-12', 'first');
    const second = manager.createWorktree('T-12', 'second');

    writeFileSync(join(first.path, 'shared.txt'), 'first\n');
    writeFileSync(join(second.path, 'shared.txt'), 'second\n');
    const firstCommit = manager.commitWorktreeChanges(first.path, 'first');
    const secondCommit = manager.commitWorktreeChanges(second.path, 'second');
    const integration = manager.createWorktree('T-12', 'integration');

    assert.throws(
      () => manager.integrateCommits(integration.path, [firstCommit, secondCommit]),
      IntegrationConflictError,
    );
    assert.equal(runGitCommand(['status', '--porcelain'], integration.path), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
