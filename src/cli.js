import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateContract } from './domain.js';
import { Store } from './store.js';
import { GitWorktreeManager } from './workspace.js';
import { Scheduler } from './scheduler.js';

const cwd = process.cwd();
const stateDir = join(cwd, '.clew');
const dbFile = join(stateDir, 'clew.sqlite');
const store = () => new Store(dbFile);
function value(args, name, fallback = undefined) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}
function repeatedValue(args, name) {
  const values = [];
  for (let i = 0; i < args.length; i++)
    if (args[i] === name && args[i + 1]) values.push(args[i + 1]);
  return values;
}
function json(value) {
  console.log(JSON.stringify(value, null, 2));
}
function help() {
  console.log(
    `Clew v0.1.0-alpha.1\n\nCommands:\n  clew init\n  clew task create --id ID --title TITLE --goal GOAL --accept TEXT [--profile quick|standard|deep]\n  clew task create --file contract.json\n  clew task list | show ID\n  clew run ID [--profile PROFILE] [--harness fake]\n  clew status ID\n  clew events ID\n  clew doctor`,
  );
}

export async function main(args) {
  const [command, subcommand, ...rest] = args;
  if (!command || command === '--help' || command === '-h') return help();
  if (command === 'init') {
    mkdirSync(stateDir, { recursive: true });
    const s = store();
    s.close();
    console.log(`Initialized ${stateDir}`);
    return;
  }
  const s = store();
  try {
    if (command === 'task' && subcommand === 'create') {
      let contract;
      const file = value(rest, '--file');
      if (file) contract = JSON.parse(readFileSync(resolve(file), 'utf8'));
      else
        contract = {
          id: value(rest, '--id'),
          title: value(rest, '--title'),
          goal: value(rest, '--goal'),
          profile: value(rest, '--profile', 'quick'),
          risk: value(rest, '--risk', 'medium'),
          base_ref: value(rest, '--base', 'HEAD'),
          acceptance: repeatedValue(rest, '--accept'),
        };
      contract = validateContract(contract);
      s.createTask(contract);
      console.log(`Created task ${contract.id}`);
      return;
    }
    if (command === 'task' && subcommand === 'list') return json(s.listTasks());
    if (command === 'task' && subcommand === 'show') {
      const task = s.getTask(rest[0]);
      if (!task) throw new Error(`task not found: ${rest[0]}`);
      return json({ ...task, stages: s.stages(task.id), runs: s.runs(task.id) });
    }
    if (command === 'run') {
      const id = subcommand;
      if (!id) throw new Error('task id is required');
      const manager = new GitWorktreeManager(join(stateDir, 'worktrees'));
      const result = await new Scheduler(s, manager).runTask(
        id,
        value(rest, '--profile'),
        value(rest, '--harness'),
      );
      return json(result);
    }
    if (command === 'status') {
      const task = s.getTask(subcommand);
      if (!task) throw new Error(`task not found: ${subcommand}`);
      return json({
        id: task.id,
        state: task.state,
        stages: s.stages(task.id),
        runs: s.runs(task.id),
      });
    }
    if (command === 'events') return json(s.events(subcommand));
    if (command === 'doctor') {
      const checks = [
        { name: 'node', ok: Number(process.versions.node.split('.')[0]) >= 22 },
        {
          name: 'git',
          ok: (() => {
            try {
              return Boolean(requireGit());
            } catch {
              return false;
            }
          })(),
        },
      ];
      return json({ ok: checks.every((x) => x.ok), checks });
    }
    return help();
  } finally {
    s.close();
  }
}
function requireGit() {
  return execFileSync('git', ['--version'], { encoding: 'utf8' });
}
