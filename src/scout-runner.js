import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { HARNESS_NAME } from './domain.js';
import {
  APPROVAL_DECISION,
  CodexHarness,
  ExternalHarnessUnavailable,
  HarnessInterruptedError,
  HarnessTimeoutError,
  OpenCodeHarness,
} from './harness.js';
import { EXECUTION_ROLE, prepareExecutionBrief } from './execution-brief.js';
import { redactSecrets } from './security.js';
import {
  createRepositoryContext,
  createScoutContextRequest,
  REPOSITORY_CONTEXT_MAX_BYTES,
  REPOSITORY_CONTEXT_STATUS,
  repositoryContextId,
  repositoryContextChecksum,
  validateRepositoryContext,
} from './scout-context.js';

export const SCOUT_EVENT = Object.freeze({
  REQUESTED: 'SCOUT_ATTEMPT_REQUESTED',
  PUBLISHED: 'SCOUT_CONTEXT_PUBLISHED',
  FAILED: 'SCOUT_ATTEMPT_FAILED',
  INTERRUPTED: 'SCOUT_ATTEMPT_INTERRUPTED',
  CANCEL_REQUESTED: 'SCOUT_CANCEL_REQUESTED',
  RECOVERED: 'SCOUT_CONTEXT_RECOVERED',
});

export const SCOUT_STATUS = Object.freeze({
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  INTERRUPTED: 'interrupted',
  CANCELLED: 'cancelled',
  UNAVAILABLE: 'unavailable',
});

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
const SCOUT_RAW_OUTPUT_MAX_BYTES = 256 * 1024;
const SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024;
const SNAPSHOT_FILE_LIMIT = 32;
const SAFE_COMMAND_PATTERN =
  /(?:^|\s)(?:npm|pnpm|yarn|bun|pip|pip3|pytest|vitest|jest|mocha|curl|wget|nc|ssh)\b/i;
const FORBIDDEN_GIT_COMMAND_PATTERN =
  /\bgit\s+(?:add|apply|checkout|clean|commit|merge|mv|push|rebase|reset|restore|rm|switch|worktree)\b/i;
const FORBIDDEN_SCOUT_COMMAND_PATTERN =
  /(?:install|ci|add|remove|update|exec\s+(?:test|build)|test|push|commit|checkout|reset|curl|wget|ssh|netcat)/i;

export const SCOUT_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['components', 'relationships', 'checks', 'observations', 'unknowns', 'omissions'],
  properties: {
    components: { type: 'array', maxItems: 128, items: { type: 'object' } },
    relationships: { type: 'array', maxItems: 128, items: { type: 'object' } },
    checks: { type: 'array', maxItems: 64, items: { type: 'object' } },
    observations: { type: 'array', maxItems: 256, items: { type: 'object' } },
    unknowns: { type: 'array', maxItems: 64, items: { type: 'object' } },
    omissions: { type: 'array', maxItems: 32, items: { type: 'object' } },
  },
});

class ScoutPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScoutPolicyError';
    this.code = 'SCOUT_POLICY_VIOLATION';
  }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function git(args, cwd, options = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: options.encoding ?? 'utf8',
    input: options.input,
    maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function safeRelativePath(root, value, field = 'path') {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`);
  const normalized = value.trim();
  const target = resolve(root, normalized);
  const rootRelative = relative(root, target);

  if (isAbsolute(rootRelative) || rootRelative === '..' || rootRelative.startsWith(`..${sep}`))
    throw new Error(`${field} escapes the repository root`);

  return normalized === '.' ? '.' : rootRelative.split(sep).join('/');
}

function repositoryMetadata(cwd, requestedRevision) {
  const repositoryRoot = git(['rev-parse', '--show-toplevel'], cwd).trim();

  if (
    requestedRevision !== undefined &&
    (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(requestedRevision) || requestedRevision.includes('..'))
  )
    throw new Error('--revision must be a safe commit SHA or Git ref');
  const resolvedRevision = requestedRevision
    ? git(['rev-parse', '--verify', `${requestedRevision}^{commit}`], repositoryRoot).trim()
    : git(['rev-parse', 'HEAD'], repositoryRoot).trim();
  const dirty = Boolean(
    git(['status', '--porcelain', '--untracked-files=all'], repositoryRoot).trim(),
  );

  return { repositoryRoot, revision: resolvedRevision, dirty };
}

function removeSnapshot(snapshotRoot) {
  if (!snapshotRoot || !existsSync(snapshotRoot)) return;

  const thaw = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);

      if (entry.isDirectory()) {
        thaw(path);
        chmodSync(path, 0o700);
      } else if (entry.isFile()) chmodSync(path, 0o600);
    }
  };

  try {
    thaw(snapshotRoot);
    chmodSync(snapshotRoot, 0o700);
  } catch {
    // The best-effort thaw still leaves rmSync to report the original cleanup failure.
  }
  rmSync(snapshotRoot, { recursive: true, force: true });
}

function createSnapshot(repositoryRoot, revision) {
  const snapshotRoot = mkdtempSync(join(tmpdir(), 'clew-scout-'));

  try {
    const archive = git(['archive', '--format=tar', revision], repositoryRoot, {
      encoding: null,
      maxBuffer: SNAPSHOT_MAX_BYTES,
    });

    execFileSync('tar', ['-x', '-f', '-'], {
      cwd: snapshotRoot,
      input: archive,
      stdio: ['pipe', 'ignore', 'pipe'],
      maxBuffer: 2 * 1024 * 1024,
    });
    const freeze = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);

        if (entry.isDirectory()) {
          freeze(path);
          chmodSync(path, 0o555);
        } else if (entry.isFile()) chmodSync(path, 0o444);
        else if (entry.isSymbolicLink())
          throw new Error(`symbolic links are not supported in a scout snapshot: ${path}`);
      }
    };

    freeze(snapshotRoot);
    chmodSync(snapshotRoot, 0o555);

    return snapshotRoot;
  } catch (error) {
    removeSnapshot(snapshotRoot);
    throw new Error(`unable to prepare read-only commit snapshot: ${error.message}`, {
      cause: error,
    });
  }
}

function listSnapshotFiles(root, scopePaths) {
  const files = [];
  const scopes = scopePaths.map((path) => safeRelativePath(root, path, 'scope path'));
  const isInScope = (path) =>
    scopes.some((scope) => scope === '.' || path === scope || path.startsWith(`${scope}/`));
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (['.git', '.clew', '.clew-runs', 'node_modules'].includes(entry.name)) continue;
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split(sep).join('/');

      if (!isInScope(path)) continue;
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(path);
      if (files.length >= SNAPSHOT_FILE_LIMIT + 1) return;
    }
  };

  for (const scope of scopes) {
    const target = resolve(root, scope);

    if (!existsSync(target))
      throw new Error(`scope path does not exist in commit snapshot: ${scope}`);
    if (statSync(target).isDirectory()) visit(target);
    else if (statSync(target).isFile()) files.push(scope);
  }

  return [...new Set(files)].sort();
}

function sourceReference(path, revision) {
  return { path, revision };
}

function fakeScoutOutput(root, request) {
  const files = listSnapshotFiles(root, request.scope.paths);
  const selected = files.slice(0, SNAPSHOT_FILE_LIMIT);
  const components = selected.map((path, index) => ({
    id: `file-${index + 1}`,
    path,
    purpose: `Tracked repository file selected for Scout inspection: ${basename(path)}.`,
    references: [sourceReference(path, request.repository.revision)],
  }));
  const observations = selected.length
    ? [
        {
          kind: 'observed',
          statement: `The selected commit contains ${files.length} scoped file(s) available for inspection.`,
          references: [sourceReference(selected[0], request.repository.revision)],
        },
      ]
    : [];
  const checks = files.includes('package.json')
    ? [
        {
          kind: 'recommended',
          command: 'npm test',
          args: [],
          reason:
            'The commit contains a package manifest; run the project test policy after implementation.',
          references: [sourceReference('package.json', request.repository.revision)],
        },
      ]
    : [];
  const omissions =
    files.length > SNAPSHOT_FILE_LIMIT
      ? [
          {
            reason: 'scope_limit',
            detail: `Fake scout bounded the preview to ${SNAPSHOT_FILE_LIMIT} files.`,
          },
        ]
      : [];

  return { components, relationships: [], checks, observations, unknowns: [], omissions };
}

export class ScoutFixtureHarness {
  async run({ cwd, scoutRequest, onEvent = () => {}, signal }) {
    if (signal?.aborted) throw new HarnessInterruptedError('Scout fixture harness');
    const sessionId = `scout-fake-${scoutRequest.attemptId}`;

    onEvent({ type: 'SESSION_STARTED', sessionId });
    onEvent({ type: 'TURN_STARTED', sessionId });
    onEvent({ type: 'HARNESS_COMPLETED', sessionId });

    return { sessionId, output: fakeScoutOutput(cwd, scoutRequest) };
  }
}

function createDefaultHarness(name, config, timeoutMs) {
  if (name === HARNESS_NAME.FAKE) return new ScoutFixtureHarness();
  if (name === HARNESS_NAME.CODEX)
    return new CodexHarness({
      command: config.codexBin,
      timeoutMs,
      openDesktop: false,
      trustedWorkspaceRoot: config.worktreeRoot,
    });
  if (name === HARNESS_NAME.OPENCODE)
    return new OpenCodeHarness({ baseUrl: config.openCodeUrl, timeoutMs });

  return new ExternalHarnessUnavailable(name);
}

function normalizeHarnessOutput(output) {
  let candidate = output;

  let rawSize;

  try {
    rawSize = Buffer.byteLength(
      typeof candidate === 'string' ? candidate : JSON.stringify(candidate),
    );
  } catch (error) {
    throw new Error(`scout harness output cannot be serialized: ${error.message}`, {
      cause: error,
    });
  }
  if (rawSize > SCOUT_RAW_OUTPUT_MAX_BYTES)
    throw new Error(`scout harness output exceeds ${SCOUT_RAW_OUTPUT_MAX_BYTES} bytes`);

  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate);
    } catch (error) {
      throw new Error(`scout harness returned invalid JSON: ${error.message}`, { cause: error });
    }
  }
  if (candidate?.output !== undefined) return normalizeHarnessOutput(candidate.output);
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
    throw new Error('scout harness returned a non-object result');

  const fields = ['components', 'relationships', 'checks', 'observations', 'unknowns', 'omissions'];

  for (const field of fields)
    if (!Array.isArray(candidate[field])) throw new Error(`scout output.${field} must be an array`);
  for (const key of Object.keys(candidate))
    if (!fields.includes(key)) throw new Error(`scout output.${key} is not supported`);

  return candidate;
}

function commandFromEvent(event) {
  return typeof event.command === 'string' ? event.command : '';
}

function isForbiddenScoutEvent(event) {
  const command = commandFromEvent(event);

  if (!command) return false;

  return (
    SAFE_COMMAND_PATTERN.test(command) ||
    FORBIDDEN_GIT_COMMAND_PATTERN.test(command) ||
    FORBIDDEN_SCOUT_COMMAND_PATTERN.test(command)
  );
}

function validateOutputSources(context, snapshotRoot) {
  const references = [];

  for (const component of context.components) {
    references.push({ path: component.path });
    references.push(...component.references);
  }
  for (const relationship of context.relationships) references.push(...relationship.references);
  for (const check of context.checks) references.push(...check.references);
  for (const observation of context.observations) references.push(...observation.references);
  for (const unknown of context.unknowns) references.push(...unknown.references);

  for (const reference of references) {
    const path = safeRelativePath(snapshotRoot, reference.path, 'source reference path');
    const target = resolve(snapshotRoot, path);

    if (!existsSync(target) || !lstatSync(target).isFile())
      throw new Error(`source reference does not point to a file in the commit: ${path}`);
    const realTarget = resolve(target);
    const realRoot = resolve(snapshotRoot);

    if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${sep}`))
      throw new Error(`source reference escapes the commit snapshot: ${path}`);
    if (reference.lineStart === undefined && reference.lineEnd === undefined) continue;
    const fileSize = statSync(target).size;

    if (fileSize > 8 * 1024 * 1024)
      throw new Error(`source reference file is too large to validate line range: ${path}`);
    const lineCount = readFileSync(target, 'utf8').split('\n').length;

    if (reference.lineStart > lineCount || (reference.lineEnd ?? reference.lineStart) > lineCount)
      throw new Error(`source reference line range exceeds ${path}`);
  }
}

function scoutStateDirectory(cwd) {
  return join(cwd, '.clew', 'scout');
}

function contextFilePath(cwd, taskId, contextId) {
  return join(scoutStateDirectory(cwd), taskId, `${contextId}.json`);
}

function statePathFromEvent(cwd, path) {
  if (typeof path !== 'string' || !path.trim()) throw new Error('scout context path is missing');
  const root = resolve(scoutStateDirectory(cwd));
  const target = resolve(cwd, path);

  if (target !== root && !target.startsWith(`${root}${sep}`))
    throw new Error('scout context path escapes the scout state directory');

  return target;
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;

  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function readContextFile(path) {
  if (!existsSync(path)) return null;
  try {
    return validateRepositoryContext(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    throw new Error(`published scout context is corrupt: ${error.message}`, { cause: error });
  }
}

function requestHash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function resultFromEvent({
  taskId,
  event,
  context = null,
  status,
  duplicate = false,
  error = null,
}) {
  return {
    version: 1,
    taskId,
    requestId: event.payload.requestId,
    attemptId: event.payload.attemptId,
    status,
    duplicate,
    revision: event.payload.revision ?? context?.source.revision ?? null,
    dirtyChanges: event.payload.dirtyChanges ?? null,
    contextId: event.payload.contextId ?? context?.contextId ?? null,
    checksum: event.payload.checksum ?? context?.provenance.checksum ?? null,
    path: event.payload.path ?? null,
    context,
    error,
    retryRequired: ['failed', 'interrupted', 'cancelled', 'unavailable'].includes(status),
  };
}

function findPublishedEvent(events, requestId) {
  return events
    .filter(
      (event) =>
        [SCOUT_EVENT.PUBLISHED, SCOUT_EVENT.RECOVERED].includes(event.type) &&
        event.payload.requestId === requestId,
    )
    .at(-1);
}

function findRequestEvent(events, requestId) {
  return events
    .filter(
      (event) => event.type === SCOUT_EVENT.REQUESTED && event.payload.requestId === requestId,
    )
    .at(-1);
}

function findTerminalEvent(events, requestId) {
  return events
    .filter(
      (event) =>
        [SCOUT_EVENT.FAILED, SCOUT_EVENT.INTERRUPTED].includes(event.type) &&
        event.payload.requestId === requestId,
    )
    .at(-1);
}

export class ScoutRunner {
  constructor({ cwd = process.cwd(), store, config = {}, harnessFactory = null } = {}) {
    if (!store) throw new Error('ScoutRunner requires a Store');
    this.cwd = resolve(cwd);
    this.store = store;
    this.config = config;
    this.harnessFactory = harnessFactory;
    this.active = new Map();
  }

  taskContext(task) {
    const projectId = task.contract.projectId ?? task.project_id ?? 'local';
    const project = this.store.getProject(projectId);
    const repositoryRoot = project?.repository_root ?? this.cwd;
    const repositoryId = project?.id ?? `repo-${requestHash(repositoryRoot).slice(0, 16)}`;

    return { projectId, repositoryId, repositoryRoot };
  }

  requestFor(task, args) {
    const context = this.taskContext(task);
    const metadata = repositoryMetadata(context.repositoryRoot, getOptionValue(args, '--revision'));
    const harness = getOptionValue(args, '--harness', HARNESS_NAME.CODEX);
    const paths = getOptionValues(args, '--path');
    const scopePaths = paths.length ? paths : ['.'];
    const requestSeed = {
      taskId: task.id,
      projectId: context.projectId,
      repositoryId: context.repositoryId,
      revision: metadata.revision,
      scopePaths,
      harness,
    };
    const requestId = getOptionValue(
      args,
      '--request-id',
      `scout-${requestHash(requestSeed).slice(0, 24)}`,
    );
    const attemptId = getOptionValue(args, '--attempt-id', requestId);
    const request = createScoutContextRequest({
      task: task.contract,
      projectId: context.projectId,
      repositoryId: context.repositoryId,
      revision: metadata.revision,
      scopePaths,
      requestId,
      attemptId,
    });

    return { context, metadata, request, harness };
  }

  async execute(args, signal) {
    const action = args[0];

    if (action === 'show') return this.show(args[1], args);
    if (action === 'cancel') return this.cancel(args[1], args);

    return this.run(action, args, signal);
  }

  async run(taskId, args, signal) {
    if (!taskId) throw new Error('task id is required');
    const task = this.store.getTask(taskId);

    if (!task) throw new Error(`task not found: ${taskId}`);
    const {
      context: taskContext,
      metadata,
      request,
      harness: harnessName,
    } = this.requestFor(task, args);
    const events = this.store.listEvents(taskId);
    const published = findPublishedEvent(events, request.requestId);
    const publishedPath = published?.payload.path;

    if (published) {
      const resolvedPublishedPath = publishedPath
        ? statePathFromEvent(this.cwd, publishedPath)
        : null;

      if (!resolvedPublishedPath || !existsSync(resolvedPublishedPath))
        return resultFromEvent({
          taskId,
          event: published,
          status: SCOUT_STATUS.UNAVAILABLE,
          error: 'scout context reference is dangling; published file is missing',
        });
      const context = readContextFile(resolvedPublishedPath);

      return resultFromEvent({
        taskId,
        event: published,
        context,
        status: SCOUT_STATUS.COMPLETED,
        duplicate: true,
      });
    }
    const previousRequest = findRequestEvent(events, request.requestId);
    const terminal = findTerminalEvent(events, request.requestId);

    if (terminal)
      return resultFromEvent({
        taskId,
        event: { payload: { ...previousRequest?.payload, ...terminal.payload } },
        status:
          terminal.type === SCOUT_EVENT.INTERRUPTED
            ? SCOUT_STATUS.INTERRUPTED
            : (terminal.payload.status ?? SCOUT_STATUS.FAILED),
        error: terminal.payload.error,
        duplicate: true,
      });
    if (this.active.has(request.requestId))
      return resultFromEvent({
        taskId,
        event: previousRequest,
        status: SCOUT_STATUS.RUNNING,
        duplicate: true,
      });
    if (previousRequest) {
      const expectedContextId = repositoryContextId(request);
      const recoveryPath = contextFilePath(this.cwd, taskId, expectedContextId);

      if (existsSync(recoveryPath)) {
        try {
          const recoveredContext = readContextFile(recoveryPath);

          if (
            recoveredContext.contextId === expectedContextId &&
            recoveredContext.task.taskId === request.task.taskId &&
            recoveredContext.source.revision === request.repository.revision &&
            recoveredContext.source.attemptId === request.attemptId
          ) {
            const recoveredPayload = {
              requestId: request.requestId,
              attemptId: request.attemptId,
              contextId: recoveredContext.contextId,
              checksum: repositoryContextChecksum(recoveredContext),
              path: relative(this.cwd, recoveryPath).split(sep).join('/'),
              revision: metadata.revision,
              dirtyChanges: metadata.dirty,
              status: SCOUT_STATUS.COMPLETED,
              recoveredAt: new Date().toISOString(),
            };

            this.store.appendEvent(taskId, SCOUT_EVENT.RECOVERED, recoveredPayload);

            return resultFromEvent({
              taskId,
              event: { payload: recoveredPayload },
              context: recoveredContext,
              status: SCOUT_STATUS.COMPLETED,
              duplicate: true,
            });
          }
        } catch (error) {
          const recoveryError = redactSecrets(
            `scout recovery file is corrupt: ${errorText(error)}`,
          );

          this.store.appendEvent(taskId, SCOUT_EVENT.FAILED, {
            requestId: request.requestId,
            attemptId: request.attemptId,
            status: SCOUT_STATUS.FAILED,
            revision: metadata.revision,
            dirtyChanges: metadata.dirty,
            error: recoveryError,
            failedAt: new Date().toISOString(),
          });

          return resultFromEvent({
            taskId,
            event: previousRequest,
            status: SCOUT_STATUS.FAILED,
            error: recoveryError,
            duplicate: true,
          });
        }
      }
      const ownerPid = previousRequest.payload.ownerPid;

      if (!ownerPid) {
        const interruptionError = 'scout attempt was interrupted before publication';

        this.store.appendEvent(taskId, SCOUT_EVENT.INTERRUPTED, {
          requestId: request.requestId,
          attemptId: request.attemptId,
          status: SCOUT_STATUS.INTERRUPTED,
          error: interruptionError,
        });

        return resultFromEvent({
          taskId,
          event: previousRequest,
          status: SCOUT_STATUS.INTERRUPTED,
          error: interruptionError,
          duplicate: true,
        });
      }
      if (ownerPid) {
        try {
          process.kill(ownerPid, 0);

          return resultFromEvent({
            taskId,
            event: previousRequest,
            status: SCOUT_STATUS.RUNNING,
            duplicate: true,
          });
        } catch {
          this.store.appendEvent(taskId, SCOUT_EVENT.INTERRUPTED, {
            requestId: request.requestId,
            attemptId: request.attemptId,
            status: SCOUT_STATUS.INTERRUPTED,
            error: 'scout owner process is no longer running',
          });

          return resultFromEvent({
            taskId,
            event: previousRequest,
            status: SCOUT_STATUS.INTERRUPTED,
            error: 'scout owner process is no longer running',
            duplicate: true,
          });
        }
      }
    }
    const timeoutMs = Number(getOptionValue(args, '--timeout-ms', DEFAULT_TIMEOUT_MS));

    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_TIMEOUT_MS)
      throw new Error(`--timeout-ms must be between 100 and ${MAX_TIMEOUT_MS} milliseconds`);
    const requestedAt = new Date().toISOString();
    const requestPayload = {
      requestId: request.requestId,
      attemptId: request.attemptId,
      idempotencyKey: request.requestId,
      revision: metadata.revision,
      dirtyChanges: metadata.dirty,
      repositoryId: request.repository.repositoryId,
      scope: request.scope,
      harness: harnessName,
      ownerPid: process.pid,
      requestedAt,
      status: SCOUT_STATUS.RUNNING,
    };

    const claim = this.store.runInTransaction(() => {
      const currentEvents = this.store.listEvents(taskId);
      const currentPublished = findPublishedEvent(currentEvents, request.requestId);

      if (currentPublished) return { kind: 'published' };
      const currentRequest = findRequestEvent(currentEvents, request.requestId);
      const currentTerminal = findTerminalEvent(currentEvents, request.requestId);

      if (currentTerminal) return { kind: 'terminal', request: currentRequest, currentTerminal };
      if (currentRequest) return { kind: 'running', request: currentRequest };
      this.store.appendEvent(taskId, SCOUT_EVENT.REQUESTED, requestPayload);

      return { kind: 'claimed' };
    });

    if (claim.kind === 'published') return this.run(taskId, args, signal);
    if (claim.kind === 'terminal')
      return resultFromEvent({
        taskId,
        event: {
          payload: { ...claim.request?.payload, ...claim.currentTerminal.payload },
        },
        status:
          claim.currentTerminal.type === SCOUT_EVENT.INTERRUPTED
            ? SCOUT_STATUS.INTERRUPTED
            : (claim.currentTerminal.payload.status ?? SCOUT_STATUS.FAILED),
        error: claim.currentTerminal.payload.error,
        duplicate: true,
      });
    if (claim.kind === 'running')
      return resultFromEvent({
        taskId,
        event: claim.request,
        status: SCOUT_STATUS.RUNNING,
        duplicate: true,
      });
    const runController = new AbortController();
    const abortFromCaller = () => runController.abort();
    const pollTimer = setInterval(() => {
      const currentEvents = this.store.listEvents(taskId);
      const cancelled = currentEvents.some(
        (event) =>
          event.type === SCOUT_EVENT.CANCEL_REQUESTED &&
          event.payload.requestId === request.requestId,
      );

      if (cancelled) runController.abort();
    }, 100);

    pollTimer.unref?.();
    signal?.addEventListener('abort', abortFromCaller, { once: true });
    this.active.set(request.requestId, runController);
    let snapshotRoot = null;

    try {
      snapshotRoot = createSnapshot(taskContext.repositoryRoot, metadata.revision);
      const harness = this.harnessFactory
        ? this.harnessFactory(harnessName)
        : createDefaultHarness(harnessName, this.config, timeoutMs);
      const executionBrief = prepareExecutionBrief({
        task: task.contract,
        role: EXECUTION_ROLE.ARCHITECT,
        stageId: 'scout',
        assignmentGoal: [
          'Inspect only the supplied read-only commit snapshot for this Task.',
          'Return JSON matching the supplied Scout output schema.',
          `Keep the normalized result below ${REPOSITORY_CONTEXT_MAX_BYTES} UTF-8 bytes.`,
          'Do not edit files, install dependencies, run tests/builds, access the network, or mutate Git.',
          'Use repository-relative source references at the supplied revision.',
          'Keep observations, inferences, checks, unknowns, and omissions in their separate fields.',
        ].join(' '),
        revision: metadata.revision,
        readOnly: true,
        requiredEvidence: [],
      });
      let policyViolation = null;
      const onEvent = (event) => {
        if (isForbiddenScoutEvent(event)) {
          policyViolation = new ScoutPolicyError(
            `scout blocked forbidden tool command: ${commandFromEvent(event)}`,
          );
          runController.abort();
        }
        if (
          typeof event.method === 'string' &&
          FORBIDDEN_SCOUT_COMMAND_PATTERN.test(event.method)
        ) {
          policyViolation = new ScoutPolicyError(
            `scout blocked forbidden tool event: ${event.method}`,
          );
          runController.abort();
        }
      };
      const harnessRun = harness.run({
        task: task.contract,
        executionBrief,
        stageId: 'scout',
        cwd: snapshotRoot,
        readOnly: true,
        signal: runController.signal,
        outputSchema: SCOUT_OUTPUT_SCHEMA,
        scoutRequest: request,
        onEvent,
        onApproval: async () => {
          policyViolation = new ScoutPolicyError('scout cannot grant a harness approval');
          runController.abort();

          return APPROVAL_DECISION.DECLINE;
        },
      });
      let timeoutTimer;
      const timeout = new Promise((_, reject) => {
        timeoutTimer = setTimeout(() => {
          runController.abort();
          reject(new HarnessTimeoutError('Scout'));
        }, timeoutMs);
      });
      let harnessResult;

      try {
        harnessResult = await Promise.race([harnessRun, timeout]);
      } finally {
        clearTimeout(timeoutTimer);
      }
      if (policyViolation) throw policyViolation;
      if (runController.signal.aborted) throw new HarnessInterruptedError('Scout');
      const output = normalizeHarnessOutput(redactSecrets(harnessResult.output));
      const context = createRepositoryContext({
        request,
        generatedAt: new Date().toISOString(),
        components: output.components,
        relationships: output.relationships,
        checks: output.checks,
        observations: output.observations,
        unknowns: output.unknowns,
        omissions: output.omissions,
        status: output.omissions.length
          ? REPOSITORY_CONTEXT_STATUS.PARTIAL
          : REPOSITORY_CONTEXT_STATUS.COMPLETE,
        runtime: {
          harness: harnessName,
          ...(harnessResult.sessionId ? { sessionId: harnessResult.sessionId } : {}),
        },
      });

      validateOutputSources(context, snapshotRoot);
      const path = contextFilePath(this.cwd, taskId, context.contextId);
      const relativePath = relative(this.cwd, path).split(sep).join('/');
      const existing = existsSync(path) ? readContextFile(path) : null;

      if (existing && existing.provenance.checksum !== context.provenance.checksum)
        throw new Error('scout context path already contains a different checksum');
      if (!existing) atomicWriteJson(path, context);
      const publishedPayload = {
        requestId: request.requestId,
        attemptId: request.attemptId,
        contextId: context.contextId,
        checksum: repositoryContextChecksum(context),
        path: relativePath,
        revision: metadata.revision,
        dirtyChanges: metadata.dirty,
        status: SCOUT_STATUS.COMPLETED,
        publishedAt: new Date().toISOString(),
      };

      this.store.appendEvent(taskId, SCOUT_EVENT.PUBLISHED, publishedPayload);

      return resultFromEvent({
        taskId,
        event: { payload: publishedPayload },
        context,
        status: SCOUT_STATUS.COMPLETED,
      });
    } catch (error) {
      const cancelled = this.store
        .listEvents(taskId)
        .some(
          (event) =>
            event.type === SCOUT_EVENT.CANCEL_REQUESTED &&
            event.payload.requestId === request.requestId,
        );
      const interrupted = cancelled || error?.code === 'HARNESS_INTERRUPTED' || signal?.aborted;
      const status = cancelled
        ? SCOUT_STATUS.CANCELLED
        : interrupted
          ? SCOUT_STATUS.INTERRUPTED
          : SCOUT_STATUS.FAILED;
      const failurePayload = {
        requestId: request.requestId,
        attemptId: request.attemptId,
        status,
        revision: metadata.revision,
        dirtyChanges: metadata.dirty,
        error: redactSecrets(errorText(error)),
        failedAt: new Date().toISOString(),
      };

      this.store.appendEvent(
        taskId,
        status === SCOUT_STATUS.INTERRUPTED || status === SCOUT_STATUS.CANCELLED
          ? SCOUT_EVENT.INTERRUPTED
          : SCOUT_EVENT.FAILED,
        failurePayload,
      );

      return resultFromEvent({
        taskId,
        event: { payload: failurePayload },
        status,
        error: failurePayload.error,
      });
    } finally {
      this.active.delete(request.requestId);
      signal?.removeEventListener('abort', abortFromCaller);
      clearInterval(pollTimer);
      if (snapshotRoot) removeSnapshot(snapshotRoot);
    }
  }

  show(taskId, args = []) {
    if (!taskId) throw new Error('task id is required');
    if (!this.store.getTask(taskId)) throw new Error(`task not found: ${taskId}`);
    const events = this.store.listEvents(taskId);
    const requestedId = getOptionValue(args, '--request-id');
    const requestedContext = getOptionValue(args, '--context');
    const published = events
      .filter(
        (event) =>
          [SCOUT_EVENT.PUBLISHED, SCOUT_EVENT.RECOVERED].includes(event.type) &&
          (!requestedId || event.payload.requestId === requestedId) &&
          (!requestedContext || event.payload.contextId === requestedContext),
      )
      .at(-1);
    const request = requestedId
      ? findRequestEvent(events, requestedId)
      : events.filter((event) => event.type === SCOUT_EVENT.REQUESTED).at(-1);
    const terminal = request ? findTerminalEvent(events, request.payload.requestId) : null;

    if (published) {
      const path = statePathFromEvent(this.cwd, published.payload.path);

      if (!existsSync(path))
        return resultFromEvent({
          taskId,
          event: published,
          status: SCOUT_STATUS.UNAVAILABLE,
          error: 'scout context reference is dangling; published file is missing',
        });

      return resultFromEvent({
        taskId,
        event: published,
        context: readContextFile(path),
        status: SCOUT_STATUS.COMPLETED,
      });
    }
    if (terminal)
      return resultFromEvent({
        taskId,
        event: { payload: { ...request.payload, ...terminal.payload } },
        status: terminal.payload.status ?? SCOUT_STATUS.FAILED,
        error: terminal.payload.error,
      });
    if (request) return resultFromEvent({ taskId, event: request, status: SCOUT_STATUS.RUNNING });

    return {
      version: 1,
      taskId,
      requestId: null,
      attemptId: null,
      status: SCOUT_STATUS.UNAVAILABLE,
      duplicate: false,
      revision: null,
      dirtyChanges: null,
      contextId: null,
      checksum: null,
      path: null,
      context: null,
      error: 'no scout attempt exists for this task',
      retryRequired: true,
    };
  }

  cancel(taskId, args = []) {
    if (!taskId) throw new Error('task id is required');
    if (!this.store.getTask(taskId)) throw new Error(`task not found: ${taskId}`);
    const events = this.store.listEvents(taskId);
    const requestId =
      getOptionValue(args, '--request-id') ??
      events.filter((event) => event.type === SCOUT_EVENT.REQUESTED).at(-1)?.payload.requestId;

    if (!requestId) throw new Error('no scout attempt exists for this task');
    const request = findRequestEvent(events, requestId);
    const published = findPublishedEvent(events, requestId);

    if (!request) throw new Error(`scout request not found: ${requestId}`);
    if (published) return this.show(taskId, ['--request-id', requestId]);
    if (findTerminalEvent(events, requestId)) return this.show(taskId, ['--request-id', requestId]);
    const event = {
      requestId,
      attemptId: request.payload.attemptId,
      requestedAt: new Date().toISOString(),
    };

    this.store.appendEvent(taskId, SCOUT_EVENT.CANCEL_REQUESTED, event);

    return {
      version: 1,
      taskId,
      requestId,
      attemptId: request.payload.attemptId,
      status: SCOUT_STATUS.CANCELLED,
      duplicate: false,
      revision: request.payload.revision,
      dirtyChanges: request.payload.dirtyChanges,
      contextId: null,
      checksum: null,
      path: null,
      context: null,
      error: 'scout cancellation requested',
      retryRequired: true,
    };
  }
}

function getOptionValue(args, name, fallback = undefined) {
  const index = args.indexOf(name);

  return index >= 0 ? args[index + 1] : fallback;
}

function getOptionValues(args, name) {
  const values = [];

  for (let index = 0; index < args.length; index += 1)
    if (args[index] === name && args[index + 1]) values.push(args[index + 1]);

  return values;
}

export function scoutHumanPreview(result) {
  if (result.status !== SCOUT_STATUS.COMPLETED)
    return [
      `Scout: ${result.status}`,
      `Task: ${result.taskId}`,
      `Request: ${result.requestId ?? 'none'}`,
      `Revision: ${result.revision ?? 'not available'}`,
      `Reason: ${result.error ?? 'none'}`,
    ].join('\n');
  const context = result.context;

  return [
    `Scout: ${result.status}`,
    `Task: ${result.taskId}`,
    `Request: ${result.requestId}`,
    `Revision: ${result.revision}`,
    `Dirty changes present: ${result.dirtyChanges ? 'yes (not included)' : 'no'}`,
    `Components: ${context.components.length}`,
    `Relationships: ${context.relationships.length}`,
    `Recommended checks: ${context.checks.length}`,
    `Observations: ${context.observations.length}`,
    `Unknowns: ${context.unknowns.length}`,
    `Status: ${context.provenance.status}`,
    `Checksum: ${result.checksum}`,
    `File: ${result.path}`,
  ].join('\n');
}

export { ScoutPolicyError };
