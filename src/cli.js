import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateTaskContract, PROFILE_NAME, PLAN_STATUS, TASK_STATE } from './domain.js';
import { Store } from './store.js';
import { GitWorktreeManager } from './workspace.js';
import { Scheduler } from './scheduler.js';

const cwd = process.cwd();
const stateDir = join(cwd, '.clew');
const dbFile = join(stateDir, 'clew.sqlite');
const createStore = () => new Store(dbFile);

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
    `Clew v0.1.0-alpha.3\n\nCommands:\n  clew init\n  clew task create --id ID --title TITLE --goal GOAL --accept TEXT [--profile quick|standard|deep]\n  clew task create --file contract.json\n  clew task list | show ID\n  clew plan ID\n  clew approve ID [gate-id]\n  clew reject ID [gate-id] [--reason TEXT]\n  clew interrupt ID [--actor ACTOR]\n  clew run ID [--profile PROFILE] [--harness fake|codex|opencode] [--architect fake|codex]\n  clew status ID\n  clew events ID\n  clew doctor`,
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
      console.log(`Created task ${contract.id}`);

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
      const manager = new GitWorktreeManager(join(stateDir, 'worktrees'));
      const controller = new AbortController();
      const interrupt = () => controller.abort();

      process.once('SIGINT', interrupt);
      let result;

      try {
        result = await new Scheduler(store, manager, { signal: controller.signal }).runTask(
          id,
          getOptionValue(rest, '--profile'),
          getOptionValue(rest, '--harness'),
          getOptionValue(rest, '--review-harness'),
          getOptionValue(rest, '--architect'),
        );
      } finally {
        process.removeListener('SIGINT', interrupt);
      }

      return printJson(result);
    }
    if (command === 'status') {
      const task = store.getTask(subcommand);

      if (!task) throw new Error(`task not found: ${subcommand}`);

      return printJson({
        id: task.id,
        state: task.state,
        plan: store.getLatestPlan(task.id),
        approvals: store.listApprovals(task.id),
        stages: store.listStages(task.id),
        runs: store.listRuns(task.id),
      });
    }
    if (command === 'events') return printJson(store.listEvents(subcommand));
    if (command === 'doctor') {
      const checks = [
        { name: 'node', ok: Number(process.versions.node.split('.')[0]) >= 22 },
        {
          name: 'git',
          ok: (() => {
            try {
              return Boolean(getGitVersion());
            } catch {
              return false;
            }
          })(),
        },
      ];

      return printJson({ ok: checks.every((check) => check.ok), checks });
    }

    return printHelp();
  } finally {
    store.close();
  }
}
function getGitVersion() {
  return execFileSync('git', ['--version'], { encoding: 'utf8' });
}
