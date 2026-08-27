export const TASK_STATES = Object.freeze([
  'DRAFT',
  'PLAN_READY',
  'QUEUED',
  'EXECUTING',
  'VERIFYING',
  'REVIEWING',
  'WAITING_FOR_HUMAN',
  'READY',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'BLOCKED',
]);

const transitions = {
  DRAFT: ['PLAN_READY', 'QUEUED', 'CANCELLED'],
  PLAN_READY: ['QUEUED', 'WAITING_FOR_HUMAN', 'CANCELLED'],
  QUEUED: ['EXECUTING', 'WAITING_FOR_HUMAN', 'CANCELLED'],
  EXECUTING: ['VERIFYING', 'FAILED', 'CANCELLED', 'WAITING_FOR_HUMAN'],
  VERIFYING: ['REVIEWING', 'READY', 'FAILED', 'WAITING_FOR_HUMAN'],
  REVIEWING: ['READY', 'COMPLETED', 'FAILED', 'WAITING_FOR_HUMAN'],
  WAITING_FOR_HUMAN: ['QUEUED', 'PLAN_READY', 'READY', 'CANCELLED', 'FAILED'],
  READY: ['COMPLETED', 'QUEUED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: ['QUEUED', 'CANCELLED'],
  CANCELLED: [],
  BLOCKED: ['QUEUED'],
};

export function assertTaskTransition(from, to) {
  if (!transitions[from]?.includes(to)) throw new Error(`invalid task transition ${from} → ${to}`);
}

export function validateContract(input) {
  if (!input || typeof input !== 'object') throw new Error('task contract must be an object');
  for (const field of ['id', 'title', 'goal', 'profile']) {
    if (typeof input[field] !== 'string' || !input[field].trim())
      throw new Error(`task.${field} is required`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/.test(input.id))
    throw new Error('task.id must contain 2-64 safe characters');
  const acceptance = Array.isArray(input.acceptance) ? input.acceptance : [];
  if (!acceptance.length) throw new Error('task.acceptance must contain at least one criterion');
  const ids = new Set();
  for (let i = 0; i < acceptance.length; i++) {
    const item =
      typeof acceptance[i] === 'string'
        ? { id: `AC-${i + 1}`, criterion: acceptance[i] }
        : acceptance[i];
    if (!item?.criterion) throw new Error(`task.acceptance[${i}].criterion is required`);
    if (ids.has(item.id)) throw new Error(`duplicate acceptance id ${item.id}`);
    ids.add(item.id);
  }
  if (!['quick', 'standard', 'deep'].includes(input.profile))
    throw new Error('task.profile must be quick, standard, or deep');
  return {
    ...input,
    risk: input.risk ?? 'medium',
    base_ref: input.base_ref ?? 'HEAD',
    acceptance: acceptance.map((x, i) =>
      typeof x === 'string' ? { id: `AC-${i + 1}`, criterion: x } : x,
    ),
  };
}

export function effectiveProfile(name) {
  const common = { maxAttempts: 3, verification: 'targeted' };
  if (name === 'quick')
    return {
      ...common,
      name,
      mode: 'direct',
      harness: 'fake',
      review: false,
      architecture: false,
      maxWorkers: 1,
    };
  if (name === 'standard')
    return {
      ...common,
      name,
      mode: 'isolated',
      harness: 'fake',
      review: true,
      architecture: false,
      maxWorkers: 1,
    };
  return {
    ...common,
    name,
    mode: 'parallel',
    harness: 'fake',
    review: true,
    architecture: true,
    integration: true,
    maxWorkers: 3,
  };
}
