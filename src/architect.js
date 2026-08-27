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
          goal: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'kind', 'goal', 'dependsOn'],
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

export class CodexArchitect {
  constructor(harness) {
    this.harness = harness;
  }

  async createPlan({ task, cwd }) {
    const result = await this.harness.run({
      task: {
        ...task,
        title: `Architecture plan: ${task.title}`,
        goal: `${task.goal}\n\nProduce an implementation DAG. Every stage must feed one terminal integration stage with kind=integration. Do not modify files.`,
      },
      cwd,
      model: process.env.CLEW_ARCHITECT_MODEL || 'sol',
      readOnly: true,
      outputSchema: PLAN_OUTPUT_SCHEMA,
      onEvent: () => {},
    });
    const plan = result.output?.output ?? result.output;
    if (!plan || typeof plan !== 'object')
      throw new Error('Codex architect did not return a structured plan');
    return plan;
  }
}
