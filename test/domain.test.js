import test from 'node:test';
import assert from 'node:assert/strict';
import { validateContract, assertTaskTransition, validatePlan } from '../src/domain.js';

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
test('requires explicit ids for object acceptance criteria', () => {
  assert.throws(
    () =>
      validateContract({
        id: 'T-1',
        title: 'Test',
        goal: 'Test',
        profile: 'quick',
        acceptance: [{ criterion: 'works' }],
      }),
    /acceptance\[0\]\.id is required/,
  );
});
test('validates an acyclic execution plan', () => {
  assert.equal(
    validatePlan({ stages: [{ id: 'a' }, { id: 'b', dependsOn: ['a'] }] }).stages[1].dependsOn[0],
    'a',
  );
  assert.throws(
    () =>
      validatePlan({
        stages: [
          { id: 'a', dependsOn: ['b'] },
          { id: 'b', dependsOn: ['a'] },
        ],
      }),
    /cycle/,
  );
});
