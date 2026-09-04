import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createArchitectureResult,
  validateArchitectureResult,
} from '../src/architecture-result.js';

test('creates a versioned architecture result from a validated plan', () => {
  const result = createArchitectureResult({
    task: {
      id: 'TASK-1',
      goal: 'Ship the feature',
      risk: 'medium',
      verification: [{ command: 'npm test' }],
    },
    plan: {
      parallelizable: true,
      stages: [{ id: 'worker', goal: 'Implement the feature', dependsOn: [] }],
    },
  });

  assert.equal(result.version, 1);
  assert.equal(result.taskId, 'TASK-1');
  assert.equal(result.components[0].id, 'worker');
  assert.equal(result.verification[0].command, 'npm test');
  assert.equal(validateArchitectureResult(result), result);
});

test('rejects architecture results without a summary or plan', () => {
  assert.throws(() => validateArchitectureResult({ version: 1, taskId: 'TASK-1' }), /summary/);
});
