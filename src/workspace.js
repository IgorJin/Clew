import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

function git(args, cwd) {
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
  }
  create(taskId, stageId, baseRef = 'HEAD', attempt = 1) {
    const suffix = attempt > 1 ? `-attempt-${attempt}` : '';
    const safe = `${taskId}-${stageId}${suffix}`.replace(/[^A-Za-z0-9_.-]/g, '-');
    const path = join(this.root, safe);
    const branch = `ai/${safe}`;
    try {
      git(['worktree', 'add', '-b', branch, path, baseRef], this.projectRoot);
      const baseSha = git(['rev-parse', baseRef], this.projectRoot);
      return { path, branch, baseSha };
    } catch (error) {
      if (path.startsWith(`${this.root}/`)) rmSync(path, { recursive: true, force: true });
      throw error;
    }
  }
  status(path) {
    return {
      path,
      sha: git(['rev-parse', 'HEAD'], path),
      dirty: Boolean(git(['status', '--porcelain'], path)),
    };
  }
  commit(path, message) {
    const status = this.status(path);
    if (!status.dirty) return status.sha;
    git(['add', '--all'], path);
    git(['commit', '-m', message], path);
    return git(['rev-parse', 'HEAD'], path);
  }
  integrate(path, commits) {
    const integrated = [];
    const skipped = [];
    for (const commit of commits) {
      try {
        git(['merge-base', '--is-ancestor', commit, 'HEAD'], path);
        skipped.push(commit);
        continue;
      } catch {
        // A non-zero exit means the commit is not yet in the integration branch.
      }
      try {
        git(['cherry-pick', commit], path);
        integrated.push(commit);
      } catch (error) {
        try {
          git(['cherry-pick', '--abort'], path);
        } catch {
          // Preserve the original integration error; the worktree remains inspectable.
        }
        throw new IntegrationConflictError(commit, error.stderr || error.message);
      }
    }
    return { integrated, skipped, revision: git(['rev-parse', 'HEAD'], path) };
  }
  remove(path, { force = false } = {}) {
    const target = resolve(path);
    if (!target.startsWith(`${this.root}/`))
      throw new Error('worktree path is outside the Clew worktree root');
    if (!force && this.status(target).dirty)
      throw new Error('refusing to remove a dirty worktree; pass force=true');
    git(['worktree', 'remove', ...(force ? ['--force'] : []), target], this.projectRoot);
  }
}
