import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function createTask(cwd, id, profile) {
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
