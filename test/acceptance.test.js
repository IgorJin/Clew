import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const cliFile = fileURLToPath(new URL('../bin/clew.js', import.meta.url));

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function clew(args, cwd) {
  return JSON.parse(run(process.execPath, [cliFile, ...args], cwd));
}

function createTask(cwd, id, profile, verification = false) {
  return run(
    process.execPath,
    [
      cliFile,
      'task',
      'create',
      '--id',
      id,
      '--title',
      `${profile} acceptance`,
      '--goal',
      `Run the ${profile} acceptance fixture`,
      '--accept',
      'the fixture reaches READY',
      '--profile',
      profile,
      ...(verification ? ['--verify', 'node --version'] : []),
    ],
    cwd,
  );
}

test('clean-checkout acceptance fixture passes Quick, Standard, and Deep profiles', () => {
  const repo = mkdtempSync(join(tmpdir(), 'clew-acceptance-'));

  try {
    run('git', ['init', '-b', 'main'], repo);
    run('git', ['config', 'user.email', 'test@example.com'], repo);
    run('git', ['config', 'user.name', 'Clew Acceptance'], repo);
    writeFileSync(join(repo, 'README.md'), 'acceptance fixture\n');
    run('git', ['add', 'README.md'], repo);
    run('git', ['commit', '-m', 'acceptance fixture'], repo);
    run(process.execPath, [cliFile, 'init'], repo);

    createTask(repo, 'ACC-QUICK', 'quick');
    createTask(repo, 'ACC-STANDARD', 'standard');
    createTask(repo, 'ACC-DEEP', 'deep');

    assert.equal(clew(['run', 'ACC-QUICK', '--harness', 'fake'], repo).state, 'READY');
    assert.equal(clew(['run', 'ACC-STANDARD', '--harness', 'fake'], repo).state, 'READY');
    assert.equal(
      clew(['run', 'ACC-DEEP', '--harness', 'fake', '--architect', 'fake'], repo).state,
      'WAITING_FOR_HUMAN',
    );
    assert.equal(clew(['approve', 'ACC-DEEP'], repo).status, 'APPROVED');
    assert.equal(clew(['run', 'ACC-DEEP', '--harness', 'fake'], repo).state, 'READY');
    assert.equal(readFileSync(join(repo, 'README.md'), 'utf8'), 'acceptance fixture\n');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('v0.2 local lifecycle exports, completes, and cleans a pinned result', () => {
  const repo = mkdtempSync(join(tmpdir(), 'clew-v02-lifecycle-'));
  const output = mkdtempSync(join(tmpdir(), 'clew-v02-export-'));

  try {
    run('git', ['init', '-b', 'main'], repo);
    run('git', ['config', 'user.email', 'test@example.com'], repo);
    run('git', ['config', 'user.name', 'Clew v0.2'], repo);
    writeFileSync(join(repo, '.gitignore'), '.clew/\n');
    writeFileSync(join(repo, 'README.md'), 'v0.2 acceptance\n');
    run('git', ['add', '.gitignore', 'README.md'], repo);
    run('git', ['commit', '-m', 'v0.2 acceptance'], repo);
    run(process.execPath, [cliFile, 'init'], repo);
    createTask(repo, 'ACC-V02', 'quick', true);

    assert.equal(clew(['run', 'ACC-V02', '--harness', 'fake'], repo).state, 'READY');
    const result = clew(['task', 'result', 'ACC-V02'], repo);

    assert.equal(result.state, 'READY');
    assert.ok(result.revision);
    assert.ok(result.attempts[0].runtimeNamespace.value);

    const verification = clew(
      ['verify', 'ACC-V02', '--revision', result.revision, '--actor', 'verifier'],
      repo,
    );

    assert.equal(verification.evidence[0].result, 'passed');

    const exported = clew(['export', 'ACC-V02', '--dir', output], repo);

    assert.equal(exported.revision, result.revision);
    assert.ok(existsSync(join(output, 'ACC-V02.manifest.json')));
    assert.ok(existsSync(join(output, 'ACC-V02.bundle')));
    assert.equal(
      clew(['complete', 'ACC-V02', '--revision', result.revision, '--actor', 'acceptor'], repo)
        .actor,
      'acceptor',
    );
    assert.equal(clew(['task', 'show', 'ACC-V02'], repo).state, 'COMPLETED');
    assert.ok(clew(['cleanup', '--retention-days', '0'], repo).removed.length > 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(output, { recursive: true, force: true });
  }
});
