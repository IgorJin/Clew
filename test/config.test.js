import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, loadControllerRunnerConfig, loadRunnerConfig } from '../src/config.js';

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
      CLEW_CODEX_OPEN_DESKTOP: 'true',
    });

    assert.equal(config.codexBin, 'env-codex');
    assert.equal(config.openCodeUrl, 'http://user:4096');
    assert.equal(config.worktreeRoot, join(dir, '.state', 'worktrees'));
    assert.equal(config.openCodexDesktop, true);
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

test('resolves role-specific model configuration with environment precedence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-model-config-'));

  try {
    writeFileSync(
      join(dir, '.clew.json'),
      JSON.stringify({ models: { worker: 'project-worker', reviewer: 'project-reviewer' } }),
    );
    const config = loadConfig(dir, {
      CLEW_USER_CONFIG: join(dir, 'missing.json'),
      CLEW_WORKER_MODEL: 'env-worker',
      CLEW_ARCHITECT_MODEL: 'env-architect',
    });

    assert.deepEqual(config.models, {
      worker: 'env-worker',
      architect: 'env-architect',
      reviewer: 'project-reviewer',
      qa: null,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loads standalone Runner config without consulting project config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-runner-config-'));
  const userConfig = join(dir, 'user.json');
  const credentialFile = join(dir, 'runner.token');
  const workspace = join(dir, 'workspace');

  try {
    writeFileSync(credentialFile, 'file-secret\n');
    chmodSync(credentialFile, 0o600);
    writeFileSync(
      userConfig,
      JSON.stringify({
        runner: {
          id: 'runner-1',
          controllerUrl: 'wss://controller.example.test/runner/v1',
          credentialFile,
          stateDir: join(dir, 'state'),
          workspaces: { clew: workspace },
        },
      }),
    );
    const config = loadRunnerConfig({ CLEW_USER_CONFIG: userConfig });

    assert.equal(config.runnerId, 'runner-1');
    assert.equal(config.credential, 'file-secret');
    assert.deepEqual(config.workspaces, [{ id: 'clew', path: workspace }]);
    assert.deepEqual(config.capabilities, ['execute', 'runner_local_terminal']);
    assert.equal(
      JSON.stringify({ ...config, credential: undefined }).includes('file-secret'),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects unsafe or ambiguous Runner credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-runner-secret-'));
  const userConfig = join(dir, 'user.json');
  const credentialFile = join(dir, 'runner.token');

  try {
    writeFileSync(credentialFile, 'file-secret');
    chmodSync(credentialFile, 0o644);
    writeFileSync(
      userConfig,
      JSON.stringify({
        runner: {
          id: 'runner-1',
          controllerUrl: 'ws://127.0.0.1:4319',
          credentialFile,
        },
      }),
    );
    assert.throws(
      () => loadRunnerConfig({ CLEW_USER_CONFIG: userConfig }),
      /permissions must not be broader than 0600/,
    );
    chmodSync(credentialFile, 0o600);
    assert.throws(
      () => loadRunnerConfig({ CLEW_USER_CONFIG: userConfig, CLEW_RUNNER_TOKEN: 'second' }),
      /exactly one/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loads optional Controller Runner identity and credential outside project config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-controller-runner-config-'));
  const userConfig = join(dir, 'user.json');

  try {
    writeFileSync(userConfig, '{}');
    assert.equal(loadControllerRunnerConfig({ CLEW_USER_CONFIG: userConfig }), null);
    const configured = loadControllerRunnerConfig({
      CLEW_USER_CONFIG: userConfig,
      CLEW_CONTROLLER_RUNNER_ID: 'runner-1',
      CLEW_CONTROLLER_RUNNER_TOKEN: 'shared-secret',
    });

    assert.equal(configured.runnerId, 'runner-1');
    assert.equal(configured.credential, 'shared-secret');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
