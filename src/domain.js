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
  VERIFICATION: 'verification',
  REVIEW: 'review',
  UNKNOWN: 'unknown',
});

export const PLAN_STATUS = Object.freeze({
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
});

export const REVIEW_VERDICT = Object.freeze({
  PASS: 'pass',
  REQUEST_CHANGES: 'request_changes',
  NEEDS_HUMAN: 'needs_human',
});

export const FINDING_SEVERITY = Object.freeze({
  BLOCKING: 'blocking',
  WARNING: 'warning',
});

export const RISK_LEVEL = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
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

export const OPERATOR_ACTION = Object.freeze({
  RETRY: 'retry',
  VERIFY: 'verify',
  COMPLETE: 'complete',
});

export const COMPLETION_DECISION = Object.freeze({
  ACCEPT: 'accept',
});

export function validateRetryRequest(request) {
  if (!request || typeof request !== 'object') throw new Error('retry request must be an object');
  for (const field of ['taskId', 'stageId', 'actor'])
    if (typeof request[field] !== 'string' || !request[field].trim())
      throw new Error(`retry.${field} is required`);
  if (request.reason !== undefined && typeof request.reason !== 'string')
    throw new Error('retry.reason must be a string');

  return { ...request, reason: request.reason ?? null };
}

export function validateCompletionDecision(decision) {
  if (!decision || typeof decision !== 'object')
    throw new Error('completion decision must be an object');
  for (const field of ['taskId', 'expectedRevision', 'actor'])
    if (typeof decision[field] !== 'string' || !decision[field].trim())
      throw new Error(`completion.${field} is required`);
  if (!Object.values(COMPLETION_DECISION).includes(decision.decision ?? COMPLETION_DECISION.ACCEPT))
    throw new Error('completion.decision is invalid');
  if (decision.note !== undefined && decision.note !== null && typeof decision.note !== 'string')
    throw new Error('completion.note must be a string');
  if (decision.reviewOverride !== undefined && typeof decision.reviewOverride !== 'boolean')
    throw new Error('completion.reviewOverride must be boolean');
  if (decision.unresolvedFindings !== undefined && !Array.isArray(decision.unresolvedFindings))
    throw new Error('completion.unresolvedFindings must be an array');
  if (
    decision.idempotencyKey !== undefined &&
    decision.idempotencyKey !== null &&
    typeof decision.idempotencyKey !== 'string'
  )
    throw new Error('completion.idempotencyKey must be a string');

  return {
    ...decision,
    decision: decision.decision ?? COMPLETION_DECISION.ACCEPT,
    note: decision.note ?? null,
    reviewOverride: decision.reviewOverride ?? false,
    unresolvedFindings: decision.unresolvedFindings ?? [],
    idempotencyKey: decision.idempotencyKey ?? null,
  };
}

export function validateRuntimeNamespace(namespace) {
  if (!namespace || typeof namespace !== 'object')
    throw new Error('runtime namespace must be an object');
  for (const field of ['taskId', 'runId', 'value'])
    if (typeof namespace[field] !== 'string' || !namespace[field].trim())
      throw new Error(`runtimeNamespace.${field} is required`);

  return namespace;
}

export function validateResultManifest(manifest) {
  if (!manifest || typeof manifest !== 'object')
    throw new Error('result manifest must be an object');
  for (const field of ['taskId', 'state'])
    if (typeof manifest[field] !== 'string' || !manifest[field].trim())
      throw new Error(`result.${field} is required`);
  if (!Array.isArray(manifest.attempts)) throw new Error('result.attempts must be an array');

  return manifest;
}

export function classifyFailure(error) {
  if (!error) return FAILURE_CLASS.UNKNOWN;
  if (error.code === 'HARNESS_INTERRUPTED') return FAILURE_CLASS.INTERRUPTED;
  if (error.code === 'HARNESS_TIMED_OUT') return FAILURE_CLASS.TIMEOUT;
  if (error.code === 'EXTERNAL_HARNESS_UNAVAILABLE') return FAILURE_CLASS.EXTERNAL_UNAVAILABLE;
  if (error.name === 'IntegrationConflictError' || error.code === 'WORKSPACE_ERROR')
    return FAILURE_CLASS.WORKSPACE;
  if (error.code === 'VERIFICATION_FAILED') return FAILURE_CLASS.VERIFICATION;
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
    TASK_STATE.QUEUED,
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
  [TASK_STATE.READY]: [
    TASK_STATE.COMPLETED,
    TASK_STATE.QUEUED,
    TASK_STATE.VERIFYING,
    TASK_STATE.CANCELLED,
  ],
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

  for (let acceptanceIndex = 0; acceptanceIndex < acceptance.length; acceptanceIndex++) {
    const item =
      typeof acceptance[acceptanceIndex] === 'string'
        ? { id: `AC-${acceptanceIndex + 1}`, criterion: acceptance[acceptanceIndex] }
        : acceptance[acceptanceIndex];

    if (!item?.criterion)
      throw new Error(`task.acceptance[${acceptanceIndex}].criterion is required`);
    if (typeof item.id !== 'string' || !item.id.trim())
      throw new Error(`task.acceptance[${acceptanceIndex}].id is required`);
    if (ids.has(item.id)) throw new Error(`duplicate acceptance id ${item.id}`);
    ids.add(item.id);
  }
  if (!Object.values(PROFILE_NAME).includes(contract.profile))
    throw new Error('task.profile must be quick, standard, or deep');
  const risk = contract.risk ?? RISK_LEVEL.MEDIUM;

  if (!Object.values(RISK_LEVEL).includes(risk))
    throw new Error('task.risk must be low, medium, or high');
  const baseRef = contract.base_ref ?? 'HEAD';

  if (!isSafeGitRef(baseRef)) throw new Error('task.base_ref must be a safe Git ref');
  const verification = contract.verification ?? [];

  if (!Array.isArray(verification)) throw new Error('task.verification must be an array');
  const normalizedVerification = verification.map((item, index) => {
    const value = typeof item === 'string' ? { command: item } : item;

    if (!value || typeof value.command !== 'string' || !value.command.trim())
      throw new Error(`task.verification[${index}].command is required`);
    if (
      value.args !== undefined &&
      (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== 'string'))
    )
      throw new Error(`task.verification[${index}].args must be an array of strings`);

    return { command: value.command, args: value.args ?? [] };
  });

  return {
    id: contract.id,
    title: contract.title,
    goal: contract.goal,
    profile: contract.profile,
    risk,
    base_ref: baseRef,
    ...(normalizedVerification.length ? { verification: normalizedVerification } : {}),
    acceptance: acceptance.map((acceptanceItem, acceptanceIndex) =>
      typeof acceptanceItem === 'string'
        ? { id: `AC-${acceptanceIndex + 1}`, criterion: acceptanceItem }
        : acceptanceItem,
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
      harness: HARNESS_NAME.CODEX,
      review: false,
      architecture: false,
      maxWorkers: 1,
    };
  if (profileName === PROFILE_NAME.STANDARD)
    return {
      ...common,
      name: profileName,
      mode: EXECUTION_MODE.ISOLATED,
      harness: HARNESS_NAME.CODEX,
      review: true,
      reviewHarness: HARNESS_NAME.CODEX,
      architecture: false,
      maxWorkers: 1,
    };

  return {
    ...common,
    name: profileName,
    mode: EXECUTION_MODE.PARALLEL,
    harness: HARNESS_NAME.CODEX,
    review: true,
    reviewHarness: HARNESS_NAME.CODEX,
    architecture: true,
    architectHarness: HARNESS_NAME.CODEX,
    integration: true,
    maxWorkers: 3,
    verification: 'broad',
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
    if (
      stage.harness !== undefined &&
      stage.harness !== null &&
      !Object.values(HARNESS_NAME).includes(stage.harness)
    )
      throw new Error(`plan stage ${stage.id}.harness is invalid`);
  }
  const visiting = new Set();
  const visited = new Set();
  const stagesById = new Map(plan.stages.map((stage) => [stage.id, stage]));

  function visitPlanStage(stageId) {
    if (visiting.has(stageId)) throw new Error('plan contains a cycle');
    if (visited.has(stageId)) return;
    const stage = stagesById.get(stageId);

    if (!stage) throw new Error(`plan dependency not found: ${stageId}`);
    visiting.add(stageId);
    for (const dependency of stage.dependsOn ?? []) visitPlanStage(dependency);
    visiting.delete(stageId);
    visited.add(stageId);
  }
  for (const stage of plan.stages) visitPlanStage(stage.id);

  return {
    ...plan,
    stages: plan.stages.map((stage) => {
      const normalizedStage = { ...stage, dependsOn: stage.dependsOn ?? [] };

      if (normalizedStage.harness === null) delete normalizedStage.harness;

      return normalizedStage;
    }),
  };
}

export function validateReviewResult(review) {
  if (!review || typeof review !== 'object') throw new Error('review result must be an object');
  if (!Object.values(REVIEW_VERDICT).includes(review.verdict))
    throw new Error('review verdict is invalid');
  if (!Array.isArray(review.findings)) throw new Error('review findings must be an array');

  for (const [index, finding] of review.findings.entries()) {
    if (!Object.values(FINDING_SEVERITY).includes(finding?.severity))
      throw new Error(`review finding ${index}.severity is invalid`);
    if (typeof finding.criterion !== 'string' || !finding.criterion.trim())
      throw new Error(`review finding ${index}.criterion is required`);
    if (typeof finding.reason !== 'string' || !finding.reason.trim())
      throw new Error(`review finding ${index}.reason is required`);
  }

  return review;
}

export function validateVerificationReport(report) {
  if (!report || typeof report !== 'object')
    throw new Error('verification report must be an object');
  for (const field of ['taskId', 'stageId', 'runId', 'workspace', 'revision'])
    if (typeof report[field] !== 'string' || !report[field].trim())
      throw new Error(`verification.${field} is required`);
  if (!Number.isInteger(report.attempt) || report.attempt < 1)
    throw new Error('verification.attempt must be a positive integer');
  if (!Array.isArray(report.evidence)) throw new Error('verification.evidence must be an array');
  if (report.rationale !== undefined && typeof report.rationale !== 'string')
    throw new Error('verification.rationale must be a string');
  if (report.skippedChecks !== undefined && !Array.isArray(report.skippedChecks))
    throw new Error('verification.skippedChecks must be an array');
  for (const skippedCheck of report.skippedChecks ?? [])
    if (typeof skippedCheck?.reason !== 'string' || !skippedCheck.reason.trim())
      throw new Error('every skipped verification check requires a reason');

  return report;
}

export function validateNormalizedEvent(event) {
  if (!event || typeof event !== 'object') throw new Error('event must be an object');
  if (event.version !== 1) throw new Error('event.version must be 1');
  if (typeof event.task_id !== 'string' || !event.task_id.trim())
    throw new Error('event.task_id is required');
  if (typeof event.type !== 'string' || !event.type.trim())
    throw new Error('event.type is required');
  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload))
    throw new Error('event.payload must be an object');
  if (typeof event.at !== 'string' || Number.isNaN(Date.parse(event.at)))
    throw new Error('event.at must be an ISO date-time');

  return event;
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
