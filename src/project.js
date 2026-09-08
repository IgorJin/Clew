import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

function runGit(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    }).trim();
  } catch (error) {
    if (error?.code === 'ENOENT' && existsSync(cwd))
      throw new Error('git executable is not available on PATH', { cause: error });
    throw error;
  }
}

function safeBranchName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_./-]{1,120}$/.test(value.trim())
    ? value.trim()
    : null;
}

export function createProjectId() {
  return `PRJ-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
}

export function detectRepositoryRoot(folder) {
  try {
    return realpathSync(runGit(['rev-parse', '--show-toplevel'], folder));
  } catch (error) {
    if (String(error?.message).includes('git executable is not available')) throw error;
    throw new Error(`not a git repository: ${folder}`, { cause: error });
  }
}

export function detectDefaultBranch(repositoryRoot) {
  try {
    const originHead = runGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], repositoryRoot);
    const branch = safeBranchName(originHead.replace('refs/remotes/origin/', ''));

    if (branch) return branch;
  } catch {
    // No origin HEAD configured. Fall back to the current branch.
  }
  try {
    const current = safeBranchName(runGit(['symbolic-ref', '--short', 'HEAD'], repositoryRoot));

    if (current) return current;
  } catch {
    // Detached HEAD or unborn branch. Fall back to the configured default.
  }

  return 'main';
}

export function detectProject(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('project folder is required');
  const folder = resolve(input.trim());

  if (!existsSync(folder)) throw new Error(`project folder does not exist: ${folder}`);
  let stats;

  try {
    stats = statSync(folder);
  } catch {
    throw new Error(`project folder is not accessible: ${folder}`);
  }
  if (!stats.isDirectory()) throw new Error(`project folder is not a directory: ${folder}`);
  const repositoryRoot = detectRepositoryRoot(folder);

  return {
    localPath: realpathSync(folder),
    repositoryRoot,
    defaultBranch: detectDefaultBranch(repositoryRoot),
    name: basename(repositoryRoot),
  };
}
