import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const cliFile = fileURLToPath(new URL('../bin/clew.js', import.meta.url));

function runCommand(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runCli(args, cwd) {
  return runCommand(process.execPath, [cliFile, ...args], cwd);
}

test('CLI gates Deep execution on explicit plan approval', () => {
  const repo = mkdtempSync(join(tmpdir(), 'clew-cli-approval-'));

  try {
    runCommand('git', ['init', '-b', 'main'], repo);
    runCommand('git', ['config', 'user.email', 'test@example.com'], repo);
    runCommand('git', ['config', 'user.name', 'Clew Test'], repo);
    writeFileSync(join(repo, '.gitignore'), '.clew/\n');
    writeFileSync(join(repo, 'README.md'), 'fixture\n');
    runCommand('git', ['add', '.gitignore', 'README.md'], repo);
    runCommand('git', ['commit', '-m', 'fixture'], repo);

    runCli(['init'], repo);
    runCli(
      [
        'task',
        'create',
        '--id',
        'CLI-1',
        '--title',
        'CLI approval',
        '--goal',
        'Exercise approval flow',
        '--accept',
        'the flow completes',
        '--profile',
        'deep',
      ],
      repo,
    );

    const waiting = JSON.parse(runCli(['run', 'CLI-1', '--harness', 'fake'], repo));

    assert.equal(waiting.state, 'WAITING_FOR_HUMAN');
    assert.equal(waiting.attention, 'PLAN_APPROVAL_REQUIRED');
    const pendingPlan = JSON.parse(runCli(['plan', 'CLI-1'], repo));

    assert.equal(pendingPlan.status, 'PENDING_APPROVAL');

    const approval = JSON.parse(runCli(['approve', 'CLI-1'], repo));

    assert.equal(approval.status, 'APPROVED');
    const completed = JSON.parse(runCli(['run', 'CLI-1', '--harness', 'fake'], repo));

    assert.equal(completed.state, 'READY');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
