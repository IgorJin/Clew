export const ARCHITECTURE_RESULT_VERSION = 1;

function nonEmpty(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);

  return value.trim();
}

export function createArchitectureResult({
  task,
  plan,
  decisions = [],
  alternatives = [],
  risks = [],
  verification = [],
}) {
  if (!task || !plan) throw new Error('task and plan are required');
  const stages = (plan.stages ?? []).map((stage) => ({
    id: stage.id,
    goal: stage.goal,
    dependsOn: stage.dependsOn ?? [],
    harness: stage.harness ?? null,
  }));

  return validateArchitectureResult({
    version: ARCHITECTURE_RESULT_VERSION,
    taskId: task.id,
    summary: nonEmpty(task.goal ?? task.description, 'task goal'),
    decisions,
    alternatives,
    components: stages,
    risks: risks.length
      ? risks
      : [
          {
            level: task.risk ?? 'medium',
            description: 'Risk is tracked by the task contract and verification evidence.',
          },
        ],
    verification: verification.length
      ? verification
      : (task.verification ?? []).map((check) => ({
          command: check.command,
          expected: 'exit code 0',
        })),
    plan: { parallelizable: Boolean(plan.parallelizable), stages },
  });
}

export function validateArchitectureResult(result) {
  if (!result || typeof result !== 'object')
    throw new Error('architecture result must be an object');
  if (result.version !== ARCHITECTURE_RESULT_VERSION)
    throw new Error('unsupported architecture result version');
  nonEmpty(result.taskId, 'architecture result taskId');
  nonEmpty(result.summary, 'architecture result summary');
  for (const field of ['decisions', 'alternatives', 'components', 'risks', 'verification'])
    if (!Array.isArray(result[field]))
      throw new Error(`architecture result ${field} must be an array`);
  if (!result.plan || typeof result.plan !== 'object' || !Array.isArray(result.plan.stages))
    throw new Error('architecture result plan.stages must be an array');

  return result;
}
