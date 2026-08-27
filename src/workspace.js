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

export class GitWorktreeManager {
  constructor(root, projectRoot = process.cwd()) {
    this.root = resolve(root);
    this.projectRoot = resolve(projectRoot);
    mkdirSync(this.root, { recursive: true });
  }
  create(taskId, stageId, baseRef = 'HEAD') {
    const safe = `${taskId}-${stageId}`.replace(/[^A-Za-z0-9_.-]/g, '-');
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
  remove(path, { force = false } = {}) {
    const target = resolve(path);
    if (!target.startsWith(`${this.root}/`))
      throw new Error('worktree path is outside the Clew worktree root');
    if (!force && this.status(target).dirty)
      throw new Error('refusing to remove a dirty worktree; pass force=true');
    git(['worktree', 'remove', ...(force ? ['--force'] : []), target], this.projectRoot);
  }
}
