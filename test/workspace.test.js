import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitWorktreeManager } from '../src/workspace.js';

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
