import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve, join } from 'node:path';
import { URL } from 'node:url';
import { TASK_STATE } from './domain.js';
import { Store } from './store.js';
import { loadConfig, loadRunnerConfig } from './config.js';
import { Observability, telemetryInstall } from './observability.js';
import {
  DEFAULT_DAEMON_PORT,
  LocalDaemon,
  daemonRequest,
  daemonLogFile,
  daemonStatus,
  startDaemonProcess,
  stopDaemon,
} from './daemon.js';
import { ClewService } from './control-service.js';
import { RunnerExecutionPort } from './runner-execution.js';
import { RunnerService } from './runner.js';
import { RunnerStore } from './runner-store.js';
import { RunnerTransport } from './runner-transport.js';

const cwd = process.cwd();
const stateDir = join(cwd, '.clew');
const dbFile = join(stateDir, 'clew.sqlite');
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
function readDaemonLogTail(path, lines) {
  if (!existsSync(path)) return '';
  const entries = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => {
      try {
        return JSON.parse(line).service === 'clew-daemon';
      } catch {
        return false;
      }
    });

  return entries.slice(-lines).join('\n');
}
async function printDaemonLogs(rest) {
  const requestedLines = Number(getOptionValue(rest, '--lines', 100));

  if (!Number.isSafeInteger(requestedLines) || requestedLines < 1)
    throw new Error('--lines must be a positive integer');
  const path = daemonLogFile(cwd);
  const initial = readDaemonLogTail(path, requestedLines);

  if (initial) process.stdout.write(`${initial}\n`);
  if (!rest.includes('--follow')) return;
  let offset = existsSync(path) ? readFileSync(path).length : 0;
  const controller = new AbortController();
  const stop = () => controller.abort();

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    while (!controller.signal.aborted) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
      if (!existsSync(path)) continue;
      const content = readFileSync(path);

      if (content.length < offset) offset = 0;
      if (content.length === offset) continue;
      process.stdout.write(content.subarray(offset).toString('utf8'));
      offset = content.length;
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
function printHelp() {
  console.log(
    `Clew v${packageVersion}\n\nCommands:\n  clew init\n  clew task create --title TITLE --description TEXT [--id ID]\n  clew task create --json task.json | --md task.md [--id ID]\n  clew task create --file contract.json (legacy)\n  clew task list | show ID | result ID\n  clew task history ID [--stage STAGE] [--attempt N]\n  clew plan ID\n  clew approve ID [gate-id]\n  clew reject ID [gate-id] [--reason TEXT]\n  clew approve-run APPROVAL-ID [--actor ACTOR]\n  clew reject-run APPROVAL-ID [--actor ACTOR]\n  clew interrupt ID [--actor ACTOR]\n  clew retry TASK [STAGE] [--actor ACTOR] [--reason TEXT]\n  clew verify TASK --revision SHA [--stage STAGE] [--actor ACTOR]\n  clew worktree list | remove PATH [--force] | prune\n  clew run ID [--profile PROFILE] [--harness fake|codex|opencode] [--execution local|paired] [--review-harness fake|codex] [--architect fake|codex]\n  clew status ID [--watch] [--interval MS]\n  clew events ID [--watch]\n  clew doctor [--harness codex|opencode]`,
  );
  console.log('  clew finish-worker TASK [--run RUN-ID]');
  console.log('  clew task next-step ID');
  console.log('  clew task approve-step ID --action ACTION-ID [--harness opencode]');
  console.log('  clew task open-changes ID');
  console.log(
    '  clew complete TASK --revision SHA [--actor ACTOR] [--review-override] [--note TEXT]',
  );
  console.log('  clew export TASK --dir DIR [--revision SHA]');
  console.log('  clew cleanup [--retention-days N]');
  console.log('  clew telemetry install | status');
  console.log('  clew pricing sync [--source NAME] [--url URL] [--provider NAME]');
  console.log('  clew daemon start [--port PORT] | status | stop | logs [--lines N] [--follow]');
  console.log('  clew runner serve | status');
  console.log('  clew api task list|show ID|...');
  console.log('  clew task thread ID [--after CURSOR] [--limit N] [--follow]');
  console.log('  clew task message ID --message TEXT [--actor ACTOR]');
  console.log(
    '  clew session open TASK [--stage STAGE] [--role ROLE] [--harness HARNESS] [--surface plain|live|none]',
  );
  console.log('  clew session capabilities [--harness HARNESS]');
  console.log('  clew continue TASK --message TEXT [--actor ACTOR]');
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function runnerOwnership(config) {
  const lock = join(config.stateDir, 'runner.lock');

  if (!existsSync(lock)) return { running: false, pid: null, lock };
  let pid;

  try {
    pid = Number(readFileSync(lock, 'utf8').trim());
  } catch {
    return { running: false, pid: null, lock, stale: true };
  }

  return { running: isProcessAlive(pid), pid, lock, stale: !isProcessAlive(pid) };
}

async function runRunnerCommand(subcommand) {
  const runnerConfig = loadRunnerConfig();
  const ownership = runnerOwnership(runnerConfig);

  if (subcommand === 'status') {
    const store = new RunnerStore(join(runnerConfig.stateDir, 'runner.sqlite'), {
      configuredRunnerId: runnerConfig.runnerId,
      maxOutboxEntries: runnerConfig.outbox.maxEntries,
      maxOutboxBytes: runnerConfig.outbox.maxBytes,
      reservedTerminalEntries: runnerConfig.outbox.reservedEntries,
    });

    try {
      return printJson({
        runnerId: store.getOrCreateIdentity().runnerId,
        process: {
          running: ownership.running,
          pid: ownership.pid,
          stale: ownership.stale ?? false,
        },
        persistence: store.status(),
      });
    } finally {
      store.close();
    }
  }
  if (subcommand !== 'serve') throw new Error('usage: clew runner serve|status');
  mkdirSync(runnerConfig.stateDir, { recursive: true });
  if (ownership.running)
    throw new Error(`Runner state is already owned by process ${ownership.pid}`);
  if (ownership.stale) unlinkSync(ownership.lock);
  const lockFd = openSync(ownership.lock, 'wx', 0o600);

  writeFileSync(lockFd, `${process.pid}\n`);
  const store = new RunnerStore(join(runnerConfig.stateDir, 'runner.sqlite'), {
    configuredRunnerId: runnerConfig.runnerId,
    maxOutboxEntries: runnerConfig.outbox.maxEntries,
    maxOutboxBytes: runnerConfig.outbox.maxBytes,
    reservedTerminalEntries: runnerConfig.outbox.reservedEntries,
  });
  const transport = new RunnerTransport({
    endpoint: runnerConfig.controllerUrl,
    credential: runnerConfig.credential,
    runnerId: runnerConfig.runnerId,
    productVersion: packageVersion,
    capabilities: runnerConfig.capabilities,
    workspaces: runnerConfig.workspaces.map(({ id }) => ({ id })),
    store,
    reconnect: {
      initialMs: runnerConfig.reconnect.minDelayMs,
      maximumMs: runnerConfig.reconnect.maxDelayMs,
    },
  });
  const executionPort = new RunnerExecutionPort({
    workspaces: runnerConfig.workspaces,
    worktreeRoot: join(runnerConfig.stateDir, 'worktrees'),
    adapterConfig: runnerConfig.adapterConfig,
  });
  const service = new RunnerService({ store, transport, executionPort });
  const controller = new AbortController();
  const stop = () => controller.abort();

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    service.start({ signal: controller.signal });
    printJson(service.status());
    await new Promise((resolveStop) => controller.signal.addEventListener('abort', resolveStop));
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await service.stop();
    closeSync(lockFd);
    if (existsSync(ownership.lock)) unlinkSync(ownership.lock);
  }
}

export async function main(args) {
  const [command, subcommand, ...rest] = args;

  if (!command || command === '--help' || command === '-h') return printHelp();
  if (command === 'runner') return runRunnerCommand(subcommand);
  if (command === 'daemon') {
    if (subcommand === 'status') return printJson(await daemonStatus(cwd));
    if (subcommand === 'stop') return printJson(await stopDaemon(cwd));
    if (subcommand === 'logs') return printDaemonLogs(rest);
    if (subcommand === 'start') {
      const port = Number(getOptionValue(rest, '--port', DEFAULT_DAEMON_PORT));

      if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error('--port must be an integer between 1 and 65535');

      return printJson(await startDaemonProcess(cwd, { port }));
    }
    if (subcommand === 'serve') {
      const daemon = new LocalDaemon({
        cwd,
        port: Number(getOptionValue(rest, '--port', DEFAULT_DAEMON_PORT)),
      });
      const metadata = await daemon.start();

      printJson(metadata);
      const shutdown = () => daemon.stop().finally(() => process.exit(0));

      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
      process.once('SIGHUP', shutdown);
      await new Promise(() => {});
    }
    throw new Error('usage: clew daemon start|status|stop|logs');
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
  const config = loadConfig(cwd);

  if (command === 'run' || command === 'finish-worker') {
    const daemon = await daemonStatus(cwd);

    if (daemon.status === 'running')
      return printJson(await daemonRequest(cwd, args, { timeoutMs: 24 * 60 * 60_000 }));
  }
  const store = createStore();
  const observability = new Observability({
    cwd,
    config: resolveCommandConfig(config, args).observability,
    store,
  });

  store.setEventObserver(observability);

  try {
    const service = new ClewService({ cwd, store, config });

    if (service.supports(args)) {
      const controller = new AbortController();
      const interrupt = () => controller.abort();

      process.once('SIGINT', interrupt);
      process.once('SIGTERM', interrupt);
      try {
        let result =
          command === 'task' && subcommand === 'result' && rest.includes('--watch')
            ? await service.execute(['status', rest[0]], { signal: controller.signal })
            : await service.execute(args, { signal: controller.signal });

        if (command === 'task' && subcommand === 'create' && !rest.includes('--json'))
          console.log(`Created task ${result.id}`);
        else if (command === 'task' && subcommand === 'history' && rest.includes('--human'))
          printHumanHistory(result);
        else if (command === 'task' && subcommand === 'result' && rest.includes('--watch')) {
          let lastState = null;

          while (!TERMINAL_TASK_STATES.includes(result.state)) {
            if (result.state !== lastState) {
              printJson({ taskId: rest[0], state: result.state });
              lastState = result.state;
            }
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
            result = await service.execute(['status', rest[0]], {
              signal: controller.signal,
            });
          }
          printResult(await service.execute(['task', 'result', rest[0]]), []);
        } else if (command === 'task' && subcommand === 'result') printResult(result, rest);
        else if (command === 'task' && subcommand === 'usage' && rest.includes('--human'))
          console.log(
            `Task: ${result.taskId}\nStatus: ${result.status}\nTurns: ${result.turns}\nPriced: ${result.pricedTurns}\nTotal: ${JSON.stringify(result.total)}`,
          );
        else if (command === 'status') {
          printJson(result);
          if (rest.includes('--watch')) {
            const intervalMs = Number(getOptionValue(rest, '--interval', 1_000));

            if (!Number.isFinite(intervalMs) || intervalMs < 50)
              throw new Error('--interval must be at least 50 milliseconds');
            while (!TERMINAL_TASK_STATES.includes(result.state)) {
              await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs));
              result = await service.execute(['status', subcommand], {
                signal: controller.signal,
              });
              printJson(result);
            }
          }
        } else if (command === 'task' && subcommand === 'thread' && rest.includes('--follow')) {
          printJson(result);
          let cursor = result.items.at(-1)?.cursor ?? 0;

          while (true) {
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
            const page = await service.execute([
              'task',
              'thread',
              subcommand === 'thread' ? rest[0] : '',
              '--after',
              String(cursor),
            ]);

            if (page.items.length) {
              printJson(page);
              cursor = page.items.at(-1).cursor;
            }
            const status = await service.execute(['status', rest[0]]);

            if (TERMINAL_TASK_STATES.includes(status.state)) break;
          }
        } else printJson(result);

        return;
      } finally {
        process.removeListener('SIGINT', interrupt);
        process.removeListener('SIGTERM', interrupt);
      }
    }
    throw new Error(`unknown command: ${args.join(' ')}`);
  } finally {
    await observability.shutdown();
    store.close();
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
