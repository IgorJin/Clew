import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  OPERATOR_ACTION,
  PLAN_STATUS,
  PROFILE_NAME,
  RUN_STATUS,
  TASK_STATE,
  resolveProfile,
  validateCompletionDecision,
  validateProject,
  validateRetryRequest,
  validateTaskContract,
} from './domain.js';
import { APPROVAL_DECISION } from './harness.js';
import { Observability } from './observability.js';
import { redactSecrets } from './security.js';
import { Scheduler } from './scheduler.js';
import { createSessionSurface, openSessionForRun } from './session-surface.js';
import { GitWorktreeManager } from './workspace.js';
import { PairedExecutionPort } from './execution-port.js';
import { createChangeViewerRegistry } from './change-viewer.js';
import { GitChangeInspectionService } from './change-inspection.js';
import { analyzeTask } from './task-analysis.js';
import { buildFinalizationReport } from './finalization.js';
import { createProjectId, detectProject } from './project.js';
import { pickFolder } from './folder-picker.js';
import { buildRuntimeHost } from './plugins/host.js';
import {
  assertHarnessConnectionExclusive,
  legacyDefaultModel,
  LEGACY_PLUGIN_IDS,
} from './plugins/legacy.js';
import {
  AGENT_ROLES,
  collectRoleSources,
  resolveAgentRoutes,
  routeSourceOf,
} from './plugins/role-routing.js';

const SERVICE_COMMANDS = new Set([
  'approve',
  'approve-run',
  'cleanup',
  'complete',
  'connections',
  'continue',
  'doctor',
  'events',
  'export',
  'finish-worker',
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
  'approve-step',
  'architecture',
  'brief',
  'changes',
  'create',
  'history',
  'inspect-changes',
  'finalization',
  'integrate',
  'mark-merged',
  'mark-released',
  'list',
  'message',
  'next-step',
  'open-changes',
  'result',
  'show',
  'thread',
  'usage',
]);
const PROJECT_COMMANDS = new Set(['add', 'browse', 'list', 'show']);
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

function readMarkdownTask(file, cwd) {
  const source = readFileSync(resolve(cwd, file), 'utf8').replace(/^\uFEFF/, '');
  const match = source.match(/^#\s+(.+?)\s*(?:\r?\n|$)/);

  if (!match) throw new Error('Markdown task must start with a level-one heading (# Title)');
  const description = source.slice(match[0].length).trim();

  if (!description) throw new Error('Markdown task description is required after the title');

  return { title: match[1].trim(), description };
}

function createTaskId() {
  return `CLEW-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
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

export class ClewService {
  constructor({
    cwd = process.cwd(),
    store,
    config,
    terminalManager = null,
    runnerGateway = null,
    editorLauncher = null,
    folderPicker = pickFolder,
  }) {
    this.cwd = resolve(cwd);
    this.store = store;
    this.config = config;
    this.terminalManager = terminalManager;
    this.runnerGateway = runnerGateway;
    this.editorLauncher = editorLauncher;
    this.folderPicker = folderPicker;
  }

  supports(args) {
    const [command, subcommand] = args;

    if (command === 'task') return TASK_COMMANDS.has(subcommand);
    if (command === 'project') return PROJECT_COMMANDS.has(subcommand);
    if (command === 'session') return SESSION_COMMANDS.has(subcommand);

    return SERVICE_COMMANDS.has(command);
  }

  async execute(args, { signal } = {}) {
    if (!this.supports(args)) throw new Error(`unsupported service command: ${args.join(' ')}`);
    const [command, subcommand, ...rest] = args;

    if (command === 'task') return this.task(subcommand, rest);
    if (command === 'project') return this.project(subcommand, rest);
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
    if (command === 'connections') return this.connections(subcommand, rest);
    if (command === 'finish-worker') return this.finishWorker(subcommand, rest);
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
    let task = this.store.getTask(taskId);

    if (!task) throw new Error(`task not found: ${taskId}`);
    const harnessApprovals = this.store.listHarnessApprovals(task.id);

    if (
      task.state === TASK_STATE.EXECUTING &&
      harnessApprovals.some((approval) => !approval.decision)
    ) {
      this.store.setTaskState(task.id, TASK_STATE.WAITING_FOR_HUMAN);
      task = this.store.getTask(task.id);
    }

    const runs = this.store.listRuns(task.id);
    const architectureEvent = this.store
      .listEvents(task.id)
      .filter((event) => event.type === 'ARCHITECTURE_RESULT_RECORDED')
      .at(-1);

    return {
      show: {
        ...task,
        plan: this.store.getLatestPlan(task.id),
        approvals: this.store.listApprovals(task.id),
        harnessApprovals,
        stages: this.store.listStages(task.id),
        runs: runs.map((run) => {
          const terminal = this.terminalManager?.describe(run.id);

          return {
            ...run,
            terminalActive: Boolean(terminal),
            terminalAvailable:
              Boolean(terminal) ||
              Boolean(
                run.status !== RUN_STATUS.RUNNING &&
                run.harness === 'codex' &&
                run.session_id &&
                run.workspace,
              ),
            terminalAccess:
              run.execution_mode === 'paired'
                ? 'runner_local'
                : Boolean(terminal) ||
                    Boolean(
                      run.status !== RUN_STATUS.RUNNING &&
                      run.harness === 'codex' &&
                      run.session_id &&
                      run.workspace,
                    )
                  ? 'controller_local'
                  : 'unavailable',
            interactionStatus: terminal?.interactionStatus ?? null,
            interactionTurnId: terminal?.interactionTurnId ?? null,
            lastAgentMessage: terminal?.lastAgentMessage ?? null,
            interactionUpdatedAt: terminal?.interactionUpdatedAt ?? null,
          };
        }),
        review: this.store.latestReview(task.id),
        completion: this.store.getCompletion(task.id),
        agentSessions: this.store.listAgentSessions(task.id),
        analysis: analyzeTask(task.contract),
        architecture: architectureEvent?.payload?.architecture ?? null,
        finalization: this.finalization(taskId),
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
      projects: this.store.listProjects(),
      tasks: this.store.listTasks().map((task) => this.taskSnapshot(task.id)),
    };
  }

  project(subcommand, args) {
    if (subcommand === 'browse')
      return Promise.resolve(this.folderPicker()).then((folder) => ({ folder }));
    if (subcommand === 'list') return this.store.listProjects();
    if (subcommand === 'show') {
      const id = args[0];

      if (!id) throw new Error('project id is required');
      const project = this.store.getProject(id);

      if (!project) throw new Error(`project not found: ${id}`);

      return project;
    }
    if (subcommand === 'add') {
      const folder = getOptionValue(args, '--path', args[0]);

      if (!folder) throw new Error('project folder is required');
      const detected = detectProject(folder);

      return this.store.createProject(
        validateProject({
          id: getOptionValue(args, '--id') || createProjectId(),
          name: getOptionValue(args, '--name', detected.name),
          localPath: detected.localPath,
          repositoryRoot: detected.repositoryRoot,
          defaultBranch: detected.defaultBranch,
        }),
      );
    }

    throw new Error(`unsupported project command: ${subcommand}`);
  }

  task(subcommand, args) {
    if (subcommand === 'create') return this.createTask(args);
    if (subcommand === 'next-step') return this.nextStep(args[0]);
    if (subcommand === 'open-changes') return this.openChanges(args[0], args);
    if (subcommand === 'changes' || subcommand === 'inspect-changes')
      return new GitChangeInspectionService(this.store).inspect(args[0]);
    if (subcommand === 'finalization') return this.finalization(args[0]);
    if (subcommand === 'integrate') return this.integrateTask(args[0], args);
    if (subcommand === 'mark-merged') return this.markTaskMerged(args[0], args);
    if (subcommand === 'mark-released') return this.markTaskReleased(args[0], args);
    if (subcommand === 'approve-step') return this.approveStep(args[0], args);
    if (subcommand === 'list') return this.store.listTasks();
    if (subcommand === 'show') return this.taskSnapshot(args[0]).show;
    if (subcommand === 'architecture') {
      return { taskId: args[0], architecture: this.taskSnapshot(args[0]).show.architecture };
    }
    if (subcommand === 'brief') {
      const taskId = args[0];

      if (!taskId) throw new Error('task id is required');
      const requestedRun = getOptionValue(args, '--run', null);
      const briefs = this.store
        .listEvents(taskId)
        .filter((event) => event.type === 'EXECUTION_BRIEF_PREPARED')
        .map((event) => event.payload)
        .filter((payload) => !requestedRun || payload.runId === requestedRun);
      const latest = briefs.at(-1);

      return {
        taskId,
        runId: requestedRun ?? latest?.runId ?? null,
        executionBrief: latest?.executionBrief ?? null,
      };
    }
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

  finalization(taskId) {
    if (!taskId) throw new Error('task id is required');
    const task = this.store.getTask(taskId);

    if (!task) throw new Error(`task not found: ${taskId}`);
    const manifest = this.store.getResultManifest(taskId);
    const run = [...this.store.listRuns(taskId)]
      .reverse()
      .find((item) => item.status === RUN_STATUS.COMPLETED && item.workspace && item.commit_sha);
    const changes = run
      ? new GitChangeInspectionService(this.store).inspect(run.id)
      : { version: 1, state: 'unavailable', reason: 'completed-run-unavailable', dirty: false };
    const policy = {
      ...(this.config.integration ?? {}),
      ...(task.contract.integration ?? {}),
      enabled:
        this.config.integration?.enabled !== false && task.contract.integration?.enabled === true,
    };
    const integration =
      policy.enabled && manifest.revision
        ? new GitWorktreeManager(resolve(this.cwd, this.config.worktreeRoot), this.cwd, {
            createRoot: false,
          }).inspectIntegration(manifest.revision, policy.targetBranch)
        : null;

    return buildFinalizationReport({
      task,
      manifest,
      run,
      changes,
      integration,
      policy,
    });
  }

  integrateTask(taskId, args) {
    const report = this.finalization(taskId);

    if (!report.git.enabled) throw new Error(`task ${taskId} does not use Git integration`);
    if (!report.ready && report.git.conflicts === true)
      return this.recordIntegrationAttention(taskId, report, new Error('merge conflict detected'));
    if (!report.ready)
      throw new Error(`task ${taskId} is not ready: ${report.blockingReasons.join('; ')}`);
    const strategy = getOptionValue(args, '--strategy', report.git.strategy);
    const message = getOptionValue(args, '--message', `Integrate ${taskId}`);
    const actor = getOptionValue(args, '--actor', process.env.USER || 'local-user');

    if (!['squash', 'merge', 'pr', 'human'].includes(strategy))
      throw new Error('--strategy must be squash, merge, pr, or human');
    if (strategy === 'pr' || strategy === 'human') {
      this.store.setTaskState(taskId, TASK_STATE.WAITING_FOR_HUMAN);
      this.store.appendEvent(taskId, 'INTEGRATION_HANDOFF_REQUIRED', {
        strategy,
        actor,
        revision: report.revision,
        targetBranch: report.git.targetBranch,
      });

      return { taskId, state: TASK_STATE.WAITING_FOR_HUMAN, strategy, action: 'mark-merged' };
    }
    const manager = new GitWorktreeManager(resolve(this.cwd, this.config.worktreeRoot), this.cwd);
    const sourceRevision = report.git.dirty
      ? manager.commitWorktreeChanges(report.workspace, message)
      : report.revision;

    if (report.git.dirty) this.store.finishRun(report.runId, RUN_STATUS.COMPLETED, sourceRevision);
    let result;

    try {
      result = manager.integrateRevision(sourceRevision, {
        targetBranch: report.git.targetBranch,
        strategy,
        message,
      });
    } catch (error) {
      return this.recordIntegrationAttention(taskId, report, error, sourceRevision);
    }
    this.store.setTaskState(taskId, TASK_STATE.MERGED);
    this.store.appendEvent(taskId, 'INTEGRATION_COMPLETED', { ...result, actor });
    let cleanup = { removed: false };

    if (report.git.cleanup) {
      try {
        manager.removeWorktree(report.workspace);
        cleanup = { removed: true, workspace: report.workspace };
        this.store.appendEvent(taskId, 'WORKTREE_CLEANED', cleanup);
      } catch (error) {
        cleanup = { removed: false, workspace: report.workspace, reason: error.message };
        this.store.appendEvent(taskId, 'WORKTREE_CLEANUP_FAILED', cleanup);
      }
    }

    return { taskId, state: TASK_STATE.MERGED, ...result, cleanup };
  }

  recordIntegrationAttention(taskId, report, error, sourceRevision = report.revision) {
    const stageId = 'integration-finalize';
    const runId = `run_${randomUUID()}`;
    const attempt = this.store.listRuns(taskId, { stageId }).length + 1;

    this.store.addStage(taskId, stageId, [], 'FAILED');
    this.store.createRun({
      id: runId,
      taskId,
      stageId,
      attempt,
      status: RUN_STATUS.FAILED,
      harness: 'git',
      workspace: this.cwd,
      commitSha: sourceRevision,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      profile: 'integration',
      policy: { strategy: report.git.strategy, targetBranch: report.git.targetBranch },
    });
    this.store.setTaskState(taskId, TASK_STATE.WAITING_FOR_HUMAN);
    this.store.appendEvent(taskId, 'INTEGRATION_CONFLICT', {
      runId,
      stageId,
      revision: sourceRevision,
      targetBranch: report.git.targetBranch,
      reason: error.message,
    });

    return {
      taskId,
      state: TASK_STATE.WAITING_FOR_HUMAN,
      runId,
      conflict: true,
      reason: error.message,
    };
  }

  markTaskMerged(taskId, args) {
    const task = this.store.getTask(taskId);
    const revision = getOptionValue(args, '--revision');
    const evidence = getOptionValue(args, '--evidence');

    if (!task) throw new Error(`task not found: ${taskId}`);
    if (task.state !== TASK_STATE.WAITING_FOR_HUMAN)
      throw new Error(`task ${taskId} is not waiting for integration`);
    const handoff = this.store
      .listEvents(taskId)
      .some((event) =>
        ['INTEGRATION_HANDOFF_REQUIRED', 'INTEGRATION_CONFLICT'].includes(event.type),
      );

    if (!handoff) throw new Error(`task ${taskId} has no pending integration handoff`);
    if (!revision || !evidence) throw new Error('--revision and --evidence are required');
    this.store.setTaskState(taskId, TASK_STATE.READY_TO_FINISH);
    this.store.setTaskState(taskId, TASK_STATE.MERGED);
    this.store.appendEvent(taskId, 'EXTERNAL_INTEGRATION_CONFIRMED', { revision, evidence });

    return { taskId, state: TASK_STATE.MERGED, revision, evidence };
  }

  markTaskReleased(taskId, args) {
    const task = this.store.getTask(taskId);
    const evidence = getOptionValue(args, '--evidence');

    if (!task) throw new Error(`task not found: ${taskId}`);
    if (task.state !== TASK_STATE.MERGED)
      throw new Error(`task ${taskId} must be MERGED before release`);
    if (!evidence) throw new Error('--evidence is required');
    this.store.setTaskState(taskId, TASK_STATE.RELEASED);
    this.store.appendEvent(taskId, 'RELEASE_CONFIRMED', { evidence });

    return { taskId, state: TASK_STATE.RELEASED, evidence };
  }

  openChanges(taskId, args = []) {
    if (!taskId) throw new Error('task id is required');
    const task = this.store.getTask(taskId);

    if (!task) throw new Error(`task not found: ${taskId}`);
    const runs = this.store.listRuns(taskId);
    const requestedRun = getOptionValue(args, '--run');
    const run = requestedRun
      ? runs.find((candidate) => candidate.id === requestedRun)
      : runs.at(-1);

    if (requestedRun && !run) throw new Error(`run not found: ${requestedRun}`);
    if (!run)
      return {
        version: 1,
        taskId,
        runId: null,
        state: 'unavailable',
        viewer: 'none',
        code: 'RUN_UNAVAILABLE',
        reason: 'task has no persisted run',
      };
    if (!run.workspace)
      return {
        version: 1,
        taskId,
        runId: run.id,
        state: 'unavailable',
        viewer: 'none',
        code: 'WORKSPACE_UNAVAILABLE',
        reason: run.execution_mode === 'paired' ? 'runner-local-unavailable' : 'missing-worktree',
      };
    const workspace = run.workspace;
    const explicit = getOptionValue(args, '--viewer', this.config.changeViewer);
    const result = createChangeViewerRegistry({ explicit, launcher: this.editorLauncher }).open({
      taskId,
      runId: run.id,
      workspace,
    });

    return { version: 1, taskId, runId: run.id, ...result };
  }

  createTask(args) {
    const jsonFile = getOptionValue(args, '--json');
    const legacyFile = getOptionValue(args, '--file');
    const markdownFile = getOptionValue(args, '--md');
    let input;

    if ([jsonFile, legacyFile, markdownFile].filter(Boolean).length > 1)
      throw new Error('use only one of --json, --file, or --md');
    if (markdownFile) input = readMarkdownTask(markdownFile, this.cwd);
    else if (jsonFile || legacyFile)
      input = JSON.parse(readFileSync(resolve(this.cwd, jsonFile ?? legacyFile), 'utf8'));
    else
      input = {
        id: getOptionValue(args, '--id'),
        projectId: getOptionValue(args, '--project'),
        title: getOptionValue(args, '--title'),
        description: getOptionValue(args, '--description'),
        goal: getOptionValue(args, '--goal'),
        profile: getOptionValue(args, '--profile', PROFILE_NAME.AUTO),
        tags: getOptionValues(args, '--tags'),
        risk: getOptionValue(args, '--risk', 'medium'),
        base_ref: getOptionValue(args, '--base', 'HEAD'),
        acceptance: getOptionValues(args, '--accept'),
        verification: getOptionValues(args, '--verify').map((command) => ({ command, args: [] })),
        integration: {
          enabled: args.includes('--git'),
          ...(getOptionValue(args, '--integration-strategy')
            ? { strategy: getOptionValue(args, '--integration-strategy') }
            : {}),
          ...(getOptionValue(args, '--target-branch')
            ? { targetBranch: getOptionValue(args, '--target-branch') }
            : {}),
        },
      };

    if (jsonFile) {
      const allowed = new Set([
        'id',
        'projectId',
        'title',
        'description',
        'goal',
        'profile',
        'tags',
        'risk',
        'base_ref',
        'acceptance',
        'verification',
        'integration',
      ]);
      const unknown = Object.keys(input).filter((key) => !allowed.has(key));

      if (unknown.length)
        throw new Error(`task input contains unknown field: ${unknown.join(', ')}`);
    }

    const description = input.description ?? input.goal;

    if (typeof input.title !== 'string' || !input.title.trim())
      throw new Error('task.title is required');
    if (typeof description !== 'string' || !description.trim())
      throw new Error('task.description is required');
    input = {
      ...input,
      id: getOptionValue(args, '--id', input.id) || createTaskId(),
      description: description.trim(),
      goal: description.trim(),
      profile: input.profile ?? PROFILE_NAME.AUTO,
      risk: input.risk ?? 'medium',
      base_ref: input.base_ref ?? 'HEAD',
      acceptance:
        Array.isArray(input.acceptance) && input.acceptance.length
          ? input.acceptance
          : [description.trim()],
    };
    delete input.attachments;
    const contract = validateTaskContract(input);
    const existing = this.store.getTask(contract.id);

    if (existing) {
      if (isDeepStrictEqual(existing.contract, contract)) return existing.contract;
      throw new Error(`task already exists with different input: ${contract.id}`);
    }

    if (contract.projectId && !this.store.getProject(contract.projectId))
      throw new Error(`project not found: ${contract.projectId}`);
    this.store.createTask(contract);

    return contract;
  }

  nextStep(taskId) {
    if (!taskId) throw new Error('task id is required');
    const task = this.store.getTask(taskId);

    if (!task) throw new Error(`task not found: ${taskId}`);
    const pending = this.store.latestWorkflowAction(taskId, 'start_worker');
    const analysis = analyzeTask(task.contract);

    if (pending?.status === 'PENDING') return pending;
    if (task.state !== TASK_STATE.DRAFT)
      return {
        taskId,
        currentStep: task.state,
        kind: 'none',
        summary: `No start action is available from ${task.state}`,
        approvalRequired: false,
      };
    const descriptor = {
      currentStep: TASK_STATE.DRAFT,
      resultingStep: TASK_STATE.EXECUTING,
      summary: `${analysis.recommendation.action === 'investigate' ? 'Investigate before implementation' : analysis.recommendation.action === 'plan' ? 'Plan before implementation' : analysis.recommendation.action === 'shape' ? 'Shape the task before implementation' : 'Start implementation'} with the ${analysis.recommendation.profile} profile`,
      inputs: {
        harness: 'codex',
        permissionMode: 'read-only',
        profile: analysis.recommendation.profile,
        ...(this.config.models?.worker ? { model: this.config.models.worker } : {}),
      },
      sideEffects: ['start one local worker process', 'create one run record'],
      approvalRequired: true,
      analysis,
    };

    return this.store.createWorkflowAction({
      id: `action_${randomUUID()}`,
      taskId,
      kind: 'start_worker',
      descriptor,
    });
  }

  async approveStep(taskId, args, signal) {
    if (!taskId) throw new Error('task id is required');
    const actionId = getOptionValue(args, '--action');
    const action = actionId ? this.store.getWorkflowAction(actionId) : this.nextStep(taskId);

    if (!action || action.taskId !== taskId)
      throw new Error('workflow action does not belong to task');
    if (action.kind !== 'start_worker')
      throw new Error(`unsupported workflow action: ${action.kind}`);
    const task = this.store.getTask(taskId);

    if (task.state !== TASK_STATE.DRAFT) throw new Error(`task ${taskId} is no longer a Draft`);
    const approved = this.store.approveWorkflowAction(
      action.id,
      getOptionValue(args, '--actor', process.env.USER || 'local-user'),
    );

    this.store.setTaskState(taskId, TASK_STATE.QUEUED);
    const runArgs = args.includes('--harness') ? args : [...args, '--harness', 'codex'];

    if (!args.includes('--profile') && action.inputs?.profile)
      runArgs.push('--profile', action.inputs.profile);

    if (!args.includes('--worker-model') && action.inputs?.model)
      runArgs.push('--worker-model', action.inputs.model);
    const result = await this.run(taskId, runArgs, signal, { readOnly: true });

    return { action: approved, result };
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

  /** Safe connection listing for CLI/UI (CLEW-130).
   *
   * Only the safe projection leaves the host: connection id, plugin,
   * enabled flag, and advertised capabilities. Connection configs,
   * binaries, endpoints, and credentials are never included.
   */
  connections(subcommand, _args) {
    if (subcommand && subcommand !== 'list') throw new Error('usage: clew connections list');

    const host = buildRuntimeHost(this.config, { terminalManager: this.terminalManager });

    return {
      connections: host.connections.map((entry) => {
        let capabilities;

        try {
          capabilities =
            host.resolver.resolve({ connectionId: entry.id }).describe()?.capabilities ?? [];
        } catch {
          capabilities = [];
        }

        return { id: entry.id, plugin: entry.plugin, enabled: entry.enabled, capabilities };
      }),
      diagnostics: host.diagnostics,
    };
  }

  async session(subcommand, args) {
    if (getOptionValue(args, '--connection'))
      throw new Error(
        'session open does not support --connection yet; terminal surfaces move to plugins in a later release (use --harness)',
      );
    if (subcommand === 'capabilities') {
      const harness = getOptionValue(args, '--harness', 'codex');

      return {
        version: 1,
        harness,
        capabilities: createSessionSurface({
          kind: getOptionValue(args, '--surface', 'plain'),
          codexBin: this.config.codexBin,
          trustedWorkspaceRoot: this.config.worktreeRoot,
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
      trustedWorkspaceRoot: this.config.worktreeRoot,
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
      resolveProfile(getOptionValue(args, '--profile', task.contract.profile), task.contract)
        .maxAttempts;

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
    this.assertRunFlagExclusivity(args);
    const { routes } = this.resolveRunRoutes(args, this.resolveCommandConfig(args));
    const result = await this.scheduler(args, signal).runTask(
      taskId,
      getOptionValue(args, '--profile', task.contract.profile),
      this.harnessSelectionFor(args, routes, 'worker', '--harness', null),
      this.harnessSelectionFor(args, routes, 'reviewer', '--review-harness', null),
      this.harnessSelectionFor(args, routes, 'architect', '--architect', null),
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

    this.assertRunFlagExclusivity(args);
    const { routes } = this.resolveRunRoutes(args, this.resolveCommandConfig(args));
    const result = await this.scheduler(args, signal).runTask(
      taskId,
      getOptionValue(args, '--profile', task.contract.profile),
      this.harnessSelectionFor(args, routes, 'worker', '--harness', latestRun?.harness),
      this.harnessSelectionFor(args, routes, 'reviewer', '--review-harness', null),
      this.harnessSelectionFor(args, routes, 'architect', '--architect', null),
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

    if (refreshedTask.contract.integration?.enabled === true)
      throw new Error(`task ${taskId} requires Git integration instead of completion`);
    if (
      ![TASK_STATE.READY, TASK_STATE.READY_TO_FINISH].includes(refreshedTask.state) &&
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
    let task = this.store.getTask(taskId);

    if (!task) throw new Error(`task not found: ${taskId}`);
    const harnessApprovals = this.store.listHarnessApprovals(task.id);

    if (
      task.state === TASK_STATE.EXECUTING &&
      harnessApprovals.some((approval) => !approval.decision)
    ) {
      this.store.setTaskState(task.id, TASK_STATE.WAITING_FOR_HUMAN);
      task = this.store.getTask(task.id);
    }

    return {
      id: task.id,
      state: task.state,
      plan: this.store.getLatestPlan(task.id),
      approvals: this.store.listApprovals(task.id),
      harnessApprovals,
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

  /** Probe one connection into a safe, secret-free doctor entry (CLEW-130). */
  async probeConnection(host, entry, { required }) {
    let adapter;

    try {
      adapter = host.resolver.resolve({ connectionId: entry.id });
    } catch (error) {
      const status =
        error?.code === 'PLUGIN_DISABLED'
          ? 'disabled'
          : error?.code === 'PLUGIN_UNKNOWN_ID'
            ? 'unconfigured'
            : error?.code === 'PLUGIN_INCOMPATIBLE_API' || error?.code === 'PLUGIN_INCOMPATIBLE'
              ? 'incompatible'
              : 'unavailable';

      return {
        name: `connection:${entry.id}`,
        ok: false,
        required,
        status,
        plugin: entry.plugin,
        capabilities: [],
        reason: error?.code ?? 'unavailable',
      };
    }

    const capabilities = adapter.describe()?.capabilities ?? [];
    let probe;

    try {
      probe = await adapter.probe();
    } catch (error) {
      probe = { status: 'unavailable', detail: error?.message ?? String(error) };
    }

    // Secret-safe projection: binary paths, endpoints, and raw auth output
    // never leave the host. Ready reports the version string; anything else
    // reports a reason code.
    const ready = probe?.status === 'ready';

    return {
      name: `connection:${entry.id}`,
      ok: ready,
      required,
      status: ready ? 'ready' : 'unavailable',
      plugin: entry.plugin,
      capabilities,
      ...(ready && typeof probe.version?.version === 'string'
        ? { version: probe.version.version }
        : {}),
      ...(!ready
        ? {
            reason:
              probe?.version?.ok === false
                ? 'binary-unavailable'
                : probe?.auth?.ok === false
                  ? 'auth-unavailable'
                  : 'probe-failed',
          }
        : {}),
    };
  }

  async doctor(args) {
    const requiredHarness = getOptionValue(args, '--harness');
    const selectedConnection = getOptionValue(args, '--connection');

    if (requiredHarness && !['codex', 'opencode'].includes(requiredHarness))
      throw new Error('--harness must be codex or opencode');

    assertHarnessConnectionExclusive({
      harness: requiredHarness ?? null,
      connection: selectedConnection ?? null,
    });

    const host = buildRuntimeHost(this.resolveCommandConfig(args), {
      terminalManager: this.terminalManager,
    });
    const entries = host.connections.filter(
      (entry) => !selectedConnection || entry.id === selectedConnection,
    );

    if (selectedConnection && entries.length === 0)
      throw new Error(`unknown connection "${selectedConnection}" on this execution host`);

    const requiredPlugin = requiredHarness ? LEGACY_PLUGIN_IDS[requiredHarness] : null;
    const telemetry = new Observability({
      cwd: this.cwd,
      config: { ...this.resolveCommandConfig(args).observability, enabled: true },
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
    ];

    for (const entry of entries)
      checks.push(
        await this.probeConnection(host, entry, {
          required: selectedConnection
            ? true
            : requiredPlugin
              ? entry.plugin === requiredPlugin
              : false,
        }),
      );

    return {
      ok: checks.filter((check) => check.required).every((check) => check.ok),
      checks,
      diagnostics: host.diagnostics,
    };
  }

  run(taskId, args, signal, options = {}) {
    if (!taskId) throw new Error('task id is required');

    this.assertRunFlagExclusivity(args);
    const { routes } = this.resolveRunRoutes(args, this.resolveCommandConfig(args));

    return this.scheduler(args, signal).runTask(
      taskId,
      getOptionValue(args, '--profile'),
      this.harnessSelectionFor(args, routes, 'worker', '--harness', null),
      this.harnessSelectionFor(args, routes, 'reviewer', '--review-harness', null),
      this.harnessSelectionFor(args, routes, 'architect', '--architect', null),
      null,
      [],
      options,
    );
  }

  finishWorker(taskId, args) {
    if (!taskId) throw new Error('task id is required');
    if (!this.terminalManager) throw new Error('interactive worker is owned by the daemon');
    const runId = getOptionValue(args, '--run') ?? this.store.listRuns(taskId).at(-1)?.id;
    const run = runId ? this.store.getRun(runId) : null;

    if (!run || run.task_id !== taskId) throw new Error('active worker run was not found');
    if (run.status !== RUN_STATUS.RUNNING) throw new Error('worker run is no longer active');
    if (!this.terminalManager.finish(run.id))
      throw new Error('interactive worker terminal is unavailable');

    return { taskId, runId: run.id, status: 'FINISHING' };
  }

  /** Flag-level exclusivity before route validation (CLEW-130).
   *
   * Runs before `resolveRunRoutes` so `--harness X --connection Y` fails
   * with the actionable conflict error even when `Y` is otherwise unknown.
   */
  assertRunFlagExclusivity(args) {
    const getFlag = (name) => getOptionValue(args, name);
    const { sources } = collectRoleSources({
      getFlag,
      config: this.config,
      env: process.env,
    });

    for (const [role, flag] of [
      ['worker', '--harness'],
      ['reviewer', '--review-harness'],
      ['architect', '--architect'],
    ]) {
      const explicit = getFlag(flag);

      if (explicit == null) continue;

      const { level, connection } = routeSourceOf(sources[role]);

      if (level !== 'default') assertHarnessConnectionExclusive({ harness: explicit, connection });
    }
  }

  /** Resolve `role → connection → model` for every agent role (CLEW-130).
   *
   * Precedence per role: run/stage flag → environment → project → user →
   * defaults. Applies the legacy reviewer default on Codex connections and
   * returns the host so callers reuse one resolver per command.
   */
  resolveRunRoutes(args, runtimeConfig = this.config) {
    const getFlag = (name) => getOptionValue(args, name);
    const host = buildRuntimeHost(runtimeConfig, { terminalManager: this.terminalManager });
    const allowedConnections = host.connections.map((entry) => entry.id);
    const { sources, diagnostics } = collectRoleSources({
      getFlag,
      config: this.config,
      env: process.env,
    });
    const routes = resolveAgentRoutes({ sources, options: { allowedConnections } });

    for (const role of AGENT_ROLES) {
      if (routes[role].model == null) {
        const plugin = host.resolver.describeConnection(routes[role].connection).plugin;

        routes[role].model = legacyDefaultModel(role, plugin);
      }
    }

    return { host, routes, diagnostics };
  }

  /** Select a legacy harness name for a role, honoring the connection routes.
   *
   * An explicit `--harness`-style flag combined with any non-default route
   * source is an explicit error; otherwise the flag wins, a default route
   * falls back to `fallback`, and a routed role returns null (the
   * connection id in `adapterConfig` drives resolution).
   */
  harnessSelectionFor(args, routes, role, flagName, fallback = null) {
    const explicit = getOptionValue(args, flagName);

    if (explicit != null && routes[role].source !== 'default')
      assertHarnessConnectionExclusive({ harness: explicit, connection: routes[role].connection });

    return explicit ?? (routes[role].source === 'default' ? fallback : null);
  }

  scheduler(args, signal) {
    const runtimeConfig = this.resolveCommandConfig(args);
    const manager = new GitWorktreeManager(runtimeConfig.worktreeRoot, this.cwd);
    const executionMode = getOptionValue(args, '--execution', 'local');
    let executionPort = null;

    if (executionMode === 'paired') {
      const runner = this.store.getRunnerProjection();

      if (!this.runnerGateway || !runner)
        throw new Error('paired execution requires a configured, registered Runner gateway');
      executionPort = new PairedExecutionPort({
        store: this.store,
        transport: this.runnerGateway,
        runnerId: runner.runnerId,
      });
    } else if (executionMode !== 'local')
      throw new Error(`unsupported execution mode: ${executionMode}`);

    const { host, routes } = this.resolveRunRoutes(args, runtimeConfig);

    return new Scheduler(this.store, manager, {
      signal,
      adapterConfig: {
        ...runtimeConfig,
        models: {
          ...runtimeConfig.models,
          worker: routes.worker.model,
          architect: routes.architect.model,
          reviewer: routes.reviewer.model,
          qa: routes.qa.model,
        },
        connection: routes.worker.source === 'default' ? null : routes.worker.connection,
        reviewConnection: routes.reviewer.source === 'default' ? null : routes.reviewer.connection,
        architectConnection:
          routes.architect.source === 'default' ? null : routes.architect.connection,
      },
      runtimeResolver: host.resolver,
      executionPort,
    });
  }

  resolveCommandConfig(args) {
    return {
      ...this.config,
      codexBin: getOptionValue(args, '--codex-bin', this.config.codexBin),
      openCodeBin: getOptionValue(args, '--opencode-bin', this.config.openCodeBin),
      openCodeUrl: getOptionValue(args, '--opencode-url', this.config.openCodeUrl),
      models: {
        ...this.config.models,
        worker: getOptionValue(args, '--worker-model', this.config.models?.worker),
      },
      worktreeRoot: resolve(
        this.cwd,
        getOptionValue(args, '--worktree-root', this.config.worktreeRoot),
      ),
    };
  }
}
