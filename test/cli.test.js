import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const cliFile = fileURLToPath(new URL('../bin/clew.js', import.meta.url));

function runCommand(command, args, cwd, extraEnv = {}) {
  return execFileSync(command, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runCli(args, cwd) {
  return runCommand(process.execPath, [cliFile, ...args], cwd);
}

test('CLI help reports the package version', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  assert.match(runCli(['--help'], process.cwd()), new RegExp(`^Clew v${packageJson.version}\\b`));
});

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

test('CLI records an interrupt request for an active task', () => {
  const repo = mkdtempSync(join(tmpdir(), 'clew-cli-interrupt-'));

  try {
    runCommand('git', ['init', '-b', 'main'], repo);
    runCommand('git', ['config', 'user.email', 'test@example.com'], repo);
    runCommand('git', ['config', 'user.name', 'Clew Test'], repo);
    writeFileSync(join(repo, 'README.md'), 'fixture\n');
    runCommand('git', ['add', 'README.md'], repo);
    runCommand('git', ['commit', '-m', 'fixture'], repo);
    runCli(['init'], repo);
    runCli(
      [
        'task',
        'create',
        '--id',
        'CLI-INT',
        '--title',
        'CLI interrupt',
        '--goal',
        'Exercise interrupt request',
        '--accept',
        'the request is recorded',
      ],
      repo,
    );

    const result = JSON.parse(runCli(['interrupt', 'CLI-INT', '--actor', 'fixture-user'], repo));

    assert.equal(result.taskId, 'CLI-INT');
    assert.equal(result.actor, 'fixture-user');
    const events = JSON.parse(runCli(['events', 'CLI-INT'], repo));

    assert.ok(events.some((event) => event.type === 'INTERRUPT_REQUESTED'));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('doctor reports optional native adapter readiness without failing fake setup', () => {
  const repo = mkdtempSync(join(tmpdir(), 'clew-cli-doctor-'));

  try {
    const result = JSON.parse(
      runCommand(process.execPath, [cliFile, 'doctor'], repo, {
        CLEW_CODEX_BIN: 'clew-command-that-does-not-exist',
        CLEW_OPENCODE_BIN: 'clew-command-that-does-not-exist',
        CLEW_OPENCODE_URL: 'not-a-url',
      }),
    );

    assert.equal(result.ok, true);
    assert.deepEqual(
      result.checks.map((check) => check.name),
      ['node', 'git', 'codex-cli', 'codex-auth', 'opencode-cli', 'opencode-endpoint'],
    );
    assert.equal(result.checks.find((check) => check.name === 'codex-cli').ok, false);
    assert.equal(
      result.checks.find((check) => check.name === 'opencode-endpoint').detail,
      'invalid URL',
    );

    const required = JSON.parse(
      runCommand(process.execPath, [cliFile, 'doctor', '--harness', 'codex'], repo, {
        CLEW_CODEX_BIN: 'clew-command-that-does-not-exist',
        CLEW_OPENCODE_BIN: 'clew-command-that-does-not-exist',
        CLEW_OPENCODE_URL: 'not-a-url',
      }),
    );

    assert.equal(required.ok, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
