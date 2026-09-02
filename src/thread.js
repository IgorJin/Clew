import { randomUUID } from 'node:crypto';
import { validateThreadItem, validateThreadPage } from './control-plane.js';
import { redactSecrets } from './security.js';

const EVENT_KINDS = new Map([
  [
    'TASK_CREATED',
    ['task_created', (p) => `Task created: ${p.contract?.title ?? p.contract?.id ?? 'new task'}`],
  ],
  ['PLAN_PERSISTED', ['plan_versioned', (p) => `Plan version ${p.version ?? '?'} persisted`]],
  ['PLAN_VALIDATED', ['plan_validated', (p) => `Plan version ${p.version ?? '?'} validated`]],
  ['PLAN_APPROVAL_REQUIRED', ['plan_approval_required', () => 'Plan approval is required']],
  [
    'PLAN_APPROVED',
    ['plan_approved', (p) => `Plan approved${p.version ? ` (version ${p.version})` : ''}`],
  ],
  ['PLAN_REJECTED', ['plan_rejected', () => 'Plan rejected']],
  [
    'STAGE_RUN_STARTED',
    [
      'run_started',
      (p) => `Stage ${p.stageId ?? 'unknown'} run started (attempt ${p.attempt ?? '?'})`,
    ],
  ],
  ['STAGE_RUN_FAILED', ['run_failed', (p) => `Stage ${p.stageId ?? 'unknown'} run failed`]],
  [
    'STAGE_RUN_INTERRUPTED',
    ['run_interrupted', (p) => `Stage ${p.stageId ?? 'unknown'} run interrupted`],
  ],
  ['RUN_FAILED', ['run_failed', () => 'Run failed']],
  ['RUN_INTERRUPTED', ['run_interrupted', () => 'Run interrupted']],
  [
    'RETRY_SCHEDULED',
    ['retry_scheduled', (p) => `Retry scheduled (attempt ${p.nextAttempt ?? '?'})`],
  ],
  [
    'CHANGES_REQUESTED',
    [
      'review_findings',
      (p) =>
        `${Array.isArray(p.findings) ? p.findings.length : 0} review finding(s) require correction`,
    ],
  ],
  [
    'VERIFICATION_RECORDED',
    [
      'verification_recorded',
      (p) => `Verification recorded for revision ${p.revision ?? 'unknown'}`,
    ],
  ],
  ['REVIEW_RECORDED', ['review_recorded', (p) => `Review recorded: ${p.verdict ?? 'unknown'}`]],
  ['INTEGRATION_STARTED', ['integration_started', () => 'Integration started']],
  [
    'INTEGRATION_COMPLETED',
    [
      'integration_completed',
      (p) => `Integration completed${p.revision ? ` at ${p.revision}` : ''}`,
    ],
  ],
  ['INTEGRATION_BLOCKED', ['integration_blocked', () => 'Integration is blocked']],
  [
    'RESULT_EXPORTED',
    ['result_exported', (p) => `Result exported${p.revision ? ` at ${p.revision}` : ''}`],
  ],
  [
    'TASK_STATE_CHANGED',
    ['task_state_changed', (p) => `Task state changed to ${p.state ?? 'unknown'}`],
  ],
  ['TASK_COMPLETED', ['task_completed', () => 'Task completed']],
  [
    'READY_INVALIDATED',
    ['readiness_invalidated', () => 'Readiness invalidated; verification is required'],
  ],
  [
    'STAGE_DEPENDENCIES_INTEGRATED',
    ['stage_integrated', (p) => `Stage ${p.stageId ?? 'unknown'} dependencies integrated`],
  ],
  ['STAGE_RECOVERED', ['stage_recovered', (p) => `Stage ${p.stageId ?? 'unknown'} recovered`]],
  ['STAGE_REQUEUED', ['stage_requeued', (p) => `Stage ${p.stageId ?? 'unknown'} requeued`]],
  ['TASK_RECOVERY_STARTED', ['recovery_started', () => 'Task recovery started']],
  ['COMPLETION_OVERRIDE_RECORDED', ['completion_override', () => 'Completion override recorded']],
  [
    'CONTINUATION_GRANTED',
    ['continuation_granted', (p) => `Continuation granted by ${p.actor ?? 'operator'}`],
  ],
  ['CONTINUATION_COMPLETED', ['continuation_completed', () => 'Continuation correction completed']],
  [
    'REVIEW_EXHAUSTED',
    ['review_exhausted', () => 'Review correction budget exhausted; human attention required'],
  ],
  [
    'CONTINUATION_INTERRUPTED',
    ['continuation_interrupted', () => 'Continuation paused and can be resumed safely'],
  ],
  [
    'SESSION_RESUME_FALLBACK',
    ['session_resume_fallback', () => 'Stale native session replaced with a fresh session'],
  ],
  [
    'WORKFLOW_ACTION_PROPOSED',
    [
      'next_step_proposed',
      (p) => `Next step: ${p.descriptor?.summary ?? p.summary ?? p.kind ?? 'approval required'}`,
    ],
  ],
  ['WORKFLOW_ACTION_APPROVED', ['step_approved', (p) => `Step approved${p.id ? `: ${p.id}` : ''}`]],
  [
    'HARNESS_SESSION_STARTED',
    ['codex_session_started', (p) => `Codex session started: ${p.sessionId ?? 'unknown'}`],
  ],
  [
    'HARNESS_SESSION_RESUMED',
    ['codex_session_resumed', (p) => `Codex session resumed: ${p.sessionId ?? 'unknown'}`],
  ],
  [
    'HARNESS_TURN_STARTED',
    ['codex_turn_started', (p) => `Codex turn started: ${p.turnId ?? 'unknown'}`],
  ],
  [
    'HARNESS_TOOL_STARTED',
    ['worker_tool_started', (p) => `Worker started tool: ${p.command ?? p.tool ?? 'unknown'}`],
  ],
  [
    'HARNESS_TOOL_COMPLETED',
    [
      'worker_tool_completed',
      (p) =>
        `Worker completed tool: ${p.command ?? p.tool ?? 'unknown'}${p.exitCode !== undefined ? ` (exit ${p.exitCode})` : ''}`,
    ],
  ],
  [
    'HARNESS_TURN_WAITING',
    [
      'worker_waiting',
      (p) =>
        `Worker response ready${p.output ? `: ${String(p.output).slice(0, 4000)}` : '; terminal is waiting for operator'}`,
    ],
  ],
  ['HARNESS_TURN_RUNNING', ['worker_running', () => 'Worker started a new turn']],
  [
    'HARNESS_TURN_FAILED',
    ['worker_turn_failed', () => 'Worker turn failed; operator attention required'],
  ],
  [
    'HARNESS_TURN_INTERRUPTED',
    ['worker_turn_interrupted', () => 'Worker turn interrupted; operator attention required'],
  ],
  ['HARNESS_HARNESS_COMPLETED', ['codex_completed', () => 'Codex worker completed']],
  [
    'HARNESS_HARNESS_FAILED',
    ['codex_failed', (p) => `Codex worker failed: ${p.error ?? 'unknown error'}`],
  ],
  [
    'WORKER_OUTPUT_RECORDED',
    ['worker_output', (p) => `Worker output:\n${String(p.output ?? '').slice(0, 4000)}`],
  ],
  [
    'OPERATOR_MESSAGE_RECORDED',
    ['operator_message_recorded', (p) => `Operator message recorded for ${p.actor ?? 'operator'}`],
  ],
  [
    'OPERATOR_ACTION_RECORDED',
    ['operator_action', (p) => `Operator ${p.action ?? 'action'} recorded`],
  ],
  [
    'HARNESS_APPROVAL_REQUESTED',
    ['harness_approval_required', (p) => `Worker approval required: ${p.method ?? 'command'}`],
  ],
  [
    'HARNESS_APPROVAL_DECIDED',
    ['harness_approval_decided', (p) => `Worker approval ${p.decision ?? 'decided'}`],
  ],
]);

const stageFrom = (payload) => payload.stageId ?? payload.stage_id ?? null;
const runFrom = (payload) => payload.runId ?? payload.run_id ?? null;
const HIDDEN_PUBLIC_EVENT_TYPES = new Set([
  'HARNESS_SESSION_STARTED',
  'HARNESS_SESSION_RESUMED',
  'HARNESS_TURN_STARTED',
  'HARNESS_TOOL_STARTED',
  'HARNESS_TOOL_COMPLETED',
  'HARNESS_HARNESS_COMPLETED',
  'HARNESS_HARNESS_EVENT',
  'HARNESS_HARNESS_OUTPUT',
]);

export function isPublicThreadEvent(event) {
  return EVENT_KINDS.has(event.type) && !HIDDEN_PUBLIC_EVENT_TYPES.has(event.type);
}

function eventItem(event) {
  if (!isPublicThreadEvent(event)) return null;
  const mapping = EVENT_KINDS.get(event.type);

  if (!mapping) return null;
  const [kind, summary] = mapping;
  const payload = event.payload ?? {};
  const sourceKind =
    event.type === 'REVIEW_RECORDED'
      ? 'review'
      : event.type === 'VERIFICATION_RECORDED'
        ? 'verification'
        : event.type === 'STAGE_RUN_STARTED'
          ? 'run'
          : event.type === 'OPERATOR_ACTION_RECORDED'
            ? 'operator_action'
            : event.type.startsWith('HARNESS_') || event.type === 'WORKER_OUTPUT_RECORDED'
              ? 'worker'
              : 'event';

  return {
    version: 1,
    id: `thread-event-${event.seq}`,
    cursor: event.seq,
    kind,
    at: event.at,
    source: { kind: sourceKind, id: `event-${event.seq}`, eventType: event.type },
    summary: summary(payload),
    taskId: event.task_id,
    stageId: stageFrom(payload),
    runId: runFrom(payload) ?? (event.type === 'STAGE_RUN_STARTED' ? (payload.id ?? null) : null),
    redacted: false,
    _order: event.seq,
  };
}

function operatorItem(message, order) {
  const target = message.target ?? null;

  return {
    version: 1,
    id: `thread-message-${message.id}`,
    cursor: order,
    kind: 'operator_message',
    at: message.created_at ?? message.at,
    source: { kind: 'operator_message', id: message.id },
    summary: message.message,
    taskId: message.task_id ?? message.taskId,
    stageId: target?.stageId ?? target?.stage_id ?? null,
    runId: target?.runId ?? target?.run_id ?? null,
    actor: message.actor,
    target,
    redacted: true,
    _order: order,
  };
}

/** Pure projection. The input arrays are never mutated and unknown events are ignored. */
export function projectTaskThread({ events = [], operatorMessages = [] } = {}) {
  const projected = events.map(eventItem).filter(Boolean);
  const baseOrder = events.reduce((max, event) => Math.max(max, event.seq ?? 0), 0);

  projected.push(
    ...operatorMessages.map((message, index) => operatorItem(message, baseOrder + index + 1)),
  );
  projected.sort((a, b) => a.at.localeCompare(b.at) || a._order - b._order);

  return projected.map(({ _order, ...item }, index) =>
    validateThreadItem({ ...item, cursor: index + 1 }),
  );
}

export function queryTaskThread(input, { after = 0, limit = 50 } = {}) {
  if (!Number.isSafeInteger(after) || after < 0)
    throw new Error('thread cursor must be a non-negative integer');
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error('thread limit must be a positive integer');
  const all = projectTaskThread(input);
  const items = all.filter((item) => item.cursor > after).slice(0, limit);
  const hasMore = all.some((item) => item.cursor > (items.at(-1)?.cursor ?? after));

  return validateThreadPage({
    version: 1,
    items,
    nextCursor: hasMore ? items.at(-1).cursor : null,
    hasMore,
    redaction: 'public-safe',
  });
}

export function projectDiagnosticEvents(events = []) {
  return events.map((event) => redactSecrets({ ...event, payload: event.payload ?? {} }));
}

export { randomUUID };
