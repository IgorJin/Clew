import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import {
  LiveThreadTerminalSurface,
  NoneSurface,
  PlainTerminalSurface,
  buildCodexResumeArgs,
  openSessionForRun,
} from '../src/session-surface.js';

test('live terminal opens immediately for a running worker without a Codex session id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-live-session-'));
  const calls = [];
  const surface = new LiveThreadTerminalSurface({
    nodeBin: '/usr/bin/node',
    clewBin: '/project/bin/clew.js',
    projectCwd: dir,
    launcher: (bin, args, options) => {
      calls.push({ bin, args, options });

      return { pid: 73 };
    },
  });
  const store = new Store(join(dir, 'state.sqlite'));

  store.createTask({
    id: 'LIVE-1',
    title: 'Live worker',
    goal: 'Inspect activity',
    profile: 'quick',
    acceptance: [{ id: 'AC-1', criterion: 'works' }],
  });
  store.createRun({
    id: 'run-live-1',
    taskId: 'LIVE-1',
    stageId: 'worker',
    attempt: 1,
    status: 'RUNNING',
    harness: 'codex',
    workspace: dir,
    profile: 'quick',
    policy: {},
  });
  const result = await openSessionForRun(
    store,
    {
      version: 1,
      taskId: 'LIVE-1',
      stageId: 'worker',
      role: 'worker',
      harness: 'codex',
      mode: 'live',
    },
    surface,
  );

  assert.equal(result.state, 'opened');
  assert.equal(result.sessionId, 'live:run-live-1');
  assert.deepEqual(calls[0].args, ['/project/bin/clew.js', 'task', 'result', 'LIVE-1', '--watch']);
  assert.equal(calls[0].options.cwd, dir);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('Codex resume arguments use argv safely and preserve model context', () => {
  assert.deepEqual(buildCodexResumeArgs({ sessionId: 'thread-1', model: 'gpt-test' }), [
    'resume',
    'thread-1',
    '--model',
    'gpt-test',
  ]);
  assert.throws(() => buildCodexResumeArgs({ sessionId: 'thread;rm -rf /' }), /unsafe/);
  assert.throws(
    () => buildCodexResumeArgs({ sessionId: 'thread-1', model: 'bad\nmodel' }),
    /invalid/,
  );
});

test('plain terminal surface opens the exact persisted Codex session without creating a run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-session-surface-'));
  const workspace = join(dir, 'workspace');

  mkdirSync(workspace);
  const calls = [];
  const surface = new PlainTerminalSurface({
    launcher: (bin, args, options) => {
      calls.push({ bin, args, options });

      return { pid: 42 };
    },
  });
  const store = new Store(join(dir, 'state.sqlite'));

  store.createTask({
    id: 'SESSION-1',
    title: 'Session',
    goal: 'Open',
    profile: 'quick',
    acceptance: [{ id: 'AC-1', criterion: 'works' }],
  });
  store.createRun({
    id: 'run-1',
    taskId: 'SESSION-1',
    stageId: 'worker',
    attempt: 1,
    status: 'COMPLETED',
    harness: 'codex',
    workspace,
    profile: 'quick',
    policy: {},
  });
  store.setRunIdentity('run-1', 'thread-1', 'turn-1');
  const before = store.listRuns('SESSION-1').length;
  const result = await openSessionForRun(
    store,
    {
      version: 1,
      taskId: 'SESSION-1',
      stageId: 'worker',
      role: 'worker',
      harness: 'codex',
      mode: 'resume',
    },
    surface,
  );

  assert.equal(result.state, 'resumed');
  assert.equal(result.sessionId, 'thread-1');
  assert.equal(calls[0].options.cwd, workspace);
  assert.deepEqual(calls[0].args, ['resume', 'thread-1']);
  assert.equal(store.listRuns('SESSION-1').length, before);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('unsupported, stale, and missing sessions return structured diagnostics', async () => {
  const none = await new NoneSurface().open({
    version: 1,
    taskId: 'T-1',
    role: 'worker',
    harness: 'opencode',
  });

  assert.equal(none.state, 'unavailable');
  assert.equal(none.code, 'SESSION_SURFACE_UNAVAILABLE');
  const dir = mkdtempSync(join(tmpdir(), 'clew-session-stale-'));
  const store = new Store(join(dir, 'state.sqlite'));

  store.createTask({
    id: 'SESSION-2',
    title: 'Session',
    goal: 'Open',
    profile: 'quick',
    acceptance: [{ id: 'AC-1', criterion: 'works' }],
  });
  store.createRun({
    id: 'run-2',
    taskId: 'SESSION-2',
    stageId: 'worker',
    attempt: 1,
    status: 'COMPLETED',
    harness: 'codex',
  });
  const result = await openSessionForRun(store, {
    version: 1,
    taskId: 'SESSION-2',
    stageId: 'worker',
    role: 'worker',
    harness: 'codex',
  });

  assert.equal(result.code, 'SESSION_ID_MISSING');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
