import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFinalizationReport } from '../src/finalization.js';
import { TASK_STATE } from '../src/domain.js';

const task = {
  id: 'CLEW-FINAL',
  state: TASK_STATE.READY_TO_FINISH,
  contract: {
    profile: 'standard',
    acceptance: [{ id: 'AC-1', criterion: 'works' }],
    integration: { enabled: true },
  },
};

test('finalization gate returns an actionable ready report', () => {
  const report = buildFinalizationReport({
    task,
    manifest: {
      workspace: '/worktree',
      revision: 'abc123',
      evidence: [{ result: 'passed', revision: 'abc123', acceptanceCriteria: ['AC-1'] }],
      review: { verdict: 'pass' },
    },
    run: { id: 'run-1', workspace: '/worktree', profile: 'standard' },
    changes: { state: 'available', dirty: false },
    integration: {
      available: true,
      targetClean: true,
      targetCheckedOut: true,
      conflicts: false,
    },
    policy: { enabled: true, targetBranch: 'main', strategy: 'squash' },
  });

  assert.equal(report.ready, true);
  assert.deepEqual(report.blockingReasons, []);
  assert.deepEqual(report.availableActions, ['review_changes', 'integrate']);
  assert.equal(report.git.targetBranch, 'main');
});

test('finalization gate blocks missing verification evidence', () => {
  const report = buildFinalizationReport({
    task,
    manifest: { workspace: '/worktree', revision: 'abc123', evidence: [] },
    run: { id: 'run-1', workspace: '/worktree', profile: 'standard' },
    changes: { state: 'available', dirty: false },
    integration: {
      available: true,
      targetClean: true,
      targetCheckedOut: true,
      conflicts: false,
    },
    policy: { enabled: true },
  });

  assert.equal(report.ready, false);
  assert.match(report.blockingReasons.join(' '), /check/);
  assert.deepEqual(report.availableActions, ['review_changes', 'resolve_blockers']);
});

test('no-Git tasks can complete without a controller-local workspace', () => {
  const report = buildFinalizationReport({
    task: {
      ...task,
      state: TASK_STATE.READY,
      contract: {
        profile: 'quick',
        acceptance: ['works'],
        integration: { enabled: false },
      },
    },
    manifest: {
      revision: 'abc123',
      evidence: [{ result: 'passed', revision: 'abc123', acceptanceCriteria: ['AC-1'] }],
    },
    changes: { state: 'unavailable', reason: 'runner-local-unavailable', dirty: false },
    policy: { enabled: false },
  });

  assert.equal(report.ready, true);
  assert.ok(report.availableActions.includes('complete'));
});
