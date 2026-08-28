import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { URL } from 'node:url';
import {
  isSupportedVersion,
  SUPPORTED_CODEX_CLI_VERSION,
  SUPPORTED_OPENCODE_CLI_VERSION,
} from './compatibility.js';
import {
  validateTaskContract,
  PROFILE_NAME,
  PLAN_STATUS,
  TASK_STATE,
  RUN_STATUS,
  OPERATOR_ACTION,
  resolveProfile,
  validateRetryRequest,
  validateCompletionDecision,
} from './domain.js';
import { APPROVAL_DECISION } from './harness.js';
import { Store } from './store.js';
import { GitWorktreeManager } from './workspace.js';
import { Scheduler } from './scheduler.js';
import { loadConfig } from './config.js';
import { redactSecrets } from './security.js';
import { createHash } from 'node:crypto';
import { Observability, telemetryInstall } from './observability.js';
import { LocalDaemon, daemonRequest, readDaemonMetadata, stopDaemon } from './daemon.js';

const cwd = process.cwd();
const stateDir = join(cwd, '.clew');
const dbFile = join(stateDir, 'clew.sqlite');
const config = loadConfig(cwd);
const createStore = () => new Store(dbFile);
const packageVersion = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
const TERMINAL_TASK_STATES = Object.freeze([
  TASK_STATE.READY,
  TASK_STATE.COMPLETED,
  TASK_STATE.FAILED,
  TASK_STATE.CANCELLED,
  TASK_STATE.BLOCKED,
]);

function getOptionValue(args, name, fallback = undefined) {
  const index = args.indexOf(name);

  return index >= 0 ? args[index + 1] : fallback;
}
function getOptionValues(args, name) {
  const values = [];

  for (let index = 0; index < args.length; index++)
    if (args[index] === name && args[index + 1]) values.push(args[index + 1]);

  return values;
}
function printJson(data) {
  console.log(JSON.stringify(data, null, 2));
}
function printResult(result, args) {
  if (!args.includes('--human')) return printJson(result);
  console.log(`Task: ${result.taskId}`);
  console.log(`State: ${result.state}`);
  console.log(`Revision: ${result.revision ?? 'not available'}`);
  console.log(`Attempts: ${result.attempts.length}`);
  console.log(`Evidence: ${result.evidence.length} item(s)`);
  console.log(`Acceptance coverage: ${result.evidenceCoverage.join(', ') || 'none'}`);
  console.log(`Workspace: ${result.workspace ?? 'not available'}`);
  console.log(
    `Usage: ${result.usage?.status ?? 'unknown'} ${JSON.stringify(result.usage?.total ?? {})}`,
  );
}
function printHumanHistory(history) {
  console.log(`Task: ${history.taskId}`);
  console.log(`Stages: ${history.stages.length}`);
  console.log(`Runs: ${history.runs.length}`);
  console.log(`Operator actions: ${history.actions.length}`);
  console.log(`Events: ${history.events.length}`);
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
function printHelp() {
  console.log(
    `Clew v${packageVersion}\n\nCommands:\n  clew init\n  clew task create --id ID --title TITLE --goal GOAL --accept TEXT [--profile quick|standard|deep]\n  clew task create --file contract.json\n  clew task list | show ID | result ID\n  clew task history ID [--stage STAGE] [--attempt N]\n  clew plan ID\n  clew approve ID [gate-id]\n  clew reject ID [gate-id] [--reason TEXT]\n  clew approve-run APPROVAL-ID [--actor ACTOR]\n  clew reject-run APPROVAL-ID [--actor ACTOR]\n  clew interrupt ID [--actor ACTOR]\n  clew retry TASK [STAGE] [--actor ACTOR] [--reason TEXT]\n  clew verify TASK --revision SHA [--stage STAGE] [--actor ACTOR]\n  clew worktree list | remove PATH [--force] | prune\n  clew run ID [--profile PROFILE] [--harness fake|codex|opencode] [--review-harness fake|codex] [--architect fake|codex]\n  clew status ID [--watch] [--interval MS]\n  clew events ID\n  clew doctor [--harness codex|opencode]`,
  );
  console.log('  clew complete TASK --revision SHA [--actor ACTOR]');
  console.log('  clew export TASK --dir DIR [--revision SHA]');
  console.log('  clew cleanup [--retention-days N]');
  console.log('  clew telemetry install | status');
  console.log('  clew pricing sync [--source NAME] [--url URL] [--provider NAME]');
  console.log('  clew daemon start [--port PORT] | status | stop');
  console.log('  clew api task list|show ID|...');
}

export async function main(args) {
  const [command, subcommand, ...rest] = args;

  if (!command || command === '--help' || command === '-h') return printHelp();
  if (command === 'daemon') {
    if (subcommand === 'status') return printJson(readDaemonMetadata(cwd));
    if (subcommand === 'stop') return printJson(await stopDaemon(cwd));
    if (subcommand === 'start') {
      const daemon = new LocalDaemon({ cwd, port: Number(getOptionValue(rest, '--port', 0)) });
      const metadata = await daemon.start();

      printJson(metadata);
      const shutdown = () => daemon.stop().finally(() => process.exit(0));

      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
      await new Promise(() => {});
    }
    throw new Error('usage: clew daemon start|status|stop');
  }
  if (command === 'api')
    return printJson(await daemonRequest(cwd, [subcommand, ...rest].filter(Boolean)));
  if (command === 'init') {
    mkdirSync(stateDir, { recursive: true });
    const store = createStore();

    store.close();
    console.log(`Initialized ${stateDir}`);

    return;
  }
  if (command === 'telemetry' && subcommand === 'install') {
    return printJson(telemetryInstall({ cwd }));
  }
  if (command === 'telemetry' && subcommand === 'status') {
    const observability = new Observability({ cwd, config: config.observability });

    printJson(observability.status());
    await observability.shutdown();

    return;
  }
  const store = createStore();
  const observability = new Observability({
    cwd,
    config: resolveCommandConfig(config, args).observability,
    store,
  });

  store.setEventObserver(observability);

  try {
    if (command === 'task' && subcommand === 'create') {
      let contract;
      const file = getOptionValue(rest, '--file');

      if (file) contract = JSON.parse(readFileSync(resolve(file), 'utf8'));
      else
        contract = {
          id: getOptionValue(rest, '--id'),
          title: getOptionValue(rest, '--title'),
          goal: getOptionValue(rest, '--goal'),
          profile: getOptionValue(rest, '--profile', PROFILE_NAME.QUICK),
          risk: getOptionValue(rest, '--risk', 'medium'),
          base_ref: getOptionValue(rest, '--base', 'HEAD'),
          acceptance: getOptionValues(rest, '--accept'),
          verification: getOptionValues(rest, '--verify').map((command) => ({ command, args: [] })),
        };
      contract = validateTaskContract(contract);
      store.createTask(contract);
      if (rest.includes('--json')) printJson(contract);
      else console.log(`Created task ${contract.id}`);

      return;
    }
    if (command === 'task' && subcommand === 'list') return printJson(store.listTasks());
    if (command === 'task' && subcommand === 'show') {
      const task = store.getTask(rest[0]);

      if (!task) throw new Error(`task not found: ${rest[0]}`);

      return printJson({
        ...task,
        plan: store.getLatestPlan(task.id),
        approvals: store.listApprovals(task.id),
        harnessApprovals: store.listHarnessApprovals(task.id),
        stages: store.listStages(task.id),
        runs: store.listRuns(task.id),
      });
    }
    if (command === 'task' && subcommand === 'result') {
      store.evaluateTaskTrust(rest[0]);

      return printResult(store.getResultManifest(rest[0]), rest);
    }
    if (command === 'task' && subcommand === 'usage') {
      const taskId = rest[0];

      if (!taskId) throw new Error('task id is required');
      const attemptValue = getOptionValue(rest, '--attempt');
      const attempt = attemptValue === undefined ? null : Number(attemptValue);

      if (attempt !== null && (!Number.isInteger(attempt) || attempt < 1))
        throw new Error('--attempt must be a positive integer');
      store.refreshUsageCosts(taskId);
      const filters = { stageId: getOptionValue(rest, '--stage', null), attempt };
      const summary = store.getUsageSummary(taskId, filters);

      if (rest.includes('--human')) {
        console.log(
          `Task: ${taskId}\nStatus: ${summary.status}\nTurns: ${summary.turns}\nPriced: ${summary.pricedTurns}\nTotal: ${JSON.stringify(summary.total)}`,
        );

        return;
      }

      return printJson({ taskId, ...summary, records: store.listUsage(taskId, filters) });
    }
    if (command === 'task' && subcommand === 'history') {
      const taskId = rest[0];

      if (!taskId) throw new Error('task id is required');
      const attemptValue = getOptionValue(rest, '--attempt');
      const attempt = attemptValue === undefined ? null : Number(attemptValue);

      if (attempt !== null && (!Number.isInteger(attempt) || attempt < 1))
        throw new Error('--attempt must be a positive integer');

      const history = {
        taskId,
        stages: store.listStages(taskId),
        runs: store.listRuns(taskId, {
          stageId: getOptionValue(rest, '--stage', null),
          attempt,
        }),
        actions: store.listOperatorActions(taskId),
        events: store.listEvents(taskId),
      };

      return rest.includes('--human') ? printHumanHistory(history) : printJson(history);
    }
    if (command === 'plan') {
      const plan = store.getLatestPlan(subcommand);

      if (!plan) throw new Error(`plan not found for task ${subcommand}`);

      return printJson({ ...plan, approvals: store.listApprovals(subcommand) });
    }
    if (command === 'pricing' && subcommand === 'sync') {
      const url = getOptionValue(rest, '--url');
      const source = getOptionValue(rest, '--source', 'configured');
      const provider = getOptionValue(rest, '--provider', null);
      const sources = url ? [{ source, provider, url }] : (config.pricing?.sources ?? []);

      if (!sources.length)
        throw new Error(
          'no pricing sources configured; pass --url URL or configure pricing.sources',
        );
      const synced = [];

      for (const item of sources) {
        const response = await fetch(item.url);

        if (!response.ok)
          throw new Error(
            `pricing source ${item.source ?? item.url} failed: HTTP ${response.status}`,
          );
        const body = await response.json();

        synced.push(
          store.recordPricingSnapshot({
            source: item.source ?? item.url,
            provider: item.provider ?? provider,
            currency: body.currency ?? item.currency ?? 'USD',
            catalog: body.catalog ?? body.prices ?? body,
          }),
        );
      }

      return printJson({ synced, count: synced.length });
    }
    if (command === 'approve' || command === 'reject') {
      const id = subcommand;

      if (!id) throw new Error('task id is required');
      const positionalGate = rest[0] && !rest[0].startsWith('--') ? rest[0] : undefined;
      const decision = command === 'approve' ? PLAN_STATUS.APPROVED : PLAN_STATUS.REJECTED;
      const result = store.decideLatestPlan(id, decision, {
        gateId: positionalGate || 'deep-plan',
        actor: getOptionValue(rest, '--actor', process.env.USER || 'local-user'),
        reason: getOptionValue(rest, '--reason'),
      });

      return printJson(result);
    }
    if (command === 'approve-run' || command === 'reject-run') {
      const approvalId = subcommand;

      if (!approvalId) throw new Error('harness approval id is required');
      const decision =
        command === 'approve-run' ? APPROVAL_DECISION.ACCEPT : APPROVAL_DECISION.DECLINE;

      return printJson(
        store.decideHarnessApproval(
          approvalId,
          decision,
          getOptionValue(rest, '--actor', process.env.USER || 'local-user'),
        ),
      );
    }
    if (command === 'interrupt') {
      const id = subcommand;

      if (!id) throw new Error('task id is required');
      const task = store.getTask(id);

      if (!task) throw new Error(`task not found: ${id}`);
      if ([TASK_STATE.COMPLETED, TASK_STATE.CANCELLED].includes(task.state))
        throw new Error(`task ${id} is already ${task.state}`);

      return printJson(
        store.requestInterrupt(
          id,
          getOptionValue(rest, '--actor', process.env.USER || 'local-user'),
        ),
      );
    }
    if (command === 'retry') {
      const taskId = subcommand;
      const stageId = rest[0] && !rest[0].startsWith('--') ? rest[0] : 'worker';
      const actor = getOptionValue(rest, '--actor', process.env.USER || 'local-user');
      const reason = getOptionValue(rest, '--reason');
      const task = store.getTask(taskId);

      if (!task) throw new Error(`task not found: ${taskId}`);
      if (![TASK_STATE.READY, TASK_STATE.FAILED, TASK_STATE.BLOCKED].includes(task.state))
        throw new Error(`task ${taskId} cannot be retried from ${task.state}`);
      if (!store.listStages(taskId).some((stage) => stage.id === stageId))
        throw new Error(`stage not found: ${stageId}`);
      const previousRuns = store.listRuns(taskId, { stageId });
      const maxAttempts =
        previousRuns.at(-1)?.policy?.maxAttempts ??
        resolveProfile(getOptionValue(rest, '--profile', task.contract.profile)).maxAttempts;

      if (previousRuns.length >= maxAttempts)
        throw new Error(
          `retry policy exhausted for ${taskId}: ${previousRuns.length}/${maxAttempts}`,
        );
      const request = validateRetryRequest({ taskId, stageId, actor, reason });
      const action = store.recordOperatorAction({
        taskId,
        action: OPERATOR_ACTION.RETRY,
        stageId,
        actor,
        reason: request.reason,
      });

      store.setStage(taskId, stageId, 'QUEUED');
      store.setTaskState(taskId, TASK_STATE.QUEUED);
      const runtimeConfig = resolveCommandConfig(config, rest);
      const manager = new GitWorktreeManager(runtimeConfig.worktreeRoot);
      const result = await new Scheduler(store, manager, { adapterConfig: runtimeConfig }).runTask(
        taskId,
        getOptionValue(rest, '--profile', task.contract.profile),
        getOptionValue(rest, '--harness'),
        getOptionValue(rest, '--review-harness'),
        getOptionValue(rest, '--architect'),
        previousRuns.length === 1 ? previousRuns.at(-1).session_id : null,
      );

      return printJson({ action, result });
    }
    if (command === 'verify') {
      const taskId = subcommand;
      const revision = getOptionValue(rest, '--revision');
      const stageId = getOptionValue(rest, '--stage', 'worker');
      const actor = getOptionValue(rest, '--actor', process.env.USER || 'local-user');
      const task = store.getTask(taskId);

      if (!taskId) throw new Error('task id is required');
      if (!revision) throw new Error('--revision is required');
      if (!task) throw new Error(`task not found: ${taskId}`);
      const commands = getOptionValues(rest, '--command').map((command) => ({ command, args: [] }));
      const configured = commands.length ? commands : (task.contract.verification ?? []);
      const previous = store.latestVerification(taskId, stageId)?.evidence ?? [];
      const checks = configured.length
        ? configured
        : previous.filter((item) => item.type === 'command' && item.command);

      if (!checks.length)
        throw new Error('no verification commands configured; pass --command COMMAND');
      const run = store
        .listRuns(taskId, { stageId })
        .reverse()
        .find((item) => item.commit_sha === revision);

      if (!run) throw new Error(`revision ${revision} is not a known ${stageId} run revision`);
      const evidence = checks.map((check) => executeVerification(check, run?.workspace));
      const report = store.recordVerification({ taskId, stageId, revision, actor, evidence });

      if (evidence.some((item) => item.result !== 'passed')) {
        const error = new Error('verification command failed');

        error.code = 'VERIFICATION_FAILED';
        throw error;
      }

      return printJson(report);
    }
    if (command === 'complete') {
      const taskId = subcommand;
      const revision = getOptionValue(rest, '--revision');
      const actor = getOptionValue(rest, '--actor', process.env.USER || 'local-user');
      const task = store.getTask(taskId);

      if (!task) throw new Error(`task not found: ${taskId}`);
      if (!revision) throw new Error('--revision is required');
      store.evaluateTaskTrust(taskId, { revision });
      const refreshedTask = store.getTask(taskId);

      if (refreshedTask.state !== TASK_STATE.READY)
        throw new Error(`task ${taskId} must be READY before completion`);
      const manifest = store.getResultManifest(taskId);
      const latestRevision = manifest?.revision ?? store.listRuns(taskId).at(-1)?.commit_sha;

      if (latestRevision !== revision)
        throw new Error('completion revision does not match current READY revision');
      const trust = store.evaluateTaskTrust(taskId, { revision });

      if (!trust.reusable) throw new Error('READY evidence is stale or untrusted');

      return printJson(
        store.recordCompletion(
          validateCompletionDecision({
            taskId,
            expectedRevision: revision,
            actor,
            note: getOptionValue(rest, '--note'),
          }),
          manifest,
        ),
      );
    }
    if (command === 'export') {
      const taskId = subcommand;
      const outputDir = getOptionValue(rest, '--dir');

      if (!outputDir) throw new Error('--dir is required');
      const manifest = store.getResultManifest(taskId);

      if (!manifest) throw new Error('result manifest is not available');
      const revision = getOptionValue(rest, '--revision', manifest.revision);

      if (revision !== manifest.revision)
        throw new Error('export revision does not match result manifest');
      const base = store.getTask(taskId).contract.base_ref;
      const target = resolve(outputDir);
      const primaryCheckout = resolve(cwd);

      if (target === primaryCheckout || target.startsWith(`${primaryCheckout}/`))
        throw new Error('refusing export inside the primary checkout');

      if (execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim())
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
        execFileSync('git', ['diff', `${base}..${revision}`], { cwd, encoding: 'utf8' }),
      );
      execFileSync('git', ['bundle', 'create', join(target, `${taskId}.bundle`), base, revision], {
        cwd,
        stdio: 'pipe',
      });
      store.appendEvent(taskId, 'RESULT_EXPORTED', { outputDir: target, revision, checksum });

      return printJson({ taskId, outputDir: target, revision, checksum });
    }
    if (command === 'cleanup') {
      const retentionDays = Number(getOptionValue(rest, '--retention-days', 0));

      if (!Number.isFinite(retentionDays) || retentionDays < 0)
        throw new Error('--retention-days must be a non-negative number');
      const manager = new GitWorktreeManager(resolveCommandConfig(config, rest).worktreeRoot);
      const removed = [];
      const skipped = [];

      for (const task of store.listTasks()) {
        const completion = store.getCompletion(task.id);
        const events = store.listEvents(task.id);
        const runs = store.listRuns(task.id).filter((run) => run.workspace);
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
          store.appendEvent(task.id, 'WORKTREES_CLEANED', {
            paths: runs.map((run) => run.workspace),
          });
      }

      return printJson({ removed, skipped });
    }
    if (command === 'run') {
      const id = subcommand;

      if (!id) throw new Error('task id is required');
      const runtimeConfig = resolveCommandConfig(config, rest);
      const manager = new GitWorktreeManager(runtimeConfig.worktreeRoot);
      const controller = new AbortController();
      const interrupt = () => controller.abort();

      process.once('SIGINT', interrupt);
      process.once('SIGTERM', interrupt);
      let result;

      try {
        result = await new Scheduler(store, manager, {
          signal: controller.signal,
          adapterConfig: runtimeConfig,
        }).runTask(
          id,
          getOptionValue(rest, '--profile'),
          getOptionValue(rest, '--harness'),
          getOptionValue(rest, '--review-harness'),
          getOptionValue(rest, '--architect'),
        );
      } finally {
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', interrupt);
      }

      return printJson(result);
    }
    if (command === 'status') {
      const showStatus = () => {
        const task = store.getTask(subcommand);

        if (!task) throw new Error(`task not found: ${subcommand}`);
        printJson({
          id: task.id,
          state: task.state,
          plan: store.getLatestPlan(task.id),
          approvals: store.listApprovals(task.id),
          harnessApprovals: store.listHarnessApprovals(task.id),
          stages: store.listStages(task.id),
          runs: store.listRuns(task.id),
        });

        return task.state;
      };
      let state = showStatus();

      if (!rest.includes('--watch')) return;
      const intervalMs = Number(getOptionValue(rest, '--interval', 1_000));

      if (!Number.isFinite(intervalMs) || intervalMs < 50)
        throw new Error('--interval must be at least 50 milliseconds');
      while (!TERMINAL_TASK_STATES.includes(state)) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs));
        state = showStatus();
      }

      return;
    }
    if (command === 'events') return printJson(store.listEvents(subcommand));
    if (command === 'worktree') {
      const runtimeConfig = resolveCommandConfig(config, rest);
      const manager = new GitWorktreeManager(runtimeConfig.worktreeRoot);

      if (subcommand === 'list') return printJson(manager.listWorktrees());
      if (subcommand === 'remove') {
        const path = rest[0];

        if (!path) throw new Error('worktree path is required');
        manager.removeWorktree(resolve(path), { force: rest.includes('--force') });

        return printJson({ removed: resolve(path) });
      }
      if (subcommand === 'prune') {
        const activeWorkspaces = store
          .listAllRuns()
          .filter((run) => run.status === RUN_STATUS.RUNNING && run.workspace)
          .map((run) => run.workspace);

        return printJson(manager.pruneWorktrees({ protectedPaths: activeWorkspaces }));
      }
    }
    if (command === 'doctor') {
      const doctorArgs = [subcommand, ...rest].filter(Boolean);
      const requiredHarness = getOptionValue(doctorArgs, '--harness');
      const runtimeConfig = resolveCommandConfig(config, doctorArgs);

      if (requiredHarness && !['codex', 'opencode'].includes(requiredHarness))
        throw new Error('--harness must be codex or opencode');
      const codexCommand = runtimeConfig.codexBin;
      const openCodeCommand = runtimeConfig.openCodeBin;
      const openCodeUrl = runtimeConfig.openCodeUrl;
      const codexVersion = probeCommand(codexCommand, ['--version']);
      const codexAuth = codexVersion.ok
        ? probeCommand(codexCommand, ['login', 'status'])
        : { ok: false, detail: 'Codex CLI unavailable' };
      const openCodeVersion = probeCommand(openCodeCommand, ['--version']);
      const telemetry = new Observability({
        cwd,
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
        {
          name: 'git',
          ...probeCommand('git', ['--version']),
          required: true,
        },
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
          command: codexCommand,
        },
        {
          name: 'codex-auth',
          ...codexAuth,
          required: requiredHarness === 'codex',
        },
        {
          name: 'opencode-cli',
          ...withVersionCompatibility(openCodeVersion, SUPPORTED_OPENCODE_CLI_VERSION),
          required: requiredHarness === 'opencode',
          command: openCodeCommand,
        },
        {
          name: 'opencode-endpoint',
          ...(await probeOpenCodeEndpoint(openCodeUrl)),
          required: requiredHarness === 'opencode',
          url: openCodeUrl,
        },
      ];

      return printJson({
        ok: checks.filter((check) => check.required).every((check) => check.ok),
        checks,
      });
    }

    return printHelp();
  } finally {
    await observability.shutdown();
    store.close();
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
function probeCommand(command, args) {
  try {
    const detail = execFileSync(command, args, { encoding: 'utf8', timeout: 2_000 }).trim();

    return { ok: true, detail: redactSecrets(detail) };
  } catch (error) {
    return { ok: false, detail: error.code === 'ENOENT' ? 'not found' : 'unavailable' };
  }
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
    const healthUrl = new URL('/global/health', url);
    const response = await fetch(healthUrl, {
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

function resolveCommandConfig(baseConfig, args) {
  return {
    ...baseConfig,
    codexBin: getOptionValue(args, '--codex-bin', baseConfig.codexBin),
    openCodeBin: getOptionValue(args, '--opencode-bin', baseConfig.openCodeBin),
    openCodeUrl: getOptionValue(args, '--opencode-url', baseConfig.openCodeUrl),
    worktreeRoot: resolve(getOptionValue(args, '--worktree-root', baseConfig.worktreeRoot)),
  };
}
