import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeNamespace } from '../src/runtime.js';

test('runtime namespaces are deterministic and unique per run', () => {
  const first = createRuntimeNamespace('TASK-1', 'RUN-1');
  const same = createRuntimeNamespace('TASK-1', 'RUN-1');
  const other = createRuntimeNamespace('TASK-1', 'RUN-2');

  assert.deepEqual(first, same);
  assert.notEqual(first.value, other.value);
  assert.equal(first.taskId, 'TASK-1');
  assert.equal(first.runId, 'RUN-1');
});
