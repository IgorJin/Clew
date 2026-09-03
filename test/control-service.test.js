import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../src/config.js';
import { ClewService } from '../src/control-service.js';
import { Store } from '../src/store.js';

test('ClewService is the shared command and snapshot boundary', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'clew-service-'));
  const stateDirectory = join(cwd, '.clew');

  mkdirSync(stateDirectory);
  const store = new Store(join(stateDirectory, 'clew.sqlite'));
  const service = new ClewService({ cwd, store, config: DEFAULT_CONFIG });

  try {
    assert.equal(service.supports(['task', 'create']), true);
    for (const args of [
      ['task', 'result'],
      ['task', 'usage'],
      ['status'],
      ['events'],
      ['worktree', 'list'],
      ['telemetry', 'status'],
      ['doctor'],
    ])
      assert.equal(service.supports(args), true, `${args.join(' ')} should use ClewService`);
    assert.equal(service.supports(['--help']), false);
    await assert.rejects(() => service.execute(['--help']), /unsupported service command/);

    const contract = await service.execute([
      'task',
      'create',
      '--id',
      'SERVICE-1',
      '--title',
      'Shared service',
      '--goal',
      'Serve CLI and daemon',
      '--accept',
      'one implementation',
    ]);

    assert.equal(contract.id, 'SERVICE-1');
    assert.equal((await service.execute(['task', 'list']))[0].id, 'SERVICE-1');
    assert.equal((await service.execute(['task', 'show', 'SERVICE-1'])).state, 'DRAFT');

    await service.execute([
      'task',
      'message',
      'SERVICE-1',
      '--message',
      'shared command path',
      '--actor',
      'test',
    ]);
    const thread = await service.execute(['task', 'thread', 'SERVICE-1']);

    assert.equal(
      thread.items.some((item) => item.kind === 'operator_message' && item.redacted),
      true,
    );
    assert.equal((await service.execute(['task', 'history', 'SERVICE-1'])).events.length, 2);
    assert.equal((await service.execute(['task', 'usage', 'SERVICE-1'])).taskId, 'SERVICE-1');
    assert.equal((await service.execute(['status', 'SERVICE-1'])).state, 'DRAFT');
    assert.equal((await service.execute(['events', 'SERVICE-1'])).length, 2);
    assert.equal((await service.execute(['telemetry', 'status'])).state, 'disabled');
    assert.equal(service.snapshot().tasks[0].show.id, 'SERVICE-1');
  } finally {
    store.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('MVP exposes one durable next step and requires an explicit approval', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'clew-service-next-step-'));
  const store = new Store(join(cwd, '.clew', 'clew.sqlite'));
  const service = new ClewService({ cwd, store, config: DEFAULT_CONFIG });

  try {
    await service.execute([
      'task',
      'create',
      '--id',
      'MVP-1',
      '--title',
      'Read-only task',
      '--description',
      'Read one file without changing it',
    ]);
    const first = await service.execute(['task', 'next-step', 'MVP-1']);
    const second = await service.execute(['task', 'next-step', 'MVP-1']);

    assert.equal(first.id, second.id);
    assert.equal(first.status, 'PENDING');
    assert.equal(first.approvalRequired, true);
    assert.equal(first.inputs.harness, 'codex');
    assert.equal(first.inputs.model, undefined);
    assert.equal(store.getTask('MVP-1').state, 'DRAFT');
    assert.equal(store.listRuns('MVP-1').length, 0);
  } finally {
    store.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('task open-changes opens the latest run workspace in the configured editor', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'clew-service-open-changes-'));
  const store = new Store(join(cwd, '.clew', 'clew.sqlite'));
  const calls = [];
  const service = new ClewService({
    cwd,
    store,
    config: { ...DEFAULT_CONFIG, editorBin: 'code' },
    editorLauncher: (bin, args) => {
      calls.push({ bin, args });

      return { pid: 99 };
    },
  });

  try {
    await service.execute([
      'task',
      'create',
      '--id',
      'OPEN-1',
      '--title',
      'Open changes',
      '--description',
      'Open the workspace',
    ]);
    const workspace = join(cwd, '.clew', 'worktrees', 'OPEN-1');

    mkdirSync(workspace, { recursive: true });
    store.createRun({
      id: 'run-open-1',
      taskId: 'OPEN-1',
      stageId: 'worker',
      attempt: 1,
      status: 'COMPLETED',
      harness: 'codex',
      workspace,
      profile: 'quick',
      policy: {},
    });
    const result = await service.execute(['task', 'open-changes', 'OPEN-1']);

    assert.equal(result.state, 'opened');
    assert.equal(result.workspace, workspace);
    assert.equal(calls[0].bin, 'code');
    assert.deepEqual(calls[0].args, [workspace]);
    assert.equal(service.supports(['task', 'open-changes']), true);
    await assert.rejects(() => service.execute(['task', 'open-changes', 'MISSING']), /not found/);
  } finally {
    store.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('task open-changes selects an explicit run and viewer', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'clew-service-open-selected-'));
  const store = new Store(join(cwd, '.clew', 'clew.sqlite'));
  const calls = [];
  const service = new ClewService({
    cwd,
    store,
    config: { ...DEFAULT_CONFIG, changeViewer: 'vscode' },
    editorLauncher: (bin, args) => {
      calls.push({ bin, args });

      return { pid: 7 };
    },
  });

  try {
    await service.execute([
      'task',
      'create',
      '--id',
      'OPEN-2',
      '--title',
      'Selected',
      '--description',
      'Select a run',
    ]);
    const first = join(cwd, '.clew', 'worktrees', 'OPEN-2-first');
    const second = join(cwd, '.clew', 'worktrees', 'OPEN-2-second');

    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    store.createRun({
      id: 'run-open-2-first',
      taskId: 'OPEN-2',
      stageId: 'worker',
      attempt: 1,
      status: 'COMPLETED',
      harness: 'codex',
      workspace: first,
      profile: 'quick',
      policy: {},
    });
    store.createRun({
      id: 'run-open-2-second',
      taskId: 'OPEN-2',
      stageId: 'worker',
      attempt: 2,
      status: 'COMPLETED',
      harness: 'codex',
      workspace: second,
      profile: 'quick',
      policy: {},
    });
    const result = await service.execute([
      'task',
      'open-changes',
      'OPEN-2',
      '--run',
      'run-open-2-first',
    ]);

    assert.equal(result.viewer, 'vscode');
    assert.equal(result.workspace, first);
    assert.deepEqual(calls[0].args, [first]);
  } finally {
    store.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});
