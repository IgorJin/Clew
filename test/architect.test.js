import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexArchitect, FakeArchitect, PLAN_OUTPUT_SCHEMA } from '../src/architect.js';

const task = {
  id: 'T-22',
  title: 'Architecture',
  goal: 'Design the implementation',
  acceptance: [{ id: 'AC-1', criterion: 'works' }],
};

test('fake architect produces a terminal integration stage', async () => {
  const plan = await new FakeArchitect().createPlan({ task });

  const integration = plan.stages.find((stage) => stage.kind === 'integration');
  assert.ok(integration);
  assert.deepEqual(integration.dependsOn, ['backend', 'frontend']);
});

test('Codex architect requests a read-only structured plan', async () => {
  let request;
  const expectedPlan = {
    parallelizable: false,
    stages: [
      { id: 'worker', kind: 'worker', goal: 'Implement', dependsOn: [] },
      {
        id: 'integration',
        kind: 'integration',
        goal: 'Verify',
        dependsOn: ['worker'],
      },
    ],
  };
  const architect = new CodexArchitect({
    run: async (input) => {
      request = input;
      return { output: { output: expectedPlan } };
    },
  });

  const plan = await architect.createPlan({ task, cwd: '/fixture' });

  assert.deepEqual(plan, expectedPlan);
  assert.equal(request.cwd, '/fixture');
  assert.equal(request.readOnly, true);
  assert.deepEqual(request.outputSchema, PLAN_OUTPUT_SCHEMA);
});
