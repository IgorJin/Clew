import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../src/config.js';
import { ClewService } from '../src/control-service.js';
import { Store } from '../src/store.js';
import { GitWorktreeManager } from '../src/workspace.js';

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

test('service finalization inspects the completed run, integrates it, and records release evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'clew-finalization-service-'));
  const repository = join(root, 'repo');
  const worktreeRoot = join(root, 'worktrees');

  try {
    mkdirSync(repository);
    git(['init', '-b', 'main'], repository);
    git(['config', 'user.email', 'test@example.com'], repository);
    git(['config', 'user.name', 'Clew Test'], repository);
    writeFileSync(join(repository, 'README.md'), 'fixture\n');
    git(['add', 'README.md'], repository);
    git(['commit', '-m', 'fixture'], repository);
    const store = new Store(join(root, 'state.sqlite'));
    const manager = new GitWorktreeManager(worktreeRoot, repository);
    const workspace = manager.createWorktree('FINAL-1', 'worker');

    writeFileSync(join(workspace.path, 'result.txt'), 'done\n');
    const revision = manager.commitWorktreeChanges(workspace.path, 'worker result');

    store.createTask({
      id: 'FINAL-1',
      title: 'Finalize',
      goal: 'Finalize safely',
      profile: 'quick',
      acceptance: [{ id: 'AC-1', criterion: 'result exists' }],
      integration: { enabled: true },
    });
    store.addStage('FINAL-1', 'worker', [], 'COMPLETED');
    store.createRun({
      id: 'run-final-1',
      taskId: 'FINAL-1',
      stageId: 'worker',
      attempt: 1,
      status: 'COMPLETED',
      harness: 'fake',
      workspace: workspace.path,
      commitSha: revision,
      baseSha: workspace.baseSha,
      branch: workspace.branch,
      profile: 'quick',
      policy: {},
    });
    store.appendEvent('FINAL-1', 'VERIFICATION_RECORDED', {
      taskId: 'FINAL-1',
      runId: 'run-final-1',
      stageId: 'worker',
      revision,
      workspace: workspace.path,
      evidence: [{ result: 'passed', revision, acceptanceCriteria: ['AC-1'] }],
    });
    store.setTaskState('FINAL-1', 'READY_TO_FINISH');
    const service = new ClewService({
      cwd: repository,
      store,
      config: { ...DEFAULT_CONFIG, worktreeRoot, integration: { ...DEFAULT_CONFIG.integration } },
    });
    const report = await service.execute(['task', 'finalization', 'FINAL-1']);

    assert.equal(report.runId, 'run-final-1');
    assert.equal(report.ready, true);
    assert.ok(report.availableActions.includes('integrate'));
    const merged = await service.execute([
      'task',
      'integrate',
      'FINAL-1',
      '--message',
      'final result',
    ]);

    assert.equal(merged.state, 'MERGED');
    assert.equal(git(['branch', '--show-current'], repository), 'main');
    assert.equal(existsSync(join(repository, 'result.txt')), true);
    assert.equal(existsSync(workspace.path), false);
    const released = await service.execute([
      'task',
      'mark-released',
      'FINAL-1',
      '--evidence',
      'ci://release/1',
    ]);

    assert.equal(released.state, 'RELEASED');
    assert.ok(store.listEvents('FINAL-1').some((event) => event.type === 'TASK_RELEASED'));
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
