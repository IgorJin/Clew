/** CLEW-128: `CodexArchitect` moved to `src/plugins/codex/role-services.js`.
 * This module keeps the harness-agnostic plan schema and the fake architect.
 */

export const PLAN_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    parallelizable: { type: 'boolean' },
    stages: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          kind: { type: 'string' },
          harness: { enum: ['codex', 'opencode', null] },
          goal: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'kind', 'harness', 'goal', 'dependsOn'],
        additionalProperties: false,
      },
    },
  },
  required: ['parallelizable', 'stages'],
  additionalProperties: false,
};

export class FakeArchitect {
  async createPlan({ task }) {
    return {
      parallelizable: true,
      stages: [
        { id: 'backend', kind: 'worker', goal: `${task.goal} (backend)`, dependsOn: [] },
        { id: 'frontend', kind: 'worker', goal: `${task.goal} (frontend)`, dependsOn: [] },
        {
          id: 'integration',
          kind: 'integration',
          goal: `${task.goal} (integration)`,
          dependsOn: ['backend', 'frontend'],
        },
      ],
    };
  }
}
