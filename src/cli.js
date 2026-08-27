import { readFileSync, mkdirSync } from 'node:fs';
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
} from './domain.js';
import { APPROVAL_DECISION } from './harness.js';
import { Store } from './store.js';
import { GitWorktreeManager } from './workspace.js';
import { Scheduler } from './scheduler.js';
import { loadConfig } from './config.js';
import { redactSecrets } from './security.js';

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
function printHelp() {
  console.log(
    `Clew v${packageVersion}\n\nCommands:\n  clew init\n  clew task create --id ID --title TITLE --goal GOAL --accept TEXT [--profile quick|standard|deep]\n  clew task create --file contract.json\n  clew task list | show ID\n  clew plan ID\n  clew approve ID [gate-id]\n  clew reject ID [gate-id] [--reason TEXT]\n  clew approve-run APPROVAL-ID [--actor ACTOR]\n  clew reject-run APPROVAL-ID [--actor ACTOR]\n  clew interrupt ID [--actor ACTOR]\n  clew worktree list | remove PATH [--force] | prune\n  clew run ID [--profile PROFILE] [--harness fake|codex|opencode] [--review-harness fake|codex] [--architect fake|codex]\n  clew status ID [--watch] [--interval MS]\n  clew events ID\n  clew doctor [--harness codex|opencode]`,
  );
}

export async function main(args) {
  const [command, subcommand, ...rest] = args;

  if (!command || command === '--help' || command === '-h') return printHelp();
  if (command === 'init') {
    mkdirSync(stateDir, { recursive: true });
    const store = createStore();

    store.close();
    console.log(`Initialized ${stateDir}`);

    return;
  }
  const store = createStore();

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
    if (command === 'plan') {
      const plan = store.getLatestPlan(subcommand);

      if (!plan) throw new Error(`plan not found for task ${subcommand}`);

      return printJson({ ...plan, approvals: store.listApprovals(subcommand) });
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
