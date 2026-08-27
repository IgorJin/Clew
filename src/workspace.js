import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

function git(args, cwd) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }

export class GitWorktreeManager {
  constructor(root, projectRoot = process.cwd()) { this.root = resolve(root); this.projectRoot = resolve(projectRoot); mkdirSync(this.root, { recursive: true }); }
  create(taskId, stageId, baseRef = 'HEAD') {
    const safe = `${taskId}-${stageId}`.replace(/[^A-Za-z0-9_.-]/g, '-');
    const path = join(this.root, safe); const branch = `ai/${safe}`;
    git(['worktree', 'add', '-b', branch, path, baseRef], this.projectRoot);
    const baseSha = git(['rev-parse', baseRef], this.projectRoot);
    return { path, branch, baseSha };
  }
  status(path) { return { path, sha: git(['rev-parse', 'HEAD'], path), dirty: Boolean(git(['status', '--porcelain'], path)) }; }
}
