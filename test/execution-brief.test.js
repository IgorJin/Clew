import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXECUTION_ROLE,
  compileHarnessPrompt,
  prepareExecutionBrief,
  validateExecutionBrief,
} from '../src/execution-brief.js';

const task = Object.freeze({
  id: 'AUTH-142',
  title: 'Refresh token rotation',
  goal: 'Rotate refresh tokens without breaking existing clients',
  acceptance: [
    { id: 'AC-1', criterion: 'a successful refresh issues a new token' },
    { id: 'AC-2', criterion: 'the previous token becomes invalid' },
  ],
  constraints: ['keep the current response shape'],
  non_goals: ['session management UI'],
  verification: [{ command: 'npm', args: ['test'] }],
});

test('prepares an immutable run-specific brief without changing the Task Contract', () => {
  const brief = prepareExecutionBrief({
    task,
    role: EXECUTION_ROLE.WORKER,
    stageId: 'backend',
    runId: 'run-2',
    attempt: 2,
    assignmentGoal: 'Implement rotation in the token service',
    reviewFindings: [
      { severity: 'blocking', criterion: 'AC-2', reason: 'Cover replay explicitly' },
    ],
  });

  assert.equal(brief.task.goal, task.goal);
  assert.equal(brief.assignment.goal, 'Implement rotation in the token service');
  assert.equal(brief.context.reviewFindings[0].reason, 'Cover replay explicitly');
  assert.equal(task.goal.includes('Cover replay explicitly'), false);
  assert.deepEqual(brief.requiredEvidence, [{ command: 'npm', args: ['test'] }]);
});

test('compiles role-specific harness prompts from the same Task Contract', () => {
  const worker = prepareExecutionBrief({ task, role: 'worker', stageId: 'worker' });
  const reviewer = prepareExecutionBrief({
    task,
    role: 'reviewer',
    stageId: 'review',
    assignmentGoal: 'Review revision abc123',
    revision: 'abc123',
    readOnly: true,
  });
  const workerPrompt = compileHarnessPrompt(worker, { harness: 'codex' });
  const reviewPrompt = compileHarnessPrompt(reviewer, { harness: 'codex' });

  assert.match(workerPrompt, /Implement only the supplied assignment/);
  assert.match(reviewPrompt, /Review the supplied revision/);
  assert.match(reviewPrompt, /Read-only operation/);
  assert.match(reviewPrompt, /abc123/);
  assert.match(workerPrompt, /keep the current response shape/);
  assert.notEqual(workerPrompt, reviewPrompt);
});

test('rejects invalid and unsupported execution briefs', () => {
  const brief = prepareExecutionBrief({ task });

  assert.throws(() => validateExecutionBrief({ ...brief, version: 2 }), /unsupported/);
  assert.throws(() => validateExecutionBrief({ ...brief, role: 'advisor' }), /role is invalid/);
  assert.throws(
    () => validateExecutionBrief({ ...brief, permissions: { write: 'yes' } }),
    /write must be boolean/,
  );
});

test('sanitizes local paths from bounded context', () => {
  const brief = prepareExecutionBrief({
    task,
    evidence: [{ workspace: '/Users/igorjan/private-repo', output: 'ok' }],
    requiredEvidence: [{ command: 'npm test -- /private/tmp/secret' }],
  });

  assert.equal(brief.context.evidence[0].workspace, '[LOCAL_PATH]');
  assert.match(brief.requiredEvidence[0].command, /\[LOCAL_PATH\]/);
});
