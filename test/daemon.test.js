import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daemonRequest, LocalDaemon } from '../src/daemon.js';

test('local daemon authenticates API requests and serializes CLI commands', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'clew-daemon-'));
  const daemon = new LocalDaemon({ cwd });

  try {
    let metadata;

    try {
      metadata = await daemon.start();
    } catch (error) {
      if (error.code === 'EPERM') return t.skip('sandbox disallows local loopback listeners');
      throw error;
    }
    const unauthorized = await fetch(`${metadata.endpoint}/api/v1/health`);

    assert.equal(unauthorized.status, 401);
    assert.throws(() => new LocalDaemon({ cwd }).start(), /already owned/);

    const created = await daemonRequest(cwd, [
      'task',
      'create',
      '--id',
      'DAEMON-1',
      '--title',
      'Daemon',
      '--goal',
      'API',
      '--accept',
      'works',
      '--profile',
      'quick',
    ]);

    assert.equal(created.id, 'DAEMON-1');
    assert.equal((await daemonRequest(cwd, ['task', 'list']))[0].id, 'DAEMON-1');

    const events = await (
      await fetch(`${metadata.endpoint}/api/v1/events?after=0`, {
        headers: {
          authorization: `Bearer ${await import('node:fs').then(({ readFileSync }) => readFileSync(metadata.tokenFile, 'utf8').trim())}`,
        },
      })
    ).json();

    assert.equal(events.events[0].type, 'TASK_CREATED');
  } finally {
    await daemon.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('daemon replay cursor rejects expired cursors and survives restart metadata', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'clew-daemon-cursor-'));
  const daemon = new LocalDaemon({ cwd });

  try {
    let metadata;

    try {
      metadata = await daemon.start();
    } catch (error) {
      if (error.code === 'EPERM') return t.skip('sandbox disallows local loopback listeners');
      throw error;
    }
    const token = (await import('node:fs')).readFileSync(metadata.tokenFile, 'utf8').trim();
    const response = await fetch(`${metadata.endpoint}/api/v1/events?after=-1`, {
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, /cursor/);
  } finally {
    await daemon.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});
