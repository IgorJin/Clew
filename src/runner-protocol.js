import { isIP } from 'node:net';
import { URL } from 'node:url';

export const RUNNER_PROTOCOL_VERSION = 1;
export const RUNNER_PROTOCOL_MAX_BYTES = 256 * 1024;

export const RUNNER_DIRECTION = Object.freeze({
  TO_CONTROLLER: 'runner_to_controller',
  TO_RUNNER: 'controller_to_runner',
});

export const RUNNER_MESSAGE_KIND = Object.freeze({
  REGISTER: 'runner.register',
  REGISTERED: 'controller.registered',
  HEARTBEAT: 'runner.heartbeat',
  LEASE_OFFER: 'controller.lease_offer',
  LEASE_ACCEPTED: 'runner.lease_accepted',
  LEASE_REJECTED: 'runner.lease_rejected',
  LEASE_STARTED: 'runner.lease_started',
  CANCEL: 'controller.cancel',
  CANCEL_ACK: 'runner.cancel_ack',
  EVENT: 'runner.event',
  RESULT: 'runner.result',
  ACK: 'controller.ack',
});

export const LEASE_STATE = Object.freeze({
  OFFERED: 'offered',
  ACCEPTED: 'accepted',
  RUNNING: 'running',
  RECOVERING: 'recovering',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

const TERMINAL_LEASE_STATES = new Set([
  LEASE_STATE.COMPLETED,
  LEASE_STATE.FAILED,
  LEASE_STATE.CANCELLED,
]);
const LEASE_TRANSITIONS = Object.freeze({
  [LEASE_STATE.OFFERED]: new Set([LEASE_STATE.ACCEPTED, LEASE_STATE.CANCELLED, LEASE_STATE.FAILED]),
  [LEASE_STATE.ACCEPTED]: new Set([
    LEASE_STATE.RUNNING,
    LEASE_STATE.RECOVERING,
    LEASE_STATE.CANCELLED,
    LEASE_STATE.FAILED,
  ]),
  [LEASE_STATE.RUNNING]: new Set([
    LEASE_STATE.RECOVERING,
    LEASE_STATE.COMPLETED,
    LEASE_STATE.FAILED,
    LEASE_STATE.CANCELLED,
  ]),
  [LEASE_STATE.RECOVERING]: new Set([
    LEASE_STATE.RUNNING,
    LEASE_STATE.COMPLETED,
    LEASE_STATE.FAILED,
    LEASE_STATE.CANCELLED,
  ]),
});

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MESSAGE_KINDS = new Set(Object.values(RUNNER_MESSAGE_KIND));
const DIRECTIONS = new Set(Object.values(RUNNER_DIRECTION));
const FORBIDDEN_FIELD =
  /(?:authorization|credential|password|secret|token|cookie|environment|env(?:ironment)?Values?|prompt|reasoning|pty|terminalBytes|fileContents?|repositoryArchive)/i;

const MESSAGE_DIRECTION = Object.freeze({
  [RUNNER_MESSAGE_KIND.REGISTER]: RUNNER_DIRECTION.TO_CONTROLLER,
  [RUNNER_MESSAGE_KIND.REGISTERED]: RUNNER_DIRECTION.TO_RUNNER,
  [RUNNER_MESSAGE_KIND.HEARTBEAT]: RUNNER_DIRECTION.TO_CONTROLLER,
  [RUNNER_MESSAGE_KIND.LEASE_OFFER]: RUNNER_DIRECTION.TO_RUNNER,
  [RUNNER_MESSAGE_KIND.LEASE_ACCEPTED]: RUNNER_DIRECTION.TO_CONTROLLER,
  [RUNNER_MESSAGE_KIND.LEASE_REJECTED]: RUNNER_DIRECTION.TO_CONTROLLER,
  [RUNNER_MESSAGE_KIND.LEASE_STARTED]: RUNNER_DIRECTION.TO_CONTROLLER,
  [RUNNER_MESSAGE_KIND.CANCEL]: RUNNER_DIRECTION.TO_RUNNER,
  [RUNNER_MESSAGE_KIND.CANCEL_ACK]: RUNNER_DIRECTION.TO_CONTROLLER,
  [RUNNER_MESSAGE_KIND.EVENT]: RUNNER_DIRECTION.TO_CONTROLLER,
  [RUNNER_MESSAGE_KIND.RESULT]: RUNNER_DIRECTION.TO_CONTROLLER,
  [RUNNER_MESSAGE_KIND.ACK]: RUNNER_DIRECTION.TO_RUNNER,
});

const REQUIRED_PAYLOAD_FIELDS = Object.freeze({
  [RUNNER_MESSAGE_KIND.REGISTER]: [
    'runnerId',
    'productVersion',
    'protocolVersions',
    'capabilities',
    'workspaces',
  ],
  [RUNNER_MESSAGE_KIND.REGISTERED]: ['runnerId', 'protocolVersion', 'controllerId'],
  [RUNNER_MESSAGE_KIND.HEARTBEAT]: ['runnerId', 'connectionId'],
  [RUNNER_MESSAGE_KIND.LEASE_OFFER]: [
    'runnerId',
    'leaseId',
    'epoch',
    'taskId',
    'stageId',
    'runId',
    'attempt',
    'workspaceId',
  ],
  [RUNNER_MESSAGE_KIND.LEASE_ACCEPTED]: ['runnerId', 'leaseId', 'epoch'],
  [RUNNER_MESSAGE_KIND.LEASE_REJECTED]: ['runnerId', 'leaseId', 'epoch', 'reason'],
  [RUNNER_MESSAGE_KIND.LEASE_STARTED]: ['runnerId', 'leaseId', 'epoch'],
  [RUNNER_MESSAGE_KIND.CANCEL]: ['runnerId', 'leaseId', 'epoch', 'reason'],
  [RUNNER_MESSAGE_KIND.CANCEL_ACK]: ['runnerId', 'leaseId', 'epoch', 'status'],
  [RUNNER_MESSAGE_KIND.EVENT]: ['runnerId', 'leaseId', 'epoch', 'eventId', 'type', 'at'],
  [RUNNER_MESSAGE_KIND.RESULT]: ['runnerId', 'leaseId', 'epoch', 'resultId', 'status'],
  [RUNNER_MESSAGE_KIND.ACK]: ['runnerId', 'ackedMessageId'],
});

const PAYLOAD_ALLOWLIST = Object.freeze({
  [RUNNER_MESSAGE_KIND.REGISTER]: new Set([
    'runnerId',
    'productVersion',
    'protocolVersions',
    'capabilities',
    'workspaces',
    'startedAt',
  ]),
  [RUNNER_MESSAGE_KIND.REGISTERED]: new Set([
    'runnerId',
    'protocolVersion',
    'controllerId',
    'connectionId',
    'heartbeatIntervalMs',
  ]),
  [RUNNER_MESSAGE_KIND.HEARTBEAT]: new Set([
    'runnerId',
    'connectionId',
    'activeLeaseIds',
    'status',
  ]),
  [RUNNER_MESSAGE_KIND.LEASE_OFFER]: new Set([
    'runnerId',
    'leaseId',
    'epoch',
    'taskId',
    'stageId',
    'runId',
    'attempt',
    'workspaceId',
    'profile',
    'harness',
    'requirements',
  ]),
  [RUNNER_MESSAGE_KIND.LEASE_ACCEPTED]: new Set(['runnerId', 'leaseId', 'epoch']),
  [RUNNER_MESSAGE_KIND.LEASE_REJECTED]: new Set(['runnerId', 'leaseId', 'epoch', 'reason']),
  [RUNNER_MESSAGE_KIND.LEASE_STARTED]: new Set(['runnerId', 'leaseId', 'epoch']),
  [RUNNER_MESSAGE_KIND.CANCEL]: new Set(['runnerId', 'leaseId', 'epoch', 'reason']),
  [RUNNER_MESSAGE_KIND.CANCEL_ACK]: new Set(['runnerId', 'leaseId', 'epoch', 'status']),
  [RUNNER_MESSAGE_KIND.EVENT]: new Set([
    'runnerId',
    'leaseId',
    'epoch',
    'eventId',
    'type',
    'at',
    'summary',
    'progress',
  ]),
  [RUNNER_MESSAGE_KIND.RESULT]: new Set([
    'runnerId',
    'leaseId',
    'epoch',
    'resultId',
    'status',
    'summary',
    'revision',
    'sessionId',
    'turnId',
    'evidence',
    'usage',
    'review',
    'plan',
  ]),
  [RUNNER_MESSAGE_KIND.ACK]: new Set(['runnerId', 'ackedMessageId']),
});

function assertPlainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${name} must be an object`);
}

function assertIdentifier(value, name) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value))
    throw new Error(`${name} must be a bounded stable identifier`);
}

function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
}

function assertNoForbiddenData(value, path = 'payload', seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error(`${path} must not contain circular data`);
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_FIELD.test(key)) throw new Error(`${path}.${key} is forbidden transport data`);
    assertNoForbiddenData(child, `${path}.${key}`, seen);
  }
}

function assertPayload(kind, payload) {
  assertPlainObject(payload, 'envelope.payload');
  assertNoForbiddenData(payload);
  for (const field of REQUIRED_PAYLOAD_FIELDS[kind]) {
    if (payload[field] === undefined || payload[field] === null)
      throw new Error(`envelope.payload.${field} is required for ${kind}`);
  }
  for (const field of ['runnerId', 'leaseId', 'taskId', 'stageId', 'runId', 'eventId', 'resultId'])
    if (payload[field] !== undefined) assertIdentifier(payload[field], `envelope.payload.${field}`);
  if (payload.epoch !== undefined) assertPositiveInteger(payload.epoch, 'envelope.payload.epoch');
  if (payload.at !== undefined && Number.isNaN(Date.parse(payload.at)))
    throw new Error('envelope.payload.at must be an ISO timestamp');
  if (kind === RUNNER_MESSAGE_KIND.REGISTER) {
    if (!Array.isArray(payload.protocolVersions) || payload.protocolVersions.length === 0)
      throw new Error('envelope.payload.protocolVersions must not be empty');
    if (!Array.isArray(payload.capabilities) || !Array.isArray(payload.workspaces))
      throw new Error('registration capabilities and workspaces must be arrays');
  }
}

export function sanitizeRunnerPayload(kind, payload) {
  if (!MESSAGE_KINDS.has(kind)) throw new Error(`unknown Runner protocol message: ${kind}`);
  assertPayload(kind, payload);
  const allowed = PAYLOAD_ALLOWLIST[kind];

  return Object.fromEntries(Object.entries(payload).filter(([key]) => allowed.has(key)));
}

export function validateRunnerEnvelope(value, { maxBytes = RUNNER_PROTOCOL_MAX_BYTES } = {}) {
  assertPlainObject(value, 'envelope');
  const byteLength = Buffer.byteLength(JSON.stringify(value));

  if (byteLength > maxBytes) throw new Error(`Runner protocol envelope exceeds ${maxBytes} bytes`);
  if (value.version !== RUNNER_PROTOCOL_VERSION)
    throw new Error(`unsupported Runner protocol envelope version: ${value.version}`);
  if (!MESSAGE_KINDS.has(value.kind))
    throw new Error(`unknown Runner protocol message: ${String(value.kind)}`);
  if (!DIRECTIONS.has(value.direction) || MESSAGE_DIRECTION[value.kind] !== value.direction)
    throw new Error(`invalid direction for ${value.kind}`);
  for (const field of ['messageId', 'idempotencyKey', 'correlationId'])
    assertIdentifier(value[field], `envelope.${field}`);
  if (value.payloadVersion !== 1) throw new Error('unsupported Runner payload version');
  if (typeof value.sentAt !== 'string' || Number.isNaN(Date.parse(value.sentAt)))
    throw new Error('envelope.sentAt must be an ISO timestamp');

  return Object.freeze({
    version: RUNNER_PROTOCOL_VERSION,
    kind: value.kind,
    direction: value.direction,
    messageId: value.messageId,
    idempotencyKey: value.idempotencyKey,
    correlationId: value.correlationId,
    sentAt: value.sentAt,
    payloadVersion: 1,
    payload: sanitizeRunnerPayload(value.kind, value.payload),
  });
}

export function createRunnerEnvelope({
  kind,
  messageId,
  idempotencyKey,
  correlationId,
  sentAt = new Date().toISOString(),
  payload,
}) {
  return validateRunnerEnvelope({
    version: RUNNER_PROTOCOL_VERSION,
    kind,
    direction: MESSAGE_DIRECTION[kind],
    messageId,
    idempotencyKey,
    correlationId,
    sentAt,
    payloadVersion: 1,
    payload,
  });
}

export function assertLeaseTransition(current, next) {
  assertPlainObject(current, 'current lease');
  assertPlainObject(next, 'next lease transition');
  for (const [value, name] of [
    [current.leaseId, 'current.leaseId'],
    [current.runnerId, 'current.runnerId'],
    [next.leaseId, 'next.leaseId'],
    [next.runnerId, 'next.runnerId'],
  ])
    assertIdentifier(value, name);
  assertPositiveInteger(current.epoch, 'current.epoch');
  assertPositiveInteger(next.epoch, 'next.epoch');
  if (current.leaseId !== next.leaseId) throw new Error('lease identity mismatch');
  if (current.runnerId !== next.runnerId) throw new Error('Runner identity mismatch');
  if (current.epoch !== next.epoch) throw new Error('stale lease epoch');
  if (TERMINAL_LEASE_STATES.has(current.state)) throw new Error('terminal lease cannot mutate');
  if (!LEASE_TRANSITIONS[current.state]?.has(next.state))
    throw new Error(`invalid lease transition: ${current.state} -> ${next.state}`);

  return { ...current, ...next };
}

export function negotiateRunnerCompatibility({ controller, runner }) {
  assertPlainObject(controller, 'controller compatibility');
  assertPlainObject(runner, 'runner compatibility');
  const controllerProtocols = new Set(controller.protocolVersions ?? []);
  const protocolVersion = [...new Set(runner.protocolVersions ?? [])]
    .filter((version) => controllerProtocols.has(version))
    .sort((left, right) => right - left)[0];

  if (!protocolVersion) throw new Error('incompatible Runner protocol versions');
  const missingCapabilities = (controller.requiredCapabilities ?? []).filter(
    (capability) => !(runner.capabilities ?? []).includes(capability),
  );

  if (missingCapabilities.length)
    throw new Error(`Runner is missing capabilities: ${missingCapabilities.join(', ')}`);
  if (controller.productVersion) {
    const controllerProduct = parseProductVersion(controller.productVersion, 'Controller');
    const runnerProduct = parseProductVersion(runner.productVersion, 'Runner');

    if (
      controllerProduct.major !== runnerProduct.major ||
      controllerProduct.minor !== runnerProduct.minor
    )
      throw new Error(
        `incompatible product versions: Controller ${controller.productVersion}, Runner ${runner.productVersion}`,
      );
  }

  return {
    protocolVersion,
    productVersion: runner.productVersion,
    capabilities: [...new Set(runner.capabilities ?? [])].sort(),
  };
}

function parseProductVersion(value, owner) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value ?? '');

  if (!match) throw new Error(`${owner} product version must be semantic versioning`);

  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  return (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized.endsWith('.localhost') ||
    (isIP(normalized) === 4 && normalized.startsWith('127.'))
  );
}

export function assertSecureRunnerEndpoint(value) {
  let endpoint;

  try {
    endpoint = new URL(value);
  } catch {
    throw new Error('Runner Controller endpoint must be a valid ws:// or wss:// URL');
  }
  if (!['ws:', 'wss:'].includes(endpoint.protocol))
    throw new Error('Runner Controller endpoint must use ws:// or wss://');
  if (endpoint.username || endpoint.password)
    throw new Error('Runner credentials must not be embedded in the endpoint URL');
  if (endpoint.protocol === 'ws:' && !isLoopbackHostname(endpoint.hostname))
    throw new Error('non-loopback Runner transport requires TLS (wss://)');

  return endpoint;
}

export function runnerIdempotencyIdentity(envelope) {
  const validated = validateRunnerEnvelope(envelope);

  return `${validated.direction}:${validated.kind}:${validated.idempotencyKey}`;
}

class FakeProtocolPeer {
  constructor({ outboundDirection }) {
    this.outboundDirection = outboundDirection;
    this.outcomes = new Map();
    this.actions = [];
  }

  produce(input) {
    const envelope = createRunnerEnvelope(input);

    if (envelope.direction !== this.outboundDirection)
      throw new Error(`fake peer cannot produce ${envelope.kind}`);

    return envelope;
  }

  consume(input, action = (envelope) => ({ accepted: true, messageId: envelope.messageId })) {
    const envelope = validateRunnerEnvelope(input);

    if (envelope.direction === this.outboundDirection)
      throw new Error(`fake peer cannot consume ${envelope.kind}`);
    const identity = runnerIdempotencyIdentity(envelope);

    if (this.outcomes.has(identity))
      return { duplicate: true, outcome: this.outcomes.get(identity) };
    const outcome = action(envelope);

    this.actions.push(envelope);
    this.outcomes.set(identity, outcome);

    return { duplicate: false, outcome };
  }
}

export class FakeRunnerProtocolPeer extends FakeProtocolPeer {
  constructor() {
    super({ outboundDirection: RUNNER_DIRECTION.TO_CONTROLLER });
  }
}

export class FakeControllerProtocolPeer extends FakeProtocolPeer {
  constructor() {
    super({ outboundDirection: RUNNER_DIRECTION.TO_RUNNER });
  }
}
