import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

function git(args, cwd, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (allowFailure) return error.stdout ?? '';
    throw error;
  }
}

function parseStatus(output) {
  const files = [];
  const tokens = output.split('\0').filter(Boolean);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const status = token.slice(0, 2);
    const path = token.slice(3);
    const renamed = status.includes('R') || status.includes('C');
    const nextPath = renamed ? tokens[++index] : null;

    files.push({ path: nextPath ?? path, ...(nextPath ? { oldPath: path } : {}), status });
  }
  return files;
}

function parseNameStatus(output) {
  const files = [];
  const tokens = output.split('\0').filter(Boolean);

  for (let index = 0; index < tokens.length; index += 1) {
    const status = tokens[index++];
    const oldPath = tokens[index++];
    const renamed = status.startsWith('R') || status.startsWith('C');
    const path = renamed ? tokens[index++] : oldPath;
    files.push({ path, ...(renamed ? { oldPath } : {}), status });
  }
  return files;
}

function numbers(text) {
  let additions = 0;
  let deletions = 0;
  let binary = false;

  for (const line of text.split('\n').filter(Boolean)) {
    const [added, removed] = line.split('\t');
    if (added === '-' || removed === '-') binary = true;
    else {
      additions += Number(added) || 0;
      deletions += Number(removed) || 0;
    }
  }
  return { additions, deletions, binary };
}

/** Read-only inspection of the workspace persisted on a run. */
export class GitChangeInspectionService {
  constructor(store) {
    this.store = store;
  }

  inspect(runId) {
    if (!runId) throw new Error('run id is required');
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`run not found: ${runId}`);

    const unavailable = (reason) => ({
      version: 1,
      runId,
      state: 'unavailable',
      reason,
      summary: { files: 0, additions: 0, deletions: 0 },
      files: [],
      statuses: [],
      patch: '',
      additions: 0,
      deletions: 0,
      binary: false,
      dirty: false,
      revisions: { base: run.base_sha ?? run.baseSha ?? null, head: run.commit_sha ?? null },
    });

    if (run.execution_mode === 'paired' || !run.workspace)
      return unavailable(run.execution_mode === 'paired' ? 'runner-local-unavailable' : 'missing-worktree');
    if (!existsSync(run.workspace)) return unavailable('missing-worktree');
    const base = run.base_sha ?? run.baseSha;
    if (!base) return unavailable('base-revision-unavailable');

    try {
      const status = parseStatus(git(['status', '--porcelain=v1', '-z'], run.workspace));
      const committed = parseNameStatus(git(['diff', '--name-status', '-z', `${base}..HEAD`], run.workspace));
      const statusByPath = new Map(committed.map((item) => [item.path, item]));
      for (const item of status) statusByPath.set(item.path, item);
      const statuses = [...statusByPath.values()];
      const untracked = status.filter((item) => item.status === '??');
      const trackedDiff = git(['diff', '--binary', base], run.workspace);
      let patch = trackedDiff;
      let binary = numbers(git(['diff', '--numstat', base], run.workspace)).binary;
      let additions = numbers(git(['diff', '--numstat', base], run.workspace)).additions;
      let deletions = numbers(git(['diff', '--numstat', base], run.workspace)).deletions;

      for (const file of untracked) {
        const result = git(['diff', '--binary', '--no-index', '/dev/null', file.path], run.workspace, {
          allowFailure: true,
        });
        if (result !== null) patch += result;
        const stats = git(['diff', '--numstat', '--no-index', '/dev/null', file.path], run.workspace, {
          allowFailure: true,
        });
        if (stats !== null) {
          const count = numbers(stats);
          additions += count.additions;
          deletions += count.deletions;
          binary ||= count.binary;
        }
      }
      const head = git(['rev-parse', 'HEAD'], run.workspace).trim();
      const dirty = status.length > 0;

      return {
        version: 1,
        runId,
        state: 'available',
        summary: { files: statuses.length, additions, deletions },
        files: statuses.map((item) => item.path),
        statuses,
        patch,
        additions,
        deletions,
        binary,
        dirty,
        revisions: { base, head, committed: run.commit_sha ?? head },
      };
    } catch {
      return unavailable('runner-local-unavailable');
    }
  }
}

export function inspectRunChanges(store, runId) {
  return new GitChangeInspectionService(store).inspect(runId);
}
