import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateTaskContract,
  assertValidTaskTransition,
  classifyFailure,
  FAILURE_CLASS,
  isSafeGitRef,
  validateExecutionPlan,
} from '../src/domain.js';

test('validates and normalizes a task contract', () => {
  const task = validateTaskContract({
    id: 'AUTH-142',
    title: 'Refresh',
    goal: 'Rotate',
    profile: 'quick',
    acceptance: ['old token is rejected'],
  });

  assert.equal(task.acceptance[0].id, 'AC-1');
});
test('rejects invalid transitions', () => {
  assert.throws(
    () => assertValidTaskTransition('COMPLETED', 'EXECUTING'),
    /invalid task transition/,
  );
  assert.doesNotThrow(() => assertValidTaskTransition('EXECUTING', 'RECOVERING'));
  assert.doesNotThrow(() => assertValidTaskTransition('RECOVERING', 'EXECUTING'));
});
test('classifies operational failures for retry policy', () => {
  assert.equal(classifyFailure({ code: 'HARNESS_TIMED_OUT' }), FAILURE_CLASS.TIMEOUT);
  assert.equal(
    classifyFailure({ code: 'EXTERNAL_HARNESS_UNAVAILABLE' }),
    FAILURE_CLASS.EXTERNAL_UNAVAILABLE,
  );
  assert.equal(classifyFailure({ name: 'IntegrationConflictError' }), FAILURE_CLASS.WORKSPACE);
  assert.equal(classifyFailure(new Error('unknown')), FAILURE_CLASS.UNKNOWN);
});
test('requires explicit ids for object acceptance criteria', () => {
  assert.throws(
    () =>
      validateTaskContract({
        id: 'T-1',
        title: 'Test',
        goal: 'Test',
        profile: 'quick',
        acceptance: [{ criterion: 'works' }],
      }),
    /acceptance\[0\]\.id is required/,
  );
});
test('rejects unsafe Git refs and plan stage ids', () => {
  assert.equal(isSafeGitRef('feature/safe-name'), true);
  assert.equal(isSafeGitRef('../main'), false);
  assert.equal(isSafeGitRef('-danger'), false);
  assert.throws(
    () =>
      validateTaskContract({
        id: 'T-REF',
        title: 'Ref',
        goal: 'Validate ref',
        profile: 'quick',
        base_ref: '../main',
        acceptance: ['safe'],
      }),
    /safe Git ref/,
  );
  assert.throws(
    () =>
      validateExecutionPlan({
        parallelizable: false,
        stages: [{ id: '../worker', goal: 'escape' }],
      }),
    /unsafe id/,
  );
});
test('validates an acyclic execution plan', () => {
  assert.equal(
    validateExecutionPlan({
      parallelizable: false,
      stages: [
        { id: 'a', goal: 'A' },
        { id: 'b', goal: 'B', dependsOn: ['a'] },
      ],
    }).stages[1].dependsOn[0],
    'a',
  );
  assert.throws(
    () =>
      validateExecutionPlan({
        parallelizable: false,
        stages: [
          { id: 'a', goal: 'A', dependsOn: ['b'] },
          { id: 'b', goal: 'B', dependsOn: ['a'] },
        ],
      }),
    /cycle/,
  );
});
