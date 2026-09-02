import test from 'node:test';
import assert from 'node:assert/strict';
import { createCodexLiveEndpoint, createRuntimeNamespace } from '../src/runtime.js';

test('runtime namespaces are deterministic and unique per run', () => {
  const first = createRuntimeNamespace('TASK-1', 'RUN-1');
  const same = createRuntimeNamespace('TASK-1', 'RUN-1');
  const other = createRuntimeNamespace('TASK-1', 'RUN-2');

  assert.deepEqual(first, same);
  assert.notEqual(first.value, other.value);
  assert.equal(first.taskId, 'TASK-1');
  assert.equal(first.runId, 'RUN-1');
});

test('Codex live endpoint is deterministic and scoped to the runtime namespace', () => {
  const namespace = createRuntimeNamespace('TASK-1', 'RUN-1');

  assert.equal(
    createCodexLiveEndpoint(namespace, { tempDirectory: '/tmp/clew-test' }),
    `/tmp/clew-test/${namespace.value}.sock`.replace(/^/, 'unix://'),
  );
});
