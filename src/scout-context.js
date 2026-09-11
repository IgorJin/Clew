import { createHash } from 'node:crypto';
import { validateTaskContract } from './domain.js';

export const SCOUT_CONTEXT_REQUEST_VERSION = 1;
export const REPOSITORY_CONTEXT_VERSION = 1;
export const REPOSITORY_CONTEXT_MAX_BYTES = 64 * 1024;

export const REPOSITORY_CONTEXT_STATUS = Object.freeze({
  COMPLETE: 'complete',
  PARTIAL: 'partial',
});

export const REPOSITORY_CONTEXT_APPLICABILITY = Object.freeze({
  CURRENT: 'current',
  STALE: 'stale',
  UNSUPPORTED: 'unsupported',
  INVALID: 'invalid',
});

export const REPOSITORY_CONTEXT_LIMITS = Object.freeze({
  scopePaths: 64,
  components: 128,
  relationships: 128,
  checks: 64,
  observations: 256,
  unknowns: 64,
  omissions: 32,
  referencesPerItem: 16,
  commandArgs: 32,
  idCharacters: 128,
  pathCharacters: 512,
  shortTextCharacters: 512,
  textCharacters: 2_000,
  commandCharacters: 1_024,
});

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const REVISION_PATTERN = /^[a-f0-9]{7,64}$/i;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const OBSERVATION_KINDS = new Set(['observed', 'inferred']);
const OMISSION_REASONS = new Set([
  'size_limit',
  'scope_limit',
  'timeout',
  'access_denied',
  'unsupported_file',
  'other',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactObject(value, field, keys) {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  const allowed = new Set(keys);

  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`${field}.${key} is not supported`);

  return value;
}

function boundedString(value, field, maximum = REPOSITORY_CONTEXT_LIMITS.textCharacters) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();

  if (normalized.length > maximum)
    throw new Error(`${field} must contain at most ${maximum} characters`);

  return normalized;
}

function identifier(value, field) {
  const normalized = boundedString(value, field, REPOSITORY_CONTEXT_LIMITS.idCharacters);

  if (!ID_PATTERN.test(normalized)) throw new Error(`${field} must be a bounded stable identifier`);

  return normalized;
}

function hash(value, field) {
  const normalized = boundedString(value, field, 64).toLowerCase();

  if (!HASH_PATTERN.test(normalized)) throw new Error(`${field} must be a sha256 checksum`);

  return normalized;
}

function revision(value, field) {
  const normalized = boundedString(value, field, 64).toLowerCase();

  if (!REVISION_PATTERN.test(normalized)) throw new Error(`${field} must be a Git commit SHA`);

  return normalized;
}

function timestamp(value, field) {
  const normalized = boundedString(value, field, 64);
  const parsed = new Date(normalized);

  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(normalized) ||
    Number.isNaN(parsed.getTime())
  )
    throw new Error(`${field} must be an ISO timestamp`);

  return normalized;
}

function relativePath(value, field, { allowRoot = false } = {}) {
  const normalized = boundedString(value, field, REPOSITORY_CONTEXT_LIMITS.pathCharacters);

  if (allowRoot && normalized === '.') return normalized;
  if (
    normalized.startsWith('/') ||
    normalized.startsWith('\\') ||
    normalized.includes('\\') ||
    normalized.includes('\0') ||
    normalized.startsWith('./') ||
    normalized.endsWith('/') ||
    normalized.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    throw new Error(`${field} must stay inside the repository root`);

  return normalized;
}

function boundedArray(value, field, maximum, mapper) {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  if (value.length > maximum) throw new Error(`${field} must contain at most ${maximum} items`);

  return value.map((item, index) => mapper(item, `${field}[${index}]`));
}

function unique(values, field, key = (value) => value) {
  const seen = new Set();

  for (const value of values) {
    const identity = key(value);

    if (seen.has(identity)) throw new Error(`${field} contains duplicate ${identity}`);
    seen.add(identity);
  }

  return values;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;

  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function publicTaskContract(task) {
  const contract = validateTaskContract(task);

  return {
    id: contract.id,
    title: contract.title.trim(),
    goal: contract.goal.trim(),
    ...(contract.description === undefined ? {} : { description: contract.description.trim() }),
    ...(contract.projectId === undefined ? {} : { projectId: contract.projectId }),
    profile: contract.profile,
    risk: contract.risk,
    base_ref: contract.base_ref,
    ...(contract.tags === undefined ? {} : { tags: contract.tags }),
    ...(contract.verification === undefined
      ? {}
      : {
          verification: contract.verification.map((item) => ({
            command: item.command.trim(),
            args: item.args,
          })),
        }),
    acceptance: contract.acceptance.map((item) => ({
      id: item.id.trim(),
      criterion: item.criterion.trim(),
    })),
    integration: contract.integration,
  };
}

export function taskContractFingerprint(task) {
  return sha256(canonicalJson(publicTaskContract(task)));
}

function normalizeIdentity(value, field = 'task') {
  const record = exactObject(value, field, ['taskId', 'projectId', 'contractFingerprint']);

  return {
    taskId: identifier(record.taskId, `${field}.taskId`),
    projectId: identifier(record.projectId, `${field}.projectId`),
    contractFingerprint: hash(record.contractFingerprint, `${field}.contractFingerprint`),
  };
}

function normalizeScope(value, field = 'scope') {
  const record = exactObject(value, field, ['paths']);
  const paths = boundedArray(
    record.paths,
    `${field}.paths`,
    REPOSITORY_CONTEXT_LIMITS.scopePaths,
    (item, itemField) => relativePath(item, itemField, { allowRoot: true }),
  );

  if (!paths.length) throw new Error(`${field}.paths must contain at least one path`);

  return { paths: unique(paths, `${field}.paths`) };
}

export function validateScoutContextRequest(request) {
  const record = exactObject(request, 'scout request', [
    'schemaVersion',
    'requestId',
    'attemptId',
    'task',
    'repository',
    'scope',
  ]);

  if (record.schemaVersion !== SCOUT_CONTEXT_REQUEST_VERSION)
    throw new Error(`unsupported scout context request version: ${record.schemaVersion}`);
  const repository = exactObject(record.repository, 'scout request.repository', [
    'repositoryId',
    'revision',
  ]);

  return {
    schemaVersion: SCOUT_CONTEXT_REQUEST_VERSION,
    requestId: identifier(record.requestId, 'scout request.requestId'),
    attemptId: identifier(record.attemptId, 'scout request.attemptId'),
    task: normalizeIdentity(record.task, 'scout request.task'),
    repository: {
      repositoryId: identifier(repository.repositoryId, 'scout request.repository.repositoryId'),
      revision: revision(repository.revision, 'scout request.repository.revision'),
    },
    scope: normalizeScope(record.scope, 'scout request.scope'),
  };
}

export function createScoutContextRequest({
  task,
  projectId = task?.projectId,
  repositoryId,
  revision: sourceRevision,
  scopePaths = ['.'],
  requestId,
  attemptId,
}) {
  const contract = publicTaskContract(task);

  return validateScoutContextRequest({
    schemaVersion: SCOUT_CONTEXT_REQUEST_VERSION,
    requestId,
    attemptId,
    task: {
      taskId: contract.id,
      projectId,
      contractFingerprint: sha256(canonicalJson(contract)),
    },
    repository: { repositoryId, revision: sourceRevision },
    scope: { paths: scopePaths },
  });
}

function stableContextId({ task, repository, scope, attemptId }) {
  return `scout-${sha256(canonicalJson({ task, repository, scope, attemptId })).slice(0, 24)}`;
}

export function repositoryContextId(request) {
  const normalized = validateScoutContextRequest(request);

  return stableContextId({
    task: normalized.task,
    repository: normalized.repository,
    scope: normalized.scope,
    attemptId: normalized.attemptId,
  });
}

function normalizeReference(value, field, sourceRevision) {
  const record = exactObject(value, field, ['path', 'revision', 'lineStart', 'lineEnd', 'symbol']);
  const lineStart = record.lineStart;
  const lineEnd = record.lineEnd;

  if (lineStart !== undefined && (!Number.isSafeInteger(lineStart) || lineStart < 1))
    throw new Error(`${field}.lineStart must be a positive integer`);
  if (lineEnd !== undefined && (!Number.isSafeInteger(lineEnd) || lineEnd < 1))
    throw new Error(`${field}.lineEnd must be a positive integer`);
  if (lineEnd !== undefined && lineStart === undefined)
    throw new Error(`${field}.lineEnd requires lineStart`);
  if (lineStart !== undefined && lineEnd !== undefined && lineEnd < lineStart)
    throw new Error(`${field}.lineEnd must not precede lineStart`);
  const normalizedRevision = revision(record.revision, `${field}.revision`);

  if (normalizedRevision !== sourceRevision)
    throw new Error(`${field}.revision must match source.revision`);

  return {
    path: relativePath(record.path, `${field}.path`),
    revision: normalizedRevision,
    ...(lineStart === undefined ? {} : { lineStart }),
    ...(lineEnd === undefined ? {} : { lineEnd }),
    ...(record.symbol === undefined
      ? {}
      : {
          symbol: boundedString(
            record.symbol,
            `${field}.symbol`,
            REPOSITORY_CONTEXT_LIMITS.shortTextCharacters,
          ),
        }),
  };
}

function normalizeReferences(value, field, sourceRevision, { required = false } = {}) {
  const references = boundedArray(
    value,
    field,
    REPOSITORY_CONTEXT_LIMITS.referencesPerItem,
    (item, itemField) => normalizeReference(item, itemField, sourceRevision),
  );

  if (required && !references.length) throw new Error(`${field} must contain source evidence`);

  return references;
}

function normalizeComponent(value, field, sourceRevision) {
  const record = exactObject(value, field, ['id', 'path', 'symbol', 'purpose', 'references']);

  return {
    id: identifier(record.id, `${field}.id`),
    path: relativePath(record.path, `${field}.path`),
    ...(record.symbol === undefined
      ? {}
      : {
          symbol: boundedString(
            record.symbol,
            `${field}.symbol`,
            REPOSITORY_CONTEXT_LIMITS.shortTextCharacters,
          ),
        }),
    purpose: boundedString(record.purpose, `${field}.purpose`),
    references: normalizeReferences(record.references, `${field}.references`, sourceRevision, {
      required: true,
    }),
  };
}

function normalizeRelationship(value, field, sourceRevision) {
  const record = exactObject(value, field, [
    'sourceComponentId',
    'targetComponentId',
    'kind',
    'description',
    'references',
  ]);

  return {
    sourceComponentId: identifier(record.sourceComponentId, `${field}.sourceComponentId`),
    targetComponentId: identifier(record.targetComponentId, `${field}.targetComponentId`),
    kind: boundedString(
      record.kind,
      `${field}.kind`,
      REPOSITORY_CONTEXT_LIMITS.shortTextCharacters,
    ),
    description: boundedString(record.description, `${field}.description`),
    references: normalizeReferences(record.references, `${field}.references`, sourceRevision, {
      required: true,
    }),
  };
}

function normalizeCheck(value, field, sourceRevision) {
  const record = exactObject(value, field, [
    'kind',
    'command',
    'args',
    'cwd',
    'reason',
    'references',
  ]);

  if (record.kind !== 'recommended') throw new Error(`${field}.kind must be recommended`);
  const args = boundedArray(
    record.args,
    `${field}.args`,
    REPOSITORY_CONTEXT_LIMITS.commandArgs,
    (item, itemField) =>
      boundedString(item, itemField, REPOSITORY_CONTEXT_LIMITS.commandCharacters),
  );

  return {
    kind: 'recommended',
    command: boundedString(
      record.command,
      `${field}.command`,
      REPOSITORY_CONTEXT_LIMITS.commandCharacters,
    ),
    args,
    ...(record.cwd === undefined
      ? {}
      : { cwd: relativePath(record.cwd, `${field}.cwd`, { allowRoot: true }) }),
    reason: boundedString(record.reason, `${field}.reason`),
    references: normalizeReferences(record.references, `${field}.references`, sourceRevision, {
      required: true,
    }),
  };
}

function normalizeObservation(value, field, sourceRevision) {
  const record = exactObject(value, field, ['kind', 'statement', 'references']);

  if (!OBSERVATION_KINDS.has(record.kind))
    throw new Error(`${field}.kind must be observed or inferred`);

  return {
    kind: record.kind,
    statement: boundedString(record.statement, `${field}.statement`),
    references: normalizeReferences(record.references, `${field}.references`, sourceRevision, {
      required: record.kind === 'observed',
    }),
  };
}

function normalizeUnknown(value, field, sourceRevision) {
  const record = exactObject(value, field, ['question', 'reason', 'references']);

  return {
    question: boundedString(record.question, `${field}.question`),
    reason: boundedString(record.reason, `${field}.reason`),
    references: normalizeReferences(record.references, `${field}.references`, sourceRevision),
  };
}

function normalizeOmission(value, field) {
  const record = exactObject(value, field, ['reason', 'detail']);

  if (!OMISSION_REASONS.has(record.reason)) throw new Error(`${field}.reason is invalid`);

  return {
    reason: record.reason,
    detail: boundedString(record.detail, `${field}.detail`),
  };
}

function normalizeRuntime(value, field) {
  const record = exactObject(value, field, ['harness', 'sessionId']);

  return {
    harness: boundedString(
      record.harness,
      `${field}.harness`,
      REPOSITORY_CONTEXT_LIMITS.shortTextCharacters,
    ),
    ...(record.sessionId === undefined
      ? {}
      : { sessionId: identifier(record.sessionId, `${field}.sessionId`) }),
  };
}

function normalizeRepositoryContext(context) {
  const record = exactObject(context, 'repository context', [
    'schemaVersion',
    'contextId',
    'task',
    'source',
    'components',
    'relationships',
    'checks',
    'observations',
    'unknowns',
    'omissions',
    'provenance',
  ]);

  if (record.schemaVersion !== REPOSITORY_CONTEXT_VERSION)
    throw new Error(`unsupported repository context version: ${record.schemaVersion}`);
  const source = exactObject(record.source, 'repository context.source', [
    'repositoryId',
    'revision',
    'scope',
    'generatedAt',
    'attemptId',
  ]);
  const normalizedTask = normalizeIdentity(record.task, 'repository context.task');
  const normalizedSource = {
    repositoryId: identifier(source.repositoryId, 'repository context.source.repositoryId'),
    revision: revision(source.revision, 'repository context.source.revision'),
    scope: normalizeScope(source.scope, 'repository context.source.scope'),
    generatedAt: timestamp(source.generatedAt, 'repository context.source.generatedAt'),
    attemptId: identifier(source.attemptId, 'repository context.source.attemptId'),
  };
  const normalizedContextId = identifier(record.contextId, 'repository context.contextId');
  const expectedContextId = stableContextId({
    task: normalizedTask,
    repository: {
      repositoryId: normalizedSource.repositoryId,
      revision: normalizedSource.revision,
    },
    scope: normalizedSource.scope,
    attemptId: normalizedSource.attemptId,
  });

  if (normalizedContextId !== expectedContextId)
    throw new Error('repository context.contextId does not match its stable identity');
  const normalizedRevision = normalizedSource.revision;
  const components = unique(
    boundedArray(
      record.components,
      'repository context.components',
      REPOSITORY_CONTEXT_LIMITS.components,
      (item, field) => normalizeComponent(item, field, normalizedRevision),
    ),
    'repository context.components',
    (component) => component.id,
  );
  const componentIds = new Set(components.map((component) => component.id));
  const relationships = boundedArray(
    record.relationships,
    'repository context.relationships',
    REPOSITORY_CONTEXT_LIMITS.relationships,
    (item, field) => normalizeRelationship(item, field, normalizedRevision),
  );

  for (const relationship of relationships)
    for (const componentId of [relationship.sourceComponentId, relationship.targetComponentId])
      if (!componentIds.has(componentId))
        throw new Error(
          `repository context relationship references unknown component ${componentId}`,
        );
  const provenance = exactObject(record.provenance, 'repository context.provenance', [
    'status',
    'runtime',
    'checksum',
  ]);

  if (!Object.values(REPOSITORY_CONTEXT_STATUS).includes(provenance.status))
    throw new Error('repository context.provenance.status must be complete or partial');
  const omissions = boundedArray(
    record.omissions,
    'repository context.omissions',
    REPOSITORY_CONTEXT_LIMITS.omissions,
    normalizeOmission,
  );

  if (provenance.status === REPOSITORY_CONTEXT_STATUS.COMPLETE && omissions.length)
    throw new Error('complete repository context cannot contain omissions');
  if (provenance.status === REPOSITORY_CONTEXT_STATUS.PARTIAL && !omissions.length)
    throw new Error('partial repository context must explain at least one omission');

  return {
    schemaVersion: REPOSITORY_CONTEXT_VERSION,
    contextId: normalizedContextId,
    task: normalizedTask,
    source: normalizedSource,
    components,
    relationships,
    checks: boundedArray(
      record.checks,
      'repository context.checks',
      REPOSITORY_CONTEXT_LIMITS.checks,
      (item, field) => normalizeCheck(item, field, normalizedRevision),
    ),
    observations: boundedArray(
      record.observations,
      'repository context.observations',
      REPOSITORY_CONTEXT_LIMITS.observations,
      (item, field) => normalizeObservation(item, field, normalizedRevision),
    ),
    unknowns: boundedArray(
      record.unknowns,
      'repository context.unknowns',
      REPOSITORY_CONTEXT_LIMITS.unknowns,
      (item, field) => normalizeUnknown(item, field, normalizedRevision),
    ),
    omissions,
    provenance: {
      status: provenance.status,
      runtime: normalizeRuntime(provenance.runtime, 'repository context.provenance.runtime'),
      checksum: hash(provenance.checksum, 'repository context.provenance.checksum'),
    },
  };
}

export function repositoryContextChecksum(context) {
  const normalized = normalizeRepositoryContext(context);
  const { checksum: _checksum, ...provenance } = normalized.provenance;

  return sha256(canonicalJson({ ...normalized, provenance }));
}

export function validateRepositoryContext(context, { verifyChecksum = true } = {}) {
  const normalized = normalizeRepositoryContext(context);
  const serialized = canonicalJson(normalized);
  const byteLength = Buffer.byteLength(serialized, 'utf8');

  if (byteLength > REPOSITORY_CONTEXT_MAX_BYTES)
    throw new Error(
      `repository context exceeds ${REPOSITORY_CONTEXT_MAX_BYTES} UTF-8 bytes (${byteLength})`,
    );
  if (verifyChecksum) {
    const expected = repositoryContextChecksum(normalized);

    if (normalized.provenance.checksum !== expected)
      throw new Error('repository context checksum does not match normalized content');
  }

  return normalized;
}

export function createRepositoryContext({
  request,
  generatedAt,
  components = [],
  relationships = [],
  checks = [],
  observations = [],
  unknowns = [],
  omissions = [],
  status = omissions.length
    ? REPOSITORY_CONTEXT_STATUS.PARTIAL
    : REPOSITORY_CONTEXT_STATUS.COMPLETE,
  runtime,
}) {
  const normalizedRequest = validateScoutContextRequest(request);
  const draft = {
    schemaVersion: REPOSITORY_CONTEXT_VERSION,
    contextId: repositoryContextId(normalizedRequest),
    task: normalizedRequest.task,
    source: {
      repositoryId: normalizedRequest.repository.repositoryId,
      revision: normalizedRequest.repository.revision,
      scope: normalizedRequest.scope,
      generatedAt,
      attemptId: normalizedRequest.attemptId,
    },
    components,
    relationships,
    checks,
    observations,
    unknowns,
    omissions,
    provenance: {
      status,
      runtime,
      checksum: '0'.repeat(64),
    },
  };
  const normalized = normalizeRepositoryContext(draft);
  const { checksum: _checksum, ...provenance } = normalized.provenance;
  const checksum = sha256(canonicalJson({ ...normalized, provenance }));

  return validateRepositoryContext({
    ...normalized,
    provenance: { ...normalized.provenance, checksum },
  });
}

export function evaluateRepositoryContext(context, current = {}) {
  if (context?.schemaVersion !== REPOSITORY_CONTEXT_VERSION)
    return {
      status: REPOSITORY_CONTEXT_APPLICABILITY.UNSUPPORTED,
      applicable: false,
      reasons: [`unsupported repository context version: ${context?.schemaVersion}`],
    };
  let normalized;

  try {
    normalized = validateRepositoryContext(context);
  } catch (error) {
    return {
      status: REPOSITORY_CONTEXT_APPLICABILITY.INVALID,
      applicable: false,
      reasons: [error.message],
    };
  }
  const expectedFingerprint = current.task
    ? taskContractFingerprint(current.task)
    : current.contractFingerprint;
  const expected = {
    taskId: current.task?.id ?? current.taskId,
    projectId: current.projectId ?? current.task?.projectId,
    contractFingerprint: expectedFingerprint,
    repositoryId: current.repositoryId,
    revision: current.revision?.toLowerCase(),
  };
  const actual = {
    taskId: normalized.task.taskId,
    projectId: normalized.task.projectId,
    contractFingerprint: normalized.task.contractFingerprint,
    repositoryId: normalized.source.repositoryId,
    revision: normalized.source.revision,
  };
  const reasons = Object.entries(expected)
    .filter(([, value]) => value !== undefined && value !== null)
    .filter(([field, value]) => actual[field] !== value)
    .map(([field]) => `${field} changed`);

  return reasons.length
    ? { status: REPOSITORY_CONTEXT_APPLICABILITY.STALE, applicable: false, reasons }
    : { status: REPOSITORY_CONTEXT_APPLICABILITY.CURRENT, applicable: true, reasons: [] };
}
