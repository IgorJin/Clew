import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

function runGitCommand(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export class IntegrationConflictError extends Error {
  constructor(commit, message) {
    super(`failed to integrate commit ${commit}: ${message}`);
    this.name = 'IntegrationConflictError';
    this.commit = commit;
  }
}

export class GitWorktreeManager {
  constructor(root, projectRoot = process.cwd()) {
    this.root = resolve(root);
    this.projectRoot = resolve(projectRoot);
    mkdirSync(this.root, { recursive: true });
    this.root = realpathSync(this.root);
  }
  createWorktree(taskId, stageId, baseRef = 'HEAD', attempt = 1) {
    const suffix = attempt > 1 ? `-attempt-${attempt}` : '';
    const safe = `${taskId}-${stageId}${suffix}`.replace(/[^A-Za-z0-9_.-]/g, '-');
    const path = join(this.root, safe);
    const branch = `ai/${safe}`;

    try {
      runGitCommand(['worktree', 'add', '-b', branch, path, baseRef], this.projectRoot);
      const baseSha = runGitCommand(['rev-parse', baseRef], this.projectRoot);
      const canonicalPath = realpathSync(path);

      return { path: canonicalPath, branch, baseSha };
    } catch (error) {
      if (path.startsWith(`${this.root}/`)) rmSync(path, { recursive: true, force: true });
      throw error;
    }
  }
  getWorktreeStatus(path) {
    return {
      path,
      sha: runGitCommand(['rev-parse', 'HEAD'], path),
      dirty: Boolean(runGitCommand(['status', '--porcelain'], path)),
    };
  }
  listWorktrees() {
    const entries = runGitCommand(['worktree', 'list', '--porcelain'], this.projectRoot)
      .split('\n\n')
      .filter(Boolean)
      .map((entry) => {
        const lines = entry.split('\n');
        const path = lines.find((line) => line.startsWith('worktree '))?.slice(9);
        const sha = lines.find((line) => line.startsWith('HEAD '))?.slice(5);
        const branch = lines.find((line) => line.startsWith('branch '))?.slice(7);

        return path ? { path, sha, branch: branch?.replace('refs/heads/', '') } : null;
      })
      .filter(Boolean);

    const canonicalRoot = realpathSync(this.root);

    return entries
      .map((entry) => ({ ...entry, path: resolve(entry.path) }))
      .filter((entry) => entry.path === canonicalRoot || entry.path.startsWith(`${canonicalRoot}/`))
      .map((entry) =>
        existsSync(entry.path)
          ? { ...entry, path: realpathSync(entry.path), missing: false }
          : { ...entry, missing: true },
      )
      .filter(
        (entry) => entry.path === canonicalRoot || entry.path.startsWith(`${canonicalRoot}/`),
      );
  }
  commitWorktreeChanges(path, message) {
    const status = this.getWorktreeStatus(path);

    if (!status.dirty) return status.sha;
    runGitCommand(['add', '--all'], path);
    runGitCommand(['commit', '-m', message], path);

    return runGitCommand(['rev-parse', 'HEAD'], path);
  }
  integrateCommits(path, commits) {
    const integrated = [];
    const skipped = [];

    for (const commit of commits) {
      try {
        runGitCommand(['merge-base', '--is-ancestor', commit, 'HEAD'], path);
        skipped.push(commit);
        continue;
      } catch {
        // A non-zero exit means the commit is not yet in the integration branch.
      }
      try {
        runGitCommand(['cherry-pick', commit], path);
        integrated.push(commit);
      } catch (error) {
        try {
          runGitCommand(['cherry-pick', '--abort'], path);
        } catch {
          // Preserve the original integration error; the worktree remains inspectable.
        }
        throw new IntegrationConflictError(commit, error.stderr || error.message);
      }
    }

    return { integrated, skipped, revision: runGitCommand(['rev-parse', 'HEAD'], path) };
  }
  removeWorktree(path, { force = false } = {}) {
    const target = resolve(path);

    if (!target.startsWith(`${this.root}/`))
      throw new Error('worktree path is outside the Clew worktree root');
    if (!force && this.getWorktreeStatus(target).dirty)
      throw new Error('refusing to remove a dirty worktree; pass force=true');
    runGitCommand(['worktree', 'remove', ...(force ? ['--force'] : []), target], this.projectRoot);
  }
  pruneWorktrees({ protectedPaths = [] } = {}) {
    const protectedSet = new Set(protectedPaths.map((path) => resolve(path)));
    const removed = [];
    const skipped = [];

    for (const worktree of this.listWorktrees()) {
      if (worktree.missing) {
        skipped.push({ ...worktree, reason: 'missing' });
        continue;
      }
      if (protectedSet.has(worktree.path)) {
        skipped.push({ ...worktree, reason: 'active run' });
        continue;
      }
      const status = this.getWorktreeStatus(worktree.path);

      if (status.dirty) {
        skipped.push({ ...worktree, reason: 'dirty' });
        continue;
      }
      this.removeWorktree(worktree.path);
      removed.push(worktree);
    }

    return { removed, skipped };
  }
}
