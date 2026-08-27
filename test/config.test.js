import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

test('resolves user, project, and environment config precedence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-config-'));
  const userConfig = join(dir, 'user.json');

  try {
    writeFileSync(
      userConfig,
      JSON.stringify({ codexBin: 'user-codex', openCodeUrl: 'http://user:4096' }),
    );
    writeFileSync(
      join(dir, '.clew.json'),
      JSON.stringify({ codexBin: 'project-codex', worktreeRoot: '.state/worktrees' }),
    );
    const config = loadConfig(dir, {
      CLEW_USER_CONFIG: userConfig,
      CLEW_CODEX_BIN: 'env-codex',
    });

    assert.equal(config.codexBin, 'env-codex');
    assert.equal(config.openCodeUrl, 'http://user:4096');
    assert.equal(config.worktreeRoot, join(dir, '.state', 'worktrees'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects secrets and absolute paths in project config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-config-security-'));

  try {
    writeFileSync(
      join(dir, '.clew.json'),
      JSON.stringify({ adapter: { apiToken: 'must-not-live-here' } }),
    );
    assert.throws(
      () => loadConfig(dir, { CLEW_USER_CONFIG: join(dir, 'missing.json') }),
      /must not contain secret field/,
    );
    writeFileSync(join(dir, '.clew.json'), JSON.stringify({ worktreeRoot: '/tmp/escape' }));
    assert.throws(
      () => loadConfig(dir, { CLEW_USER_CONFIG: join(dir, 'missing.json') }),
      /must be relative/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
