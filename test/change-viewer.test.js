import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ChangeViewerRegistry,
  WorktreePathViewer,
  createChangeViewerRegistry,
  resolveViewerLaunch,
} from '../src/change-viewer.js';

test('change viewer registry prefers explicit viewer and returns unified result', () => {
  const calls = [];
  const registry = new ChangeViewerRegistry({
    explicit: 'second',
    viewers: [
      {
        id: 'first',
        open: () => {
          calls.push('first');

          return { state: 'opened', viewer: 'first' };
        },
      },
      {
        id: 'second',
        open: () => {
          calls.push('second');

          return { state: 'opened', viewer: 'second' };
        },
      },
    ],
  });

  assert.deepEqual(registry.open({ workspace: '/tmp/worktree' }), {
    version: 1,
    state: 'opened',
    viewer: 'second',
  });
  assert.deepEqual(calls, ['second']);
});

test('default viewer order starts with Cursor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-viewer-'));
  const calls = [];

  try {
    const result = createChangeViewerRegistry({
      launcher: (bin) => {
        calls.push(bin);

        return { pid: 12 };
      },
    }).open({ workspace: dir });

    assert.equal(result.state, 'opened');
    assert.equal(result.viewer, 'cursor');
    assert.deepEqual(calls, ['cursor']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'macOS editor resolution falls back to installed application bundles',
  { skip: process.platform !== 'darwin' || !existsSync('/Applications/Cursor.app') },
  () => {
    const result = resolveViewerLaunch({
      command: 'clew-command-that-does-not-exist',
      application: 'Cursor',
      platform: 'darwin',
    });

    assert.deepEqual(result, { command: 'open', argsPrefix: ['-a', 'Cursor'] });
  },
);

test('falls back from Cursor to VS Code without copying the worktree path', () => {
  const calls = [];
  let copied = false;
  const registry = new ChangeViewerRegistry({
    viewers: [
      { id: 'cursor', open: () => ({ state: 'unavailable', viewer: 'cursor' }) },
      {
        id: 'vscode',
        open: () => {
          calls.push('vscode');

          return { state: 'opened', viewer: 'vscode' };
        },
      },
      {
        id: 'worktree-path',
        fallback: false,
        open: () => {
          copied = true;

          return { state: 'opened', viewer: 'worktree-path' };
        },
      },
    ],
  });

  assert.equal(registry.open({ workspace: '/tmp/worktree' }).viewer, 'vscode');
  assert.deepEqual(calls, ['vscode']);
  assert.equal(copied, false);
});

test('returns unavailable when editors are missing and rejects unsupported explicit viewers', () => {
  const viewers = [
    { id: 'cursor', open: () => ({ state: 'unavailable', viewer: 'cursor' }) },
    { id: 'vscode', open: () => ({ state: 'unavailable', viewer: 'vscode' }) },
    {
      id: 'worktree-path',
      fallback: false,
      open: () => ({ state: 'opened', viewer: 'worktree-path' }),
    },
  ];
  const unavailable = new ChangeViewerRegistry({ viewers }).open({ workspace: '/tmp/worktree' });
  const unsupported = new ChangeViewerRegistry({ viewers, explicit: 'jetbrains' }).open({
    workspace: '/tmp/worktree',
  });

  assert.equal(unavailable.state, 'unavailable');
  assert.equal(unavailable.code, 'NO_VIEWER_AVAILABLE');
  assert.equal(unsupported.state, 'unavailable');
  assert.equal(unsupported.code, 'VIEWER_UNSUPPORTED');
});

test('worktree-path viewer copies an absolute path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clew-copy-'));
  let copied;

  try {
    const result = new WorktreePathViewer({
      copy: (path) => {
        copied = path;
      },
    }).open({ workspace: dir });

    assert.equal(result.state, 'opened');
    assert.equal(result.viewer, 'worktree-path');
    assert.equal(result.path, dir);
    assert.equal(copied, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
