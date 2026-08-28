import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { Store } from '../src/store.js';

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

test('CLI exposes redacted operator messages through Task Thread', () => {
  const repo = mkdtempSync(join(tmpdir(), 'clew-cli-thread-'));

  try {
    runCli(['init'], repo);
    runCli(
      [
        'task',
        'create',
        '--id',
        'CLI-THREAD',
        '--title',
        'CLI thread',
        '--goal',
        'Expose operator context',
        '--accept',
        'message appears safely',
      ],
      repo,
    );
    runCli(
      ['task', 'message', 'CLI-THREAD', '--message', 'token=super-secret', '--actor', 'reviewer'],
      repo,
    );
    const thread = JSON.parse(runCli(['task', 'thread', 'CLI-THREAD'], repo));

    assert.equal(thread.version, 1);
    const message = thread.items.find((item) => item.kind === 'operator_message');

    assert.equal(message.actor, 'reviewer');
    assert.doesNotMatch(message.summary, /super-secret/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI continue from READY is redacted and duplicate-safe', () => {
  const repo = mkdtempSync(join(tmpdir(), 'clew-cli-continue-ready-'));

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
        'CLI-CONT-READY',
        '--title',
        'Continue ready',
        '--goal',
        'Exercise continuation',
        '--accept',
        'continuation completes',
        '--profile',
        'standard',
      ],
      repo,
    );
    const initial = JSON.parse(runCli(['run', 'CLI-CONT-READY', '--harness', 'fake'], repo));
    const message = 'Apply Bearer secret-value';
    const continued = JSON.parse(
      runCli(['continue', 'CLI-CONT-READY', '--message', message, '--actor', 'fixture'], repo),
    );
    const replay = JSON.parse(
      runCli(['continue', 'CLI-CONT-READY', '--message', message, '--actor', 'fixture'], repo),
    );
    const history = JSON.parse(runCli(['task', 'history', 'CLI-CONT-READY'], repo));
    const store = new Store(join(repo, '.clew', 'clew.sqlite'));
    const operatorMessage = store.listOperatorMessages('CLI-CONT-READY')[0];

    store.close();
    assert.equal(initial.state, 'READY');
    assert.equal(continued.result.state, 'READY');
    assert.equal(replay.duplicate, true);
    assert.equal(history.runs.length, 2);
    assert.equal(
      history.events.filter((event) => event.type === 'CONTINUATION_COMPLETED').length,
      1,
    );
    assert.equal(operatorMessage.message, 'Apply Bearer [REDACTED]');
    assert.ok(operatorMessage.target.sessionId);
    assert.equal(operatorMessage.target.cause, 'operator_feedback');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('CLI continue grants one correction from WAITING_FOR_HUMAN', () => {
  const repo = mkdtempSync(join(tmpdir(), 'clew-cli-continue-waiting-'));

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
        'CLI-CONT-WAIT',
        '--title',
        'Continue waiting',
        '--goal',
        'Exercise human handoff',
        '--accept',
        'correction completes',
        '--profile',
        'standard',
      ],
      repo,
    );
    const waiting = JSON.parse(
      runCommand(process.execPath, [cliFile, 'run', 'CLI-CONT-WAIT', '--harness', 'fake'], repo, {
        CLEW_FAKE_REVIEW: 'request_changes',
      }),
    );
    const before = JSON.parse(runCli(['task', 'history', 'CLI-CONT-WAIT'], repo));
    const continued = JSON.parse(
      runCli(['continue', 'CLI-CONT-WAIT', '--message', 'Resolve the final finding'], repo),
    );
    const after = JSON.parse(runCli(['task', 'history', 'CLI-CONT-WAIT'], repo));

    assert.equal(waiting.state, 'WAITING_FOR_HUMAN');
    assert.equal(continued.result.state, 'READY');
    assert.equal(after.runs.length, before.runs.length + 1);
    assert.equal(
      after.events.filter((event) => event.type === 'REVIEW_RECORDED').length,
      before.events.filter((event) => event.type === 'REVIEW_RECORDED').length + 1,
    );
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
      ['node', 'git', 'telemetry', 'codex-cli', 'codex-auth', 'opencode-cli', 'opencode-endpoint'],
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
