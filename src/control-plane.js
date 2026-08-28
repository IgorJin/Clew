export const CONTROL_PROTOCOL_VERSION = 1;

const API_KINDS = new Set(['command', 'query', 'response', 'error']);
const SESSION_ROLES = new Set(['architect', 'worker', 'reviewer', 'qa']);
const HARNESSES = new Set(['codex', 'opencode', 'fake']);
const SESSION_STATES = new Set(['opened', 'resumed', 'unavailable']);
const CONTINUATION_STATES = new Set(['GRANTED', 'RUNNING', 'WORKER_COMPLETED', 'COMPLETED']);

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${name} must be an object`);
}

function assertString(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
}

function assertVersion(value) {
  if (value !== CONTROL_PROTOCOL_VERSION)
    throw new Error(`unsupported control protocol version: ${value}`);
}

function copy(value) {
  return { ...value, version: CONTROL_PROTOCOL_VERSION };
}

export function validateApiEnvelope(envelope) {
  assertObject(envelope, 'api envelope');
  assertVersion(envelope.version);
  assertString(envelope.requestId, 'requestId');
  if (!API_KINDS.has(envelope.kind)) throw new Error('api.kind is invalid');
  if (envelope.name !== undefined) assertString(envelope.name, 'name');
  if (envelope.payload !== undefined) assertObject(envelope.payload, 'payload');
  if (envelope.kind === 'error') validateApiError(envelope.error);

  return copy(envelope);
}

export function validateApiError(error) {
  assertObject(error, 'api error');
  assertString(error.code, 'error.code');
  assertString(error.message, 'error.message');
  if (typeof error.retryable !== 'boolean') throw new Error('error.retryable is required');
  if (error.details !== undefined) assertObject(error.details, 'error.details');

  return error;
}

export function validateWebSocketEvent(event) {
  assertObject(event, 'websocket event');
  assertVersion(event.version);
  if (!Number.isSafeInteger(event.cursor) || event.cursor < 1)
    throw new Error('event.cursor must be a positive integer');
  assertString(event.eventId, 'eventId');
  assertString(event.type, 'event.type');
  assertString(event.at, 'event.at');
  assertObject(event.payload, 'event.payload');

  return copy(event);
}

export function validateThreadSource(source) {
  assertObject(source, 'thread source');
  if (
    !['event', 'operator_action', 'operator_message', 'run', 'review', 'verification'].includes(
      source.kind,
    )
  )
    throw new Error('thread.source.kind is invalid');
  assertString(source.id, 'thread.source.id');

  return source;
}

export function validateThreadItem(item) {
  assertObject(item, 'thread item');
  assertVersion(item.version);
  assertString(item.id, 'thread.id');
  if (!Number.isSafeInteger(item.cursor) || item.cursor < 1)
    throw new Error('thread.cursor must be a positive integer');
  assertString(item.kind, 'thread.kind');
  assertString(item.at, 'thread.at');
  validateThreadSource(item.source);
  assertString(item.summary, 'thread.summary');
  if (item.redacted !== undefined && typeof item.redacted !== 'boolean')
    throw new Error('thread.redacted must be boolean');

  return copy(item);
}

export function validateThreadPage(page) {
  assertObject(page, 'thread page');
  assertVersion(page.version);
  if (!Array.isArray(page.items)) throw new Error('thread.items must be an array');
  page.items.forEach(validateThreadItem);
  if (
    page.nextCursor !== null &&
    page.nextCursor !== undefined &&
    (!Number.isSafeInteger(page.nextCursor) || page.nextCursor < 1)
  )
    throw new Error('thread.nextCursor must be null or a positive integer');
  if (typeof page.hasMore !== 'boolean') throw new Error('thread.hasMore is required');

  return copy(page);
}

export function validateContinuationGrant(grant) {
  assertObject(grant, 'continuation grant');
  assertVersion(grant.version);
  for (const field of ['id', 'taskId', 'actor', 'reason', 'expectedRevision', 'expiresAt'])
    assertString(grant[field], `continuation.${field}`);
  for (const field of ['stageId', 'runId', 'sessionId'])
    if (grant[field] !== undefined && grant[field] !== null)
      assertString(grant[field], `continuation.${field}`);
  if (grant.idempotencyKey !== undefined && grant.idempotencyKey !== null)
    assertString(grant.idempotencyKey, 'continuation.idempotencyKey');
  if (grant.status !== undefined && !CONTINUATION_STATES.has(grant.status))
    throw new Error('continuation.status is invalid');

  return copy(grant);
}

export function validateOpenSessionRequest(request) {
  assertObject(request, 'open session request');
  assertVersion(request.version);
  assertString(request.taskId, 'session.taskId');
  if (!SESSION_ROLES.has(request.role)) throw new Error('session.role is invalid');
  if (!HARNESSES.has(request.harness)) throw new Error('session.harness is invalid');
  if (request.mode !== undefined && !['new', 'resume'].includes(request.mode))
    throw new Error('session.mode is invalid');

  return copy(request);
}

export function validateOpenSessionResult(result) {
  assertObject(result, 'open session result');
  assertVersion(result.version);
  assertString(result.taskId, 'session.taskId');
  if (!SESSION_ROLES.has(result.role)) throw new Error('session.role is invalid');
  if (!HARNESSES.has(result.harness)) throw new Error('session.harness is invalid');
  assertString(result.sessionId, 'session.sessionId');
  if (!SESSION_STATES.has(result.state)) throw new Error('session.state is invalid');

  return copy(result);
}

export function assertReplayCursor({ requestedAfter = 0, oldest = 1, newest = 0 } = {}) {
  if (!Number.isSafeInteger(requestedAfter) || requestedAfter < 0)
    throw new Error('replay cursor must be a non-negative integer');
  if (requestedAfter > newest) throw new Error('replay cursor is ahead of the stream');
  if (requestedAfter !== 0 && requestedAfter < oldest - 1)
    throw new Error('replay cursor has expired; resync is required');

  return { requestedAfter, oldest, newest };
}
