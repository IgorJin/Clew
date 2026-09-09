import test from 'node:test';
import assert from 'node:assert/strict';
import { pickFolder } from '../src/folder-picker.js';

test('macOS folder picker returns the selected POSIX path', async () => {
  const calls = [];
  const folder = await pickFolder({
    platform: 'darwin',
    runCommand: async (...args) => {
      calls.push(args);

      return { stdout: '/Users/me/dev/repo/\n', stderr: '' };
    },
  });

  assert.equal(folder, '/Users/me/dev/repo/');
  assert.equal(calls[0][0], 'osascript');
});

test('macOS folder picker treats user cancellation as an empty selection', async () => {
  const error = Object.assign(new Error('Command failed'), {
    code: 1,
    stderr: 'execution error: User canceled. (-128)',
  });

  assert.equal(
    await pickFolder({
      platform: 'darwin',
      runCommand: async () => {
        throw error;
      },
    }),
    null,
  );
});

test('Linux folder picker falls back from zenity to kdialog', async () => {
  const calls = [];
  const folder = await pickFolder({
    platform: 'linux',
    runCommand: async (command) => {
      calls.push(command);
      if (command === 'zenity') throw Object.assign(new Error('missing'), { code: 'ENOENT' });

      return { stdout: '/home/me/repo\n', stderr: '' };
    },
  });

  assert.equal(folder, '/home/me/repo');
  assert.deepEqual(calls, ['zenity', 'kdialog']);
});

test('folder picker reports unsupported platforms', async () => {
  await assert.rejects(() => pickFolder({ platform: 'aix' }), /unsupported on aix/);
});
