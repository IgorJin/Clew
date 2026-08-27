import test from 'node:test';
import assert from 'node:assert/strict';
import { validateContract, assertTaskTransition } from '../src/domain.js';

test('validates and normalizes a task contract', () => {
  const task = validateContract({
    id: 'AUTH-142',
    title: 'Refresh',
    goal: 'Rotate',
    profile: 'quick',
    acceptance: ['old token is rejected'],
  });
  assert.equal(task.acceptance[0].id, 'AC-1');
});
test('rejects invalid transitions', () => {
  assert.throws(() => assertTaskTransition('COMPLETED', 'EXECUTING'), /invalid task transition/);
});
