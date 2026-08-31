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
