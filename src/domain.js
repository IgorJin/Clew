export const TASK_STATE = Object.freeze({
  DRAFT: 'DRAFT',
  PLAN_READY: 'PLAN_READY',
  QUEUED: 'QUEUED',
  RECOVERING: 'RECOVERING',
  EXECUTING: 'EXECUTING',
  VERIFYING: 'VERIFYING',
  REVIEWING: 'REVIEWING',
  WAITING_FOR_HUMAN: 'WAITING_FOR_HUMAN',
  READY: 'READY',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  BLOCKED: 'BLOCKED',
});

export const TASK_STATES = Object.freeze(Object.values(TASK_STATE));

export const STAGE_STATUS = Object.freeze({
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  BLOCKED: 'BLOCKED',
  CANCELLED: 'CANCELLED',
});

export const RUN_STATUS = Object.freeze({
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  INTERRUPTED: 'INTERRUPTED',
});

export const FAILURE_CLASS = Object.freeze({
  INTERRUPTED: 'interrupted',
  TIMEOUT: 'timeout',
  EXTERNAL_UNAVAILABLE: 'external_unavailable',
  WORKSPACE: 'workspace',
  REVIEW: 'review',
  UNKNOWN: 'unknown',
});

export const PLAN_STATUS = Object.freeze({
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
});

export const PROFILE_NAME = Object.freeze({
  QUICK: 'quick',
  STANDARD: 'standard',
  DEEP: 'deep',
});

export const HARNESS_NAME = Object.freeze({
  FAKE: 'fake',
  CODEX: 'codex',
  OPENCODE: 'opencode',
});

export const EXECUTION_MODE = Object.freeze({
  DIRECT: 'direct',
  ISOLATED: 'isolated',
  PARALLEL: 'parallel',
});

export function classifyFailure(error) {
  if (!error) return FAILURE_CLASS.UNKNOWN;
  if (error.code === 'HARNESS_INTERRUPTED') return FAILURE_CLASS.INTERRUPTED;
  if (error.code === 'HARNESS_TIMED_OUT') return FAILURE_CLASS.TIMEOUT;
  if (error.code === 'EXTERNAL_HARNESS_UNAVAILABLE') return FAILURE_CLASS.EXTERNAL_UNAVAILABLE;
  if (error.name === 'IntegrationConflictError' || error.code === 'WORKSPACE_ERROR')
    return FAILURE_CLASS.WORKSPACE;
  if (error.code === 'REVIEW_FAILED' || error.name === 'ReviewError') return FAILURE_CLASS.REVIEW;

  return FAILURE_CLASS.UNKNOWN;
}

const transitions = {
  [TASK_STATE.DRAFT]: [TASK_STATE.PLAN_READY, TASK_STATE.QUEUED, TASK_STATE.CANCELLED],
  [TASK_STATE.PLAN_READY]: [TASK_STATE.QUEUED, TASK_STATE.WAITING_FOR_HUMAN, TASK_STATE.CANCELLED],
  [TASK_STATE.QUEUED]: [
    TASK_STATE.RECOVERING,
    TASK_STATE.EXECUTING,
    TASK_STATE.WAITING_FOR_HUMAN,
    TASK_STATE.CANCELLED,
  ],
  [TASK_STATE.RECOVERING]: [
    TASK_STATE.EXECUTING,
    TASK_STATE.FAILED,
    TASK_STATE.BLOCKED,
    TASK_STATE.CANCELLED,
  ],
  [TASK_STATE.EXECUTING]: [
    TASK_STATE.RECOVERING,
    TASK_STATE.VERIFYING,
    TASK_STATE.FAILED,
    TASK_STATE.CANCELLED,
    TASK_STATE.WAITING_FOR_HUMAN,
  ],
  [TASK_STATE.VERIFYING]: [
    TASK_STATE.RECOVERING,
    TASK_STATE.REVIEWING,
    TASK_STATE.READY,
    TASK_STATE.FAILED,
    TASK_STATE.WAITING_FOR_HUMAN,
  ],
  [TASK_STATE.REVIEWING]: [
    TASK_STATE.RECOVERING,
    TASK_STATE.READY,
    TASK_STATE.COMPLETED,
    TASK_STATE.FAILED,
    TASK_STATE.WAITING_FOR_HUMAN,
  ],
  [TASK_STATE.WAITING_FOR_HUMAN]: [
    TASK_STATE.QUEUED,
    TASK_STATE.PLAN_READY,
    TASK_STATE.READY,
    TASK_STATE.CANCELLED,
    TASK_STATE.FAILED,
  ],
  [TASK_STATE.READY]: [TASK_STATE.COMPLETED, TASK_STATE.QUEUED, TASK_STATE.CANCELLED],
  [TASK_STATE.COMPLETED]: [],
  [TASK_STATE.FAILED]: [
    TASK_STATE.PLAN_READY,
    TASK_STATE.RECOVERING,
    TASK_STATE.QUEUED,
    TASK_STATE.CANCELLED,
  ],
  [TASK_STATE.CANCELLED]: [],
  [TASK_STATE.BLOCKED]: [TASK_STATE.RECOVERING, TASK_STATE.QUEUED],
};

export function assertValidTaskTransition(fromState, toState) {
  if (!transitions[fromState]?.includes(toState))
    throw new Error(`invalid task transition ${fromState} → ${toState}`);
}

export function validateTaskContract(contract) {
  if (!contract || typeof contract !== 'object') throw new Error('task contract must be an object');
  for (const field of ['id', 'title', 'goal', 'profile']) {
    if (typeof contract[field] !== 'string' || !contract[field].trim())
      throw new Error(`task.${field} is required`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/.test(contract.id))
    throw new Error('task.id must contain 2-64 safe characters');
  const acceptance = Array.isArray(contract.acceptance) ? contract.acceptance : [];

  if (!acceptance.length) throw new Error('task.acceptance must contain at least one criterion');
  const ids = new Set();

  for (let i = 0; i < acceptance.length; i++) {
    const item =
      typeof acceptance[i] === 'string'
        ? { id: `AC-${i + 1}`, criterion: acceptance[i] }
        : acceptance[i];

    if (!item?.criterion) throw new Error(`task.acceptance[${i}].criterion is required`);
    if (typeof item.id !== 'string' || !item.id.trim())
      throw new Error(`task.acceptance[${i}].id is required`);
    if (ids.has(item.id)) throw new Error(`duplicate acceptance id ${item.id}`);
    ids.add(item.id);
  }
  if (!Object.values(PROFILE_NAME).includes(contract.profile))
    throw new Error('task.profile must be quick, standard, or deep');
  const baseRef = contract.base_ref ?? 'HEAD';

  if (!isSafeGitRef(baseRef)) throw new Error('task.base_ref must be a safe Git ref');

  return {
    ...contract,
    risk: contract.risk ?? 'medium',
    base_ref: baseRef,
    acceptance: acceptance.map((x, i) =>
      typeof x === 'string' ? { id: `AC-${i + 1}`, criterion: x } : x,
    ),
  };
}

export function resolveProfile(profileName) {
  const common = { maxAttempts: 3, verification: 'targeted' };

  if (profileName === PROFILE_NAME.QUICK)
    return {
      ...common,
      name: profileName,
      mode: EXECUTION_MODE.DIRECT,
      harness: HARNESS_NAME.FAKE,
      review: false,
      architecture: false,
      maxWorkers: 1,
    };
  if (profileName === PROFILE_NAME.STANDARD)
    return {
      ...common,
      name: profileName,
      mode: EXECUTION_MODE.ISOLATED,
      harness: HARNESS_NAME.FAKE,
      review: true,
      architecture: false,
      maxWorkers: 1,
    };

  return {
    ...common,
    name: profileName,
    mode: EXECUTION_MODE.PARALLEL,
    harness: HARNESS_NAME.FAKE,
    review: true,
    architecture: true,
    integration: true,
    maxWorkers: 3,
  };
}

export function validateExecutionPlan(plan) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.stages) || !plan.stages.length)
    throw new Error('plan.stages must contain at least one stage');
  if (typeof plan.parallelizable !== 'boolean')
    throw new Error('plan.parallelizable must be a boolean');
  const ids = new Set();

  for (const stage of plan.stages) {
    if (!stage || typeof stage.id !== 'string' || !stage.id.trim())
      throw new Error('plan stage id is required');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(stage.id))
      throw new Error(`plan stage ${stage.id} has an unsafe id`);
    if (typeof stage.goal !== 'string' || !stage.goal.trim())
      throw new Error(`plan stage ${stage.id}.goal is required`);
    if (ids.has(stage.id)) throw new Error(`duplicate plan stage ${stage.id}`);
    ids.add(stage.id);
    if (stage.dependsOn !== undefined && !Array.isArray(stage.dependsOn))
      throw new Error(`plan stage ${stage.id}.dependsOn must be an array`);
  }
  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(plan.stages.map((stage) => [stage.id, stage]));

  function visitPlanStage(stageId) {
    if (visiting.has(stageId)) throw new Error('plan contains a cycle');
    if (visited.has(stageId)) return;
    const stage = byId.get(stageId);

    if (!stage) throw new Error(`plan dependency not found: ${stageId}`);
    visiting.add(stageId);
    for (const dependency of stage.dependsOn ?? []) visitPlanStage(dependency);
    visiting.delete(stageId);
    visited.add(stageId);
  }
  for (const stage of plan.stages) visitPlanStage(stage.id);

  return {
    ...plan,
    stages: plan.stages.map((stage) => ({ ...stage, dependsOn: stage.dependsOn ?? [] })),
  };
}

export function isSafeGitRef(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 255 &&
    !value.startsWith('-') &&
    !value.startsWith('/') &&
    !value.endsWith('/') &&
    !value.endsWith('.') &&
    !value.includes('..') &&
    !value.includes('@{') &&
    !value.endsWith('.lock') &&
    !/[\s~^:?*[\\]/.test(value)
  );
}
