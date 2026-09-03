import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ChangeViewerRegistry,
  WorktreePathViewer,
  createChangeViewerRegistry,
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
    state: 'opened',
    viewer: 'second',
  });
  assert.deepEqual(calls, ['second']);
});

test('default viewer order is Cursor, VS Code, then worktree path', () => {
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
