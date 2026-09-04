const EXECUTION_BRIEF_VERSION = 1;

export const EXECUTION_ROLE = Object.freeze({
  WORKER: 'worker',
  REVIEWER: 'reviewer',
  ARCHITECT: 'architect',
  INTEGRATION: 'integration',
  QA: 'qa',
});

const EXECUTION_ROLES = new Set(Object.values(EXECUTION_ROLE));

function nonEmptyString(value, field) {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`executionBrief.${field} is required`);

  return value.trim();
}

function boundedFindings(findings = []) {
  if (!Array.isArray(findings))
    throw new Error('executionBrief.context.reviewFindings must be an array');

  return findings.slice(0, 100).map((finding, index) => ({
    severity: nonEmptyString(
      finding?.severity ?? 'blocking',
      `context.reviewFindings[${index}].severity`,
    ),
    criterion: nonEmptyString(
      finding?.criterion ?? 'unknown',
      `context.reviewFindings[${index}].criterion`,
    ),
    reason: nonEmptyString(finding?.reason, `context.reviewFindings[${index}].reason`),
  }));
}

const LOCAL_PATH_PATTERN = /(?:\/(?:Users|private|tmp|var)\/[^\s"']+|[A-Za-z]:\\[^\s"']+)/g;

function sanitizeContextValue(value, depth = 0) {
  if (typeof value === 'string')
    return value.slice(0, 2_000).replace(LOCAL_PATH_PATTERN, '[LOCAL_PATH]');
  if (depth >= 5 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value))
    return value.slice(0, 100).map((item) => sanitizeContextValue(item, depth + 1));

  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 100)
      .map(([key, item]) => [key.slice(0, 100), sanitizeContextValue(item, depth + 1)]),
  );
}

function taskSnapshot(task) {
  if (!task || typeof task !== 'object')
    throw new Error('execution brief requires a Task contract');
  const acceptance = Array.isArray(task.acceptance) ? task.acceptance : [];

  if (!acceptance.length) throw new Error('executionBrief.task.acceptance must not be empty');

  return {
    id: nonEmptyString(task.id, 'task.id'),
    title: nonEmptyString(task.title, 'task.title'),
    goal: nonEmptyString(task.goal, 'task.goal'),
    acceptance: acceptance.map((item, index) => ({
      id: nonEmptyString(item?.id, `task.acceptance[${index}].id`),
      criterion: nonEmptyString(item?.criterion, `task.acceptance[${index}].criterion`),
    })),
    ...(typeof task.description === 'string' && task.description.trim()
      ? { description: task.description.trim() }
      : {}),
    ...(Array.isArray(task.constraints)
      ? {
          constraints: task.constraints
            .slice(0, 100)
            .map((value, index) => nonEmptyString(value, `task.constraints[${index}]`)),
        }
      : {}),
    ...(Array.isArray(task.non_goals)
      ? {
          nonGoals: task.non_goals
            .slice(0, 100)
            .map((value, index) => nonEmptyString(value, `task.nonGoals[${index}]`)),
        }
      : {}),
  };
}

export function prepareExecutionBrief({
  task,
  role = EXECUTION_ROLE.WORKER,
  stageId = role,
  runId = null,
  attempt = 1,
  assignmentGoal = null,
  reviewFindings = [],
  evidence = [],
  revision = null,
  dependencyRevisions = [],
  readOnly = false,
  requiredEvidence = null,
} = {}) {
  const brief = {
    version: EXECUTION_BRIEF_VERSION,
    task: taskSnapshot(task),
    run: {
      stageId: nonEmptyString(stageId, 'run.stageId'),
      runId: runId ?? null,
      attempt,
    },
    role,
    assignment: {
      goal: nonEmptyString(assignmentGoal ?? task.goal, 'assignment.goal'),
    },
    context: {
      reviewFindings: boundedFindings(reviewFindings),
      evidence: Array.isArray(evidence) ? sanitizeContextValue(evidence) : [],
      revision: revision ?? null,
      dependencyRevisions: Array.isArray(dependencyRevisions)
        ? dependencyRevisions.slice(0, 100)
        : [],
    },
    requiredEvidence: Array.isArray(requiredEvidence)
      ? sanitizeContextValue(requiredEvidence)
      : Array.isArray(task.verification)
        ? task.verification.slice(0, 100)
        : [],
    permissions: { write: !readOnly },
  };

  return validateExecutionBrief(brief);
}

export function validateExecutionBrief(brief) {
  if (!brief || typeof brief !== 'object') throw new Error('execution brief must be an object');
  if (brief.version !== EXECUTION_BRIEF_VERSION)
    throw new Error(`unsupported execution brief version: ${brief.version}`);
  const task = taskSnapshot(brief.task);
  const role = nonEmptyString(brief.role, 'role');

  if (!EXECUTION_ROLES.has(role)) throw new Error(`executionBrief.role is invalid: ${role}`);
  const stageId = nonEmptyString(brief.run?.stageId, 'run.stageId');
  const attempt = brief.run?.attempt;

  if (!Number.isSafeInteger(attempt) || attempt < 1)
    throw new Error('executionBrief.run.attempt must be a positive integer');
  if (
    brief.run.runId !== null &&
    brief.run.runId !== undefined &&
    typeof brief.run.runId !== 'string'
  )
    throw new Error('executionBrief.run.runId must be a string or null');
  if (typeof brief.permissions?.write !== 'boolean')
    throw new Error('executionBrief.permissions.write must be boolean');
  if (!Array.isArray(brief.requiredEvidence))
    throw new Error('executionBrief.requiredEvidence must be an array');

  return {
    version: EXECUTION_BRIEF_VERSION,
    task,
    run: { stageId, runId: brief.run.runId ?? null, attempt },
    role,
    assignment: { goal: nonEmptyString(brief.assignment?.goal, 'assignment.goal') },
    context: {
      reviewFindings: boundedFindings(brief.context?.reviewFindings ?? []),
      evidence: Array.isArray(brief.context?.evidence)
        ? sanitizeContextValue(brief.context.evidence)
        : [],
      revision: brief.context?.revision ?? null,
      dependencyRevisions: Array.isArray(brief.context?.dependencyRevisions)
        ? brief.context.dependencyRevisions.slice(0, 100)
        : [],
    },
    requiredEvidence: sanitizeContextValue(brief.requiredEvidence),
    permissions: { write: brief.permissions.write },
  };
}

export function ensureExecutionBrief({ executionBrief, task, stageId, runId, readOnly = false }) {
  return executionBrief
    ? validateExecutionBrief(executionBrief)
    : prepareExecutionBrief({ task, stageId, runId, readOnly });
}

function list(title, values, render) {
  if (!values.length) return '';

  return `\n\n${title}:\n${values.map((value) => `- ${render(value)}`).join('\n')}`;
}

function roleInstructions(role) {
  if (role === EXECUTION_ROLE.REVIEWER)
    return 'Review the supplied revision against the Task Contract and evidence. Do not propose unrelated refactors. Return only the requested structured review result.';
  if (role === EXECUTION_ROLE.ARCHITECT)
    return 'Produce a bounded implementation architecture and execution plan. Do not modify files. Identify affected components, risks, dependencies, stages, and verification strategy.';

  return 'Implement only the supplied assignment. Do not alter the Task Contract. If a requirement is ambiguous, stop and report the ambiguity.';
}

export function compileHarnessPrompt(executionBrief, { harness = 'generic' } = {}) {
  const brief = validateExecutionBrief(executionBrief);
  const acceptance = list(
    'Acceptance',
    brief.task.acceptance,
    (item) => `${item.id}: ${item.criterion}`,
  );
  const constraints = list('Constraints', brief.task.constraints ?? [], String);
  const nonGoals = list('Non-goals', brief.task.nonGoals ?? [], String);
  const findings = list(
    'Review findings to address in this attempt',
    brief.context.reviewFindings,
    (item) => `[${item.severity}] ${item.criterion}: ${item.reason}`,
  );
  const evidence = list('Observed evidence', brief.context.evidence, (item) =>
    JSON.stringify(item),
  );
  const requiredEvidence = list('Required verification', brief.requiredEvidence, (item) =>
    typeof item === 'string'
      ? item
      : [item.command, ...(item.args ?? [])].filter(Boolean).join(' '),
  );
  const permission = brief.permissions.write
    ? 'You may modify files inside the supplied workspace. Do not modify files outside it.'
    : 'Read-only operation: inspect and report only. Do not create, edit, delete, or commit files.';

  return `You are the ${brief.role} for Clew Task ${brief.task.id} using the ${harness} harness.

Task: ${brief.task.title}

Task goal:
${brief.task.goal}

Assignment for stage ${brief.run.stageId}, attempt ${brief.run.attempt}:
${brief.assignment.goal}${acceptance}${constraints}${nonGoals}${findings}${evidence}${
    brief.context.revision ? `\n\nRevision to inspect:\n${brief.context.revision}` : ''
  }${requiredEvidence}

${roleInstructions(brief.role)}

${permission}

Before completing, run relevant verification when the role and permissions allow it.`;
}
