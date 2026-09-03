import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunnerExecutionPort } from '../src/runner-execution.js';

test('Runner execution resolves only configured mappings and returns normalized evidence', async () => {
  const calls = [];
  const port = new RunnerExecutionPort({
    workspaces: [{ id: 'clew', path: '/runner/local/clew' }],
    harnessFactory: () => ({
      async run(options) {
        calls.push(options);

        return {
          rationale: 'done',
          verification: [
            { type: 'command', command: 'npm test', result: 'passed', output: 'raw bytes' },
          ],
          usage: { inputTokens: 10 },
        };
      },
    }),
  });
  const result = await port.accept({
    leaseId: 'lease-1',
    epoch: 1,
    workspaceId: 'clew',
    stageId: 'worker',
    runId: 'run-1',
    harness: 'fake',
    requirements: { task: { id: 'task-1', title: 'Task', goal: 'Goal', acceptance: [] } },
  });

  assert.equal(calls[0].cwd, '/runner/local/clew');
  assert.deepEqual(result.evidence, [
    { type: 'command', command: 'npm test', result: 'passed', exitCode: null },
  ]);
  assert.equal(JSON.stringify(result).includes('raw bytes'), false);
  assert.deepEqual(port.capabilities().terminal, { access: 'runner_local' });
  await assert.rejects(
    () =>
      port.accept({
        leaseId: 'lease-2',
        epoch: 1,
        workspaceId: '/arbitrary/path',
        requirements: { task: {} },
      }),
    /mapping is unavailable/,
  );
});

test('Runner owns isolated Git worktrees and integrates Deep dependency revisions locally', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'clew-runner-worktrees-'));
  const project = join(directory, 'project');
  const worktreeRoot = join(directory, 'worktrees');
  const git = (args, cwd = project) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  try {
    mkdirSync(project);
    git(['init', '-b', 'main']);
    git(['config', 'user.email', 'runner@example.com']);
    git(['config', 'user.name', 'Runner Test']);
    writeFileSync(join(project, 'README.md'), 'base\n');
    git(['add', 'README.md']);
    git(['commit', '-m', 'base']);
    const observed = [];
    const port = new RunnerExecutionPort({
      workspaces: [{ id: 'clew', path: project }],
      worktreeRoot,
      harnessFactory: () => ({
        async run(options) {
          observed.push(options.cwd);
          if (options.stageId === 'backend')
            writeFileSync(join(options.cwd, 'backend.txt'), 'backend\n');
          else {
            assert.equal(readFileSync(join(options.cwd, 'backend.txt'), 'utf8'), 'backend\n');
            writeFileSync(join(options.cwd, 'integration.txt'), 'integrated\n');
          }

          return {
            rationale: 'done',
            verification: [{ type: 'command', command: 'fixture', result: 'passed' }],
          };
        },
      }),
    });
    const task = {
      id: 'TASK-1',
      title: 'Deep Runner',
      goal: 'Integrate stages',
      profile: 'deep',
      base_ref: 'HEAD',
      acceptance: [],
    };
    const backend = await port.accept({
      leaseId: 'lease-backend',
      epoch: 1,
      workspaceId: 'clew',
      stageId: 'backend',
      runId: 'run-backend',
      attempt: 1,
      harness: 'fake',
      requirements: { task },
    });
    const integration = await port.accept({
      leaseId: 'lease-integration',
      epoch: 1,
      workspaceId: 'clew',
      stageId: 'integration',
      runId: 'run-integration',
      attempt: 1,
      harness: 'fake',
      requirements: { task, dependencyRevisions: [backend.revision] },
    });

    assert.notEqual(observed[0], observed[1]);
    assert.notEqual(observed[0], project);
    assert.ok(existsSync(join(observed[1], 'backend.txt')));
    assert.ok(existsSync(join(observed[1], 'integration.txt')));
    assert.equal(git(['show', `${integration.revision}:backend.txt`]).trim(), 'backend');
    assert.equal(git(['show', `${integration.revision}:integration.txt`]).trim(), 'integrated');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
