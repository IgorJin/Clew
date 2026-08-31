import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { URL } from 'node:url';
import {
  isSupportedVersion,
  SUPPORTED_CODEX_CLI_VERSION,
  SUPPORTED_OPENCODE_CLI_VERSION,
} from './compatibility.js';
import {
  OPERATOR_ACTION,
  PLAN_STATUS,
  PROFILE_NAME,
  RUN_STATUS,
  TASK_STATE,
  resolveProfile,
  validateCompletionDecision,
  validateRetryRequest,
  validateTaskContract,
} from './domain.js';
import { APPROVAL_DECISION } from './harness.js';
import { Observability } from './observability.js';
import { redactSecrets } from './security.js';
import { Scheduler } from './scheduler.js';
import { createSessionSurface, openSessionForRun } from './session-surface.js';
import { GitWorktreeManager } from './workspace.js';

const SERVICE_COMMANDS = new Set([
  'approve',
  'approve-run',
  'cleanup',
  'complete',
  'continue',
  'doctor',
  'events',
  'export',
  'interrupt',
  'plan',
  'pricing',
  'reject',
  'reject-run',
  'retry',
  'run',
  'status',
  'telemetry',
  'verify',
  'worktree',
]);
const TASK_COMMANDS = new Set([
  'create',
  'history',
  'list',
  'message',
  'result',
  'show',
  'thread',
  'usage',
]);
const SESSION_COMMANDS = new Set(['capabilities', 'open']);

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

function parseCommand(command) {
  if (Array.isArray(command)) return command;
  const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];

  return parts.map((part) =>
    part.startsWith('"') && part.endsWith('"') ? part.slice(1, -1) : part,
  );
}

function executeVerification(check, cwd) {
  const parts = parseCommand(check.command);
  const [command, ...inlineArgs] = parts;
  const args = [...inlineArgs, ...(check.args ?? [])];
  const startedAt = new Date().toISOString();

  try {
    const output = execFileSync(command, args, { cwd, encoding: 'utf8', timeout: 120_000 });

    return {
      type: 'command',
      command: [command, ...args].join(' '),
      result: 'passed',
      exitCode: 0,
      output: redactSecrets(output),
      startedAt,
      endedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      type: 'command',
      command: [command, ...args].join(' '),
      result: 'failed',
      exitCode: error.status ?? 1,
      output: redactSecrets(`${error.stdout ?? ''}${error.stderr ?? ''}`),
      startedAt,
      endedAt: new Date().toISOString(),
    };
  }
}

function probeCommand(command, args) {
  try {
    const detail = execFileSync(command, args, { encoding: 'utf8', timeout: 2_000 }).trim();

    return { ok: true, detail: redactSecrets(detail) };
  } catch (error) {
    return { ok: false, detail: error.code === 'ENOENT' ? 'not found' : 'unavailable' };
  }
}

function withVersionCompatibility(check, expectedVersion) {
  if (!check.ok) return { ...check, compatible: false, expectedVersion };
  const compatible = isSupportedVersion(check.detail, expectedVersion);

  return {
    ...check,
    ok: compatible,
    compatible,
    expectedVersion,
    detail: compatible ? check.detail : `${check.detail} (expected ${expectedVersion})`,
  };
}

async function probeOpenCodeEndpoint(value) {
  let url;

  try {
    url = new URL(value);
  } catch {
    return { ok: false, detail: 'invalid URL' };
  }
  if (!['http:', 'https:'].includes(url.protocol)) return { ok: false, detail: 'invalid URL' };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1_000);
    const response = await fetch(new URL('/global/health', url), {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    const body = await response.json().catch(() => ({}));
    const compatible =
      response.ok &&
      body.healthy === true &&
      isSupportedVersion(body.version, SUPPORTED_OPENCODE_CLI_VERSION);

    clearTimeout(timeout);

    return {
      ok: compatible,
      compatible,
      expectedVersion: SUPPORTED_OPENCODE_CLI_VERSION,
      detail: compatible
        ? `healthy ${body.version}`
        : `incompatible or unhealthy (HTTP ${response.status}, version ${body.version ?? 'unknown'})`,
    };
  } catch {
    return { ok: false, detail: 'unreachable' };
  }
}

export class ClewService {
  constructor({ cwd = process.cwd(), store, config }) {
    this.cwd = resolve(cwd);
    this.store = store;
    this.config = config;
  }

  supports(args) {
    const [command, subcommand] = args;

    if (command === 'task') return TASK_COMMANDS.has(subcommand);
    if (command === 'session') return SESSION_COMMANDS.has(subcommand);

    return SERVICE_COMMANDS.has(command);
  }

  async execute(args, { signal } = {}) {
    if (!this.supports(args)) throw new Error(`unsupported service command: ${args.join(' ')}`);
    const [command, subcommand, ...rest] = args;

    if (command === 'task') return this.task(subcommand, rest);
    if (command === 'session') return this.session(subcommand, rest);
    if (command === 'continue') return this.continueTask(subcommand, rest, signal);
    if (command === 'plan') return this.plan(subcommand);
    if (command === 'approve' || command === 'reject')
      return this.decidePlan(command, subcommand, rest);
    if (command === 'approve-run' || command === 'reject-run')
      return this.decideRun(command, subcommand, rest);
    if (command === 'interrupt') return this.interrupt(subcommand, rest);
    if (command === 'retry') return this.retry(subcommand, rest, signal);
    if (command === 'complete') return this.complete(subcommand, rest);
    if (command === 'run') return this.run(subcommand, rest, signal);
    if (command === 'pricing') return this.syncPricing(subcommand, rest);
    if (command === 'verify') return this.verify(subcommand, rest);
    if (command === 'export') return this.exportResult(subcommand, rest);
    if (command === 'cleanup') return this.cleanup(rest);
    if (command === 'status') return this.status(subcommand);
    if (command === 'events') return this.store.listEvents(subcommand);
    if (command === 'worktree') return this.worktree(subcommand, rest);
    if (command === 'telemetry') return this.telemetry(subcommand);
    if (command === 'doctor') return this.doctor([subcommand, ...rest].filter(Boolean));

    throw new Error(`unsupported service command: ${args.join(' ')}`);
  }

  taskSnapshot(taskId) {
    const task = this.store.getTask(taskId);

    if (!task) throw new Error(`task not found: ${taskId}`);

    return {
      show: {
        ...task,
        plan: this.store.getLatestPlan(task.id),
        approvals: this.store.listApprovals(task.id),
        harnessApprovals: this.store.listHarnessApprovals(task.id),
        stages: this.store.listStages(task.id),
        runs: this.store.listRuns(task.id),
        review: this.store.latestReview(task.id),
        completion: this.store.getCompletion(task.id),
      },
      thread: this.store.getTaskThread(task.id, { after: 0, limit: 500 }),
      history: this.history(task.id, []),
    };
  }

  snapshot() {
    const cursor = Number(
      this.store.db.prepare('SELECT COALESCE(MAX(seq), 0) AS cursor FROM events').get().cursor,
    );

    return {
      version: 1,
      cursor,
      generatedAt: new Date().toISOString(),
      tasks: this.store.listTasks().map((task) => this.taskSnapshot(task.id)),
    };
  }

  task(subcommand, args) {
    if (subcommand === 'create') return this.createTask(args);
    if (subcommand === 'list') return this.store.listTasks();
    if (subcommand === 'show') return this.taskSnapshot(args[0]).show;
    if (subcommand === 'thread') {
      const taskId = args[0];

      if (!taskId) throw new Error('task id is required');
      const after = Number(getOptionValue(args, '--after', 0));
      const limit = Number(getOptionValue(args, '--limit', 50));

      if (!Number.isSafeInteger(after) || after < 0)
        throw new Error('--after must be non-negative');
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('--limit must be positive');

      return this.store.getTaskThread(taskId, { after, limit });
    }
    if (subcommand === 'message') {
      const taskId = args[0];
      const message = getOptionValue(args, '--message');

      if (!taskId || !message) throw new Error('task id and --message are required');

      return this.store.recordOperatorMessage({
        taskId,
        message,
        actor: getOptionValue(args, '--actor', 'local-user'),
        target: {
          stageId: getOptionValue(args, '--stage', null),
          runId: getOptionValue(args, '--run', null),
        },
      });
    }
    if (subcommand === 'history') return this.history(args[0], args);
    if (subcommand === 'result') {
      this.store.evaluateTaskTrust(args[0]);

      return this.store.getResultManifest(args[0]);
    }
    if (subcommand === 'usage') return this.usage(args[0], args);

    throw new Error(`unsupported task command: ${subcommand}`);
  }

  createTask(args) {
    const file = getOptionValue(args, '--file');
    let contract;

    if (file) contract = JSON.parse(readFileSync(resolve(this.cwd, file), 'utf8'));
    else
      contract = {
        id: getOptionValue(args, '--id'),
        title: getOptionValue(args, '--title'),
        goal: getOptionValue(args, '--goal'),
        profile: getOptionValue(args, '--profile', PROFILE_NAME.QUICK),
        risk: getOptionValue(args, '--risk', 'medium'),
        base_ref: getOptionValue(args, '--base', 'HEAD'),
        acceptance: getOptionValues(args, '--accept'),
        verification: getOptionValues(args, '--verify').map((command) => ({ command, args: [] })),
      };
    contract = validateTaskContract(contract);
    this.store.createTask(contract);

    return contract;
  }

  history(taskId, args) {
    if (!taskId) throw new Error('task id is required');
    const attemptValue = getOptionValue(args, '--attempt');
    const attempt = attemptValue === undefined ? null : Number(attemptValue);

    if (attempt !== null && (!Number.isInteger(attempt) || attempt < 1))
      throw new Error('--attempt must be a positive integer');

    return {
      taskId,
      stages: this.store.listStages(taskId),
      runs: this.store.listRuns(taskId, {
        stageId: getOptionValue(args, '--stage', null),
        attempt,
      }),
      actions: this.store.listOperatorActions(taskId),
      events: this.store.listEvents(taskId),
    };
  }

  usage(taskId, args) {
    if (!taskId) throw new Error('task id is required');
    const attemptValue = getOptionValue(args, '--attempt');
    const attempt = attemptValue === undefined ? null : Number(attemptValue);

    if (attempt !== null && (!Number.isInteger(attempt) || attempt < 1))
      throw new Error('--attempt must be a positive integer');
    this.store.refreshUsageCosts(taskId);
    const filters = { stageId: getOptionValue(args, '--stage', null), attempt };
    const summary = this.store.getUsageSummary(taskId, filters);

    return { taskId, ...summary, records: this.store.listUsage(taskId, filters) };
  }

  async session(subcommand, args) {
    if (subcommand === 'capabilities') {
      const harness = getOptionValue(args, '--harness', 'codex');

      return {
        version: 1,
        harness,
        capabilities: createSessionSurface({
          kind: getOptionValue(args, '--surface', 'plain'),
          codexBin: this.config.codexBin,
        }).capabilities(harness),
      };
    }
    const taskId = args[0] && !args[0].startsWith('--') ? args[0] : null;

    if (!taskId) throw new Error('task id is required');
    const stageId = getOptionValue(args, '--stage', 'worker');
    const latestRun = this.store.listRuns(taskId, { stageId }).at(-1);
    const request = {
      version: 1,
      taskId,
      stageId,
      runId: getOptionValue(args, '--run', latestRun?.id ?? null),
      sessionId: getOptionValue(args, '--session', null),
      role: getOptionValue(args, '--role', 'worker'),
      harness: getOptionValue(args, '--harness', latestRun?.harness ?? 'codex'),
      mode: getOptionValue(args, '--mode', 'resume'),
    };
    const surface = createSessionSurface({
      kind: getOptionValue(args, '--surface', 'plain'),
      codexBin: this.config.codexBin,
    });

    return openSessionForRun(this.store, request, surface);
  }

  plan(taskId) {
    const plan = this.store.getLatestPlan(taskId);

    if (!plan) throw new Error(`plan not found for task ${taskId}`);

    return { ...plan, approvals: this.store.listApprovals(taskId) };
  }

  decidePlan(command, taskId, args) {
    if (!taskId) throw new Error('task id is required');
    const positionalGate = args[0] && !args[0].startsWith('--') ? args[0] : undefined;
    const decision = command === 'approve' ? PLAN_STATUS.APPROVED : PLAN_STATUS.REJECTED;

    return this.store.decideLatestPlan(taskId, decision, {
      gateId: positionalGate || 'deep-plan',
      actor: getOptionValue(args, '--actor', process.env.USER || 'local-user'),
      reason: getOptionValue(args, '--reason'),
    });
  }

  decideRun(command, approvalId, args) {
    if (!approvalId) throw new Error('harness approval id is required');
    const decision =
      command === 'approve-run' ? APPROVAL_DECISION.ACCEPT : APPROVAL_DECISION.DECLINE;

    return this.store.decideHarnessApproval(
      approvalId,
      decision,
      getOptionValue(args, '--actor', process.env.USER || 'local-user'),
    );
  }

  interrupt(taskId, args) {
    if (!taskId) throw new Error('task id is required');
    const task = this.store.getTask(taskId);

    if (!task) throw new Error(`task not found: ${taskId}`);
    if ([TASK_STATE.COMPLETED, TASK_STATE.CANCELLED].includes(task.state))
      throw new Error(`task ${taskId} is already ${task.state}`);

    return this.store.requestInterrupt(
      taskId,
      getOptionValue(args, '--actor', process.env.USER || 'local-user'),
    );
  }

  async retry(taskId, args, signal) {
    const stageId = args[0] && !args[0].startsWith('--') ? args[0] : 'worker';
    const actor = getOptionValue(args, '--actor', process.env.USER || 'local-user');
    const reason = getOptionValue(args, '--reason');
    const task = this.store.getTask(taskId);

    if (!task) throw new Error(`task not found: ${taskId}`);
    if (![TASK_STATE.READY, TASK_STATE.FAILED, TASK_STATE.BLOCKED].includes(task.state))
      throw new Error(`task ${taskId} cannot be retried from ${task.state}`);
    if (!this.store.listStages(taskId).some((stage) => stage.id === stageId))
      throw new Error(`stage not found: ${stageId}`);
    const previousRuns = this.store.listRuns(taskId, { stageId });
    const maxAttempts =
      previousRuns.at(-1)?.policy?.maxAttempts ??
      resolveProfile(getOptionValue(args, '--profile', task.contract.profile)).maxAttempts;

    if (previousRuns.length >= maxAttempts)
      throw new Error(
        `retry policy exhausted for ${taskId}: ${previousRuns.length}/${maxAttempts}`,
      );
    const request = validateRetryRequest({ taskId, stageId, actor, reason });
    const action = this.store.recordOperatorAction({
      taskId,
      action: OPERATOR_ACTION.RETRY,
      stageId,
      actor,
      reason: request.reason,
    });

    this.store.setStage(taskId, stageId, 'QUEUED');
    this.store.setTaskState(taskId, TASK_STATE.QUEUED);
    const result = await this.scheduler(args, signal).runTask(
      taskId,
      getOptionValue(args, '--profile', task.contract.profile),
      getOptionValue(args, '--harness'),
      getOptionValue(args, '--review-harness'),
      getOptionValue(args, '--architect'),
      previousRuns.length === 1 ? previousRuns.at(-1).session_id : null,
    );

    return { action, result };
  }

  async continueTask(taskId, args, signal) {
    const message = getOptionValue(args, '--message');

    if (!taskId || !message) throw new Error('task id and --message are required');
    const task = this.store.getTask(taskId);

    if (!task) throw new Error(`task not found: ${taskId}`);
    const actor = getOptionValue(args, '--actor', process.env.USER || 'local-user');
    const idempotencyKey = getOptionValue(
      args,
      '--request-id',
      createHash('sha256').update(`${taskId}:${actor}:${message}`).digest('hex'),
    );
    const existingGrant = this.store.getContinuationGrantByKey(idempotencyKey);

    if (existingGrant?.status === 'COMPLETED')
      return {
        taskId,
        grant: existingGrant,
        state: existingGrant.result_state ?? task.state,
        duplicate: true,
      };
    if (!existingGrant && ![TASK_STATE.READY, TASK_STATE.WAITING_FOR_HUMAN].includes(task.state))
      throw new Error(`task ${taskId} cannot be continued from ${task.state}`);
    const events = this.store.listEvents(taskId);
    const exhaustion = events.filter((event) => event.type === 'REVIEW_EXHAUSTED').at(-1);
    const stageId = getOptionValue(
      args,
      '--stage',
      existingGrant?.stage_id ?? exhaustion?.payload?.stageId ?? 'worker',
    );
    const latestRun =
      (existingGrant?.run_id ? this.store.getRun(existingGrant.run_id) : null) ??
      this.store.listRuns(taskId, { stageId }).at(-1) ??
      (exhaustion?.payload?.runId ? this.store.getRun(exhaustion.payload.runId) : null);
    const target = {
      stageId,
      runId: latestRun?.id ?? null,
      sessionId: latestRun?.session_id ?? null,
      cause:
        task.state === TASK_STATE.WAITING_FOR_HUMAN ? 'review_exhaustion' : 'operator_feedback',
      causeEventSeq: exhaustion?.seq ?? null,
    };
    const grant =
      existingGrant ??
      this.store.recordContinuationRequest({
        message,
        target,
        grant: {
          version: 1,
          id: randomUUID(),
          taskId,
          stageId,
          runId: latestRun?.id ?? null,
          sessionId: latestRun?.session_id ?? null,
          actor,
          reason: message,
          expectedRevision: latestRun?.commit_sha ?? 'unresolved',
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          idempotencyKey,
        },
      });
    const feedback = [{ severity: 'blocking', criterion: 'operator', reason: message }];
    const result = await this.scheduler(args, signal).runTask(
      taskId,
      getOptionValue(args, '--profile', task.contract.profile),
      getOptionValue(args, '--harness', latestRun?.harness),
      getOptionValue(args, '--review-harness'),
      getOptionValue(args, '--architect'),
      existingGrant?.session_id ?? latestRun?.session_id ?? null,
      feedback,
      {
        correctionOnly: true,
        forceSingleWorker: true,
        stageId,
        continuationGrantId: grant.id,
      },
    );

    return { taskId, grant: this.store.getContinuationGrant(grant.id), result };
  }

  complete(taskId, args) {
    const revision = getOptionValue(args, '--revision');
    const actor = getOptionValue(args, '--actor', process.env.USER || 'local-user');
    const task = this.store.getTask(taskId);

    if (!task) throw new Error(`task not found: ${taskId}`);
    if (!revision) throw new Error('--revision is required');
    this.store.evaluateTaskTrust(taskId, { revision });
    const refreshedTask = this.store.getTask(taskId);
    const reviewOverride = args.includes('--review-override');

    if (
      refreshedTask.state !== TASK_STATE.READY &&
      !(reviewOverride && refreshedTask.state === TASK_STATE.WAITING_FOR_HUMAN)
    )
      throw new Error(`task ${taskId} must be READY before completion`);
    const manifest = this.store.getResultManifest(taskId);
    const latestRevision = manifest?.revision ?? this.store.listRuns(taskId).at(-1)?.commit_sha;

    if (latestRevision !== revision)
      throw new Error('completion revision does not match current READY revision');
    const trust = this.store.evaluateTaskTrust(taskId, { revision });

    if (!trust.reusable) throw new Error('READY evidence is stale or untrusted');
    const unresolvedFindings = reviewOverride
      ? (this.store
          .listEvents(taskId)
          .filter((event) => event.type === 'REVIEW_EXHAUSTED')
          .at(-1)?.payload?.findings ?? [])
      : [];

    return this.store.recordCompletion(
      validateCompletionDecision({
        taskId,
        expectedRevision: revision,
        actor,
        note: getOptionValue(args, '--note'),
        reviewOverride,
        unresolvedFindings,
        idempotencyKey: getOptionValue(args, '--request-id', null),
      }),
      manifest,
    );
  }

  async syncPricing(subcommand, args) {
    if (subcommand !== 'sync') throw new Error(`unsupported pricing command: ${subcommand}`);
    const url = getOptionValue(args, '--url');
    const source = getOptionValue(args, '--source', 'configured');
    const provider = getOptionValue(args, '--provider', null);
    const sources = url ? [{ source, provider, url }] : (this.config.pricing?.sources ?? []);

    if (!sources.length)
      throw new Error('no pricing sources configured; pass --url URL or configure pricing.sources');
    const synced = [];

    for (const item of sources) {
      const response = await fetch(item.url);

      if (!response.ok)
        throw new Error(
          `pricing source ${item.source ?? item.url} failed: HTTP ${response.status}`,
        );
      const body = await response.json();

      synced.push(
        this.store.recordPricingSnapshot({
          source: item.source ?? item.url,
          provider: item.provider ?? provider,
          currency: body.currency ?? item.currency ?? 'USD',
          catalog: body.catalog ?? body.prices ?? body,
        }),
      );
    }

    return { synced, count: synced.length };
  }

  verify(taskId, args) {
    const revision = getOptionValue(args, '--revision');
    const stageId = getOptionValue(args, '--stage', 'worker');
    const actor = getOptionValue(args, '--actor', process.env.USER || 'local-user');
    const task = this.store.getTask(taskId);

    if (!taskId) throw new Error('task id is required');
    if (!revision) throw new Error('--revision is required');
    if (!task) throw new Error(`task not found: ${taskId}`);
    const commands = getOptionValues(args, '--command').map((command) => ({ command, args: [] }));
    const configured = commands.length ? commands : (task.contract.verification ?? []);
    const previous = this.store.latestVerification(taskId, stageId)?.evidence ?? [];
    const checks = configured.length
      ? configured
      : previous.filter((item) => item.type === 'command' && item.command);

    if (!checks.length)
      throw new Error('no verification commands configured; pass --command COMMAND');
    const run = this.store
      .listRuns(taskId, { stageId })
      .reverse()
      .find((item) => item.commit_sha === revision);

    if (!run) throw new Error(`revision ${revision} is not a known ${stageId} run revision`);
    const evidence = checks.map((check) => executeVerification(check, run.workspace));
    const report = this.store.recordVerification({ taskId, stageId, revision, actor, evidence });

    if (evidence.some((item) => item.result !== 'passed')) {
      const error = new Error('verification command failed');

      error.code = 'VERIFICATION_FAILED';
      throw error;
    }

    return report;
  }

  exportResult(taskId, args) {
    const outputDir = getOptionValue(args, '--dir');

    if (!outputDir) throw new Error('--dir is required');
    const manifest = this.store.getResultManifest(taskId);

    if (!manifest) throw new Error('result manifest is not available');
    const revision = getOptionValue(args, '--revision', manifest.revision);

    if (revision !== manifest.revision)
      throw new Error('export revision does not match result manifest');
    const base = this.store.getTask(taskId).contract.base_ref;
    const target = resolve(this.cwd, outputDir);

    if (target === this.cwd || target.startsWith(`${this.cwd}/`))
      throw new Error('refusing export inside the primary checkout');
    if (execFileSync('git', ['status', '--porcelain'], { cwd: this.cwd, encoding: 'utf8' }).trim())
      throw new Error('refusing export from a dirty primary checkout');

    mkdirSync(target, { recursive: true });
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    const checksum = createHash('sha256').update(text).digest('hex');

    writeFileSync(join(target, `${taskId}.manifest.json`), text);
    writeFileSync(
      join(target, `${taskId}.manifest.sha256`),
      `${checksum}  ${taskId}.manifest.json\n`,
    );
    writeFileSync(
      join(target, `${taskId}.patch`),
      execFileSync('git', ['diff', `${base}..${revision}`], {
        cwd: this.cwd,
        encoding: 'utf8',
      }),
    );
    execFileSync('git', ['bundle', 'create', join(target, `${taskId}.bundle`), base, revision], {
      cwd: this.cwd,
      stdio: 'pipe',
    });
    this.store.appendEvent(taskId, 'RESULT_EXPORTED', { outputDir: target, revision, checksum });

    return { taskId, outputDir: target, revision, checksum };
  }

  cleanup(args) {
    const retentionDays = Number(getOptionValue(args, '--retention-days', 0));

    if (!Number.isFinite(retentionDays) || retentionDays < 0)
      throw new Error('--retention-days must be a non-negative number');
    const manager = new GitWorktreeManager(this.resolveCommandConfig(args).worktreeRoot, this.cwd);
    const removed = [];
    const skipped = [];

    for (const task of this.store.listTasks()) {
      const completion = this.store.getCompletion(task.id);
      const events = this.store.listEvents(task.id);
      const runs = this.store.listRuns(task.id).filter((run) => run.workspace);
      const protectedReason =
        task.state !== TASK_STATE.COMPLETED
          ? 'not completed'
          : !completion
            ? 'not accepted'
            : !events.some((event) => event.type === 'RESULT_EXPORTED')
              ? 'not exported'
              : Date.now() - Date.parse(task.updated_at) < retentionDays * 86_400_000
                ? 'retention policy'
                : null;

      if (protectedReason) {
        skipped.push({ taskId: task.id, reason: protectedReason });
        continue;
      }
      for (const run of runs) {
        try {
          manager.removeWorktree(run.workspace);
          removed.push({ taskId: task.id, path: run.workspace });
        } catch (error) {
          skipped.push({ taskId: task.id, path: run.workspace, reason: error.message });
        }
      }
      if (runs.length && runs.every((run) => removed.some((item) => item.path === run.workspace)))
        this.store.appendEvent(task.id, 'WORKTREES_CLEANED', {
          paths: runs.map((run) => run.workspace),
        });
    }

    return { removed, skipped };
  }

  status(taskId) {
    const task = this.store.getTask(taskId);

    if (!task) throw new Error(`task not found: ${taskId}`);

    return {
      id: task.id,
      state: task.state,
      plan: this.store.getLatestPlan(task.id),
      approvals: this.store.listApprovals(task.id),
      harnessApprovals: this.store.listHarnessApprovals(task.id),
      stages: this.store.listStages(task.id),
      runs: this.store.listRuns(task.id),
    };
  }

  worktree(subcommand, args) {
    const manager = new GitWorktreeManager(this.resolveCommandConfig(args).worktreeRoot, this.cwd);

    if (subcommand === 'list') return manager.listWorktrees();
    if (subcommand === 'remove') {
      const path = args[0];

      if (!path) throw new Error('worktree path is required');
      const target = resolve(this.cwd, path);

      manager.removeWorktree(target, { force: args.includes('--force') });

      return { removed: target };
    }
    if (subcommand === 'prune') {
      const activeWorkspaces = this.store
        .listAllRuns()
        .filter((run) => run.status === RUN_STATUS.RUNNING && run.workspace)
        .map((run) => run.workspace);

      return manager.pruneWorktrees({ protectedPaths: activeWorkspaces });
    }

    throw new Error(`unsupported worktree command: ${subcommand}`);
  }

  async telemetry(subcommand) {
    if (subcommand !== 'status') throw new Error(`unsupported telemetry command: ${subcommand}`);
    const observability = new Observability({ cwd: this.cwd, config: this.config.observability });

    try {
      return observability.status();
    } finally {
      await observability.shutdown();
    }
  }

  async doctor(args) {
    const requiredHarness = getOptionValue(args, '--harness');
    const runtimeConfig = this.resolveCommandConfig(args);

    if (requiredHarness && !['codex', 'opencode'].includes(requiredHarness))
      throw new Error('--harness must be codex or opencode');
    const codexVersion = probeCommand(runtimeConfig.codexBin, ['--version']);
    const codexAuth = codexVersion.ok
      ? probeCommand(runtimeConfig.codexBin, ['login', 'status'])
      : { ok: false, detail: 'Codex CLI unavailable' };
    const openCodeVersion = probeCommand(runtimeConfig.openCodeBin, ['--version']);
    const telemetry = new Observability({
      cwd: this.cwd,
      config: { ...runtimeConfig.observability, enabled: true },
    });
    const telemetryStatus = telemetry.status();

    await telemetry.shutdown();
    const checks = [
      {
        name: 'node',
        ok: Number(process.versions.node.split('.')[0]) >= 22,
        required: true,
        detail: process.version,
      },
      { name: 'git', ...probeCommand('git', ['--version']), required: true },
      {
        name: 'telemetry',
        ok: telemetryStatus.state !== 'unavailable',
        required: false,
        ...telemetryStatus,
      },
      {
        name: 'codex-cli',
        ...withVersionCompatibility(codexVersion, SUPPORTED_CODEX_CLI_VERSION),
        required: requiredHarness === 'codex',
        command: runtimeConfig.codexBin,
      },
      { name: 'codex-auth', ...codexAuth, required: requiredHarness === 'codex' },
      {
        name: 'opencode-cli',
        ...withVersionCompatibility(openCodeVersion, SUPPORTED_OPENCODE_CLI_VERSION),
        required: requiredHarness === 'opencode',
        command: runtimeConfig.openCodeBin,
      },
      {
        name: 'opencode-endpoint',
        ...(await probeOpenCodeEndpoint(runtimeConfig.openCodeUrl)),
        required: requiredHarness === 'opencode',
        url: runtimeConfig.openCodeUrl,
      },
    ];

    return { ok: checks.filter((check) => check.required).every((check) => check.ok), checks };
  }

  run(taskId, args, signal) {
    if (!taskId) throw new Error('task id is required');

    return this.scheduler(args, signal).runTask(
      taskId,
      getOptionValue(args, '--profile'),
      getOptionValue(args, '--harness'),
      getOptionValue(args, '--review-harness'),
      getOptionValue(args, '--architect'),
    );
  }

  scheduler(args, signal) {
    const runtimeConfig = this.resolveCommandConfig(args);
    const manager = new GitWorktreeManager(runtimeConfig.worktreeRoot, this.cwd);

    return new Scheduler(this.store, manager, { signal, adapterConfig: runtimeConfig });
  }

  resolveCommandConfig(args) {
    return {
      ...this.config,
      codexBin: getOptionValue(args, '--codex-bin', this.config.codexBin),
      openCodeBin: getOptionValue(args, '--opencode-bin', this.config.openCodeBin),
      openCodeUrl: getOptionValue(args, '--opencode-url', this.config.openCodeUrl),
      worktreeRoot: resolve(
        this.cwd,
        getOptionValue(args, '--worktree-root', this.config.worktreeRoot),
      ),
    };
  }
}
