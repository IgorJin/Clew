import { TASK_STATE } from './domain.js';

export const FINALIZATION_REPORT_VERSION = 1;

const READY_STATES = new Set([TASK_STATE.READY, TASK_STATE.READY_TO_FINISH]);

function check(id, label, passed, detail, blocking = true) {
  return {
    id,
    label,
    passed: Boolean(passed),
    blocking: Boolean(blocking),
    detail: detail ?? null,
  };
}

export function validateFinalizationReport(report) {
  if (!report || typeof report !== 'object')
    throw new Error('finalization report must be an object');
  if (report.version !== FINALIZATION_REPORT_VERSION)
    throw new Error('finalization.version is unsupported');
  if (typeof report.taskId !== 'string' || !report.taskId)
    throw new Error('finalization.taskId is required');
  if (typeof report.state !== 'string' || !report.state)
    throw new Error('finalization.state is required');
  if (typeof report.ready !== 'boolean') throw new Error('finalization.ready must be boolean');
  for (const field of ['checks', 'blockingReasons', 'availableActions'])
    if (!Array.isArray(report[field])) throw new Error(`finalization.${field} must be an array`);
  for (const item of report.checks)
    if (!item || typeof item.id !== 'string' || typeof item.passed !== 'boolean')
      throw new Error('finalization.checks contains an invalid check');

  return report;
}

export function buildFinalizationReport({
  task,
  manifest,
  run = null,
  changes = null,
  integration = null,
  policy = {},
}) {
  if (!task?.id) throw new Error('task is required for finalization report');
  const evidence = Array.isArray(manifest?.evidence) ? manifest.evidence : [];
  const acceptanceIds = (task.contract?.acceptance ?? [])
    .map((item, index) => (typeof item === 'string' ? `AC-${index + 1}` : item.id))
    .filter(Boolean);
  const coveredIds = new Set(evidence.flatMap((item) => item.acceptanceCriteria ?? []));
  const missingEvidence = acceptanceIds.filter((id) => !coveredIds.has(id));
  const staleEvidence = evidence.filter(
    (item) => item.result !== 'passed' || !item.revision || item.revision !== manifest?.revision,
  );
  const review = manifest?.review ?? null;
  const reviewRequired = ['standard', 'deep'].includes(run?.profile ?? task.contract?.profile);
  const gitEnabled = task.contract?.integration?.enabled === true && policy.enabled !== false;
  const workspaceAvailable = changes?.state === 'available';
  const targetReady =
    !gitEnabled ||
    (integration?.available &&
      integration.targetClean &&
      integration.targetCheckedOut &&
      !integration.conflicts);
  const checks = [
    check(
      'workspace',
      'Workspace available',
      workspaceAvailable,
      workspaceAvailable ? run?.workspace : (changes?.reason ?? 'not available'),
      gitEnabled,
    ),
    check(
      'revision',
      'Result revision exists',
      Boolean(manifest?.revision),
      manifest?.revision ?? 'not available',
    ),
    check(
      'verification',
      'Verification passed',
      evidence.length > 0 && staleEvidence.length === 0,
      staleEvidence.length
        ? `${staleEvidence.length} failed or stale check(s)`
        : `${evidence.length} check(s)`,
    ),
    check(
      'evidence',
      'Acceptance evidence complete',
      missingEvidence.length === 0 && acceptanceIds.length > 0,
      missingEvidence.length
        ? `Missing: ${missingEvidence.join(', ')}`
        : `${acceptanceIds.length} criterion/criteria covered`,
    ),
    check(
      'review',
      'Review has no blockers',
      !reviewRequired || review?.verdict === 'pass',
      reviewRequired ? (review?.verdict ?? 'review required') : 'not required',
    ),
    check(
      'source-clean',
      'Source workspace is clean',
      !changes?.dirty,
      changes?.dirty ? 'uncommitted changes will be committed before integration' : 'clean',
      false,
    ),
    check(
      'target',
      'Target branch is ready',
      targetReady,
      gitEnabled
        ? (integration?.reason ??
            (integration?.conflicts
              ? 'merge conflict detected'
              : integration?.targetClean === false
                ? 'primary checkout is dirty'
                : integration?.targetCheckedOut === false
                  ? `checkout ${integration?.targetBranch}`
                  : 'ready'))
        : 'not required',
    ),
  ];
  const blockingReasons = checks
    .filter((item) => item.blocking && !item.passed)
    .map((item) => item.detail ?? item.label);
  const ready = READY_STATES.has(task.state) && blockingReasons.length === 0;
  const availableActions = [];

  if (workspaceAvailable) availableActions.push('review_changes');
  if (ready && gitEnabled)
    availableActions.push(changes?.dirty ? 'commit_and_integrate' : 'integrate');
  if (ready && !gitEnabled) availableActions.push('complete');
  if (task.state === TASK_STATE.MERGED) availableActions.push('mark_released');
  if (blockingReasons.length) availableActions.push('resolve_blockers');

  return validateFinalizationReport({
    version: FINALIZATION_REPORT_VERSION,
    taskId: task.id,
    runId: run?.id ?? null,
    state: task.state,
    ready,
    checks,
    blockingReasons,
    availableActions,
    recommendedAction: availableActions.find((action) => action !== 'review_changes') ?? null,
    git: {
      enabled: gitEnabled,
      targetBranch: policy.targetBranch ?? 'main',
      strategy: policy.strategy ?? 'squash',
      cleanup: policy.cleanup !== false,
      dirty: changes?.dirty === true,
      conflicts: integration?.conflicts ?? null,
      targetClean: integration?.targetClean ?? null,
      targetCheckedOut: integration?.targetCheckedOut ?? null,
    },
    revision: manifest?.revision ?? null,
    workspace: run?.workspace ?? null,
  });
}
