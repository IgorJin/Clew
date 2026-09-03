import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControllerRunnerGateway } from '../src/controller-runner-gateway.js';
import { PairedExecutionPort } from '../src/execution-port.js';
import { RunnerExecutionPort } from '../src/runner-execution.js';
import { RunnerService } from '../src/runner.js';
import { RunnerStore } from '../src/runner-store.js';
import { RunnerTransport } from '../src/runner-transport.js';
import { Scheduler } from '../src/scheduler.js';
import { Store } from '../src/store.js';

const repository = mkdtempSync(join(tmpdir(), 'clew-live-runner-codex-'));
const stateDirectory = join(repository, '.clew');
const controllerStore = new Store(join(stateDirectory, 'controller.sqlite'));
const runnerStore = new RunnerStore(join(stateDirectory, 'runner.sqlite'), {
  configuredRunnerId: 'live-runner',
});
const server = createServer();
const gateway = new ControllerRunnerGateway({
  store: controllerStore,
  credential: 'live-smoke-credential',
  runnerId: 'live-runner',
  productVersion: '0.6.0',
  requiredCapabilities: ['execute'],
}).attach(server);
let runner;
let succeeded = false;

try {
  runGit(['init', '-b', 'main']);
  runGit(['config', 'user.email', 'clew-runner-smoke@example.invalid']);
  runGit(['config', 'user.name', 'Clew Runner Smoke']);
  writeFileSync(join(repository, '.gitignore'), '.clew/\n');
  writeFileSync(join(repository, 'README.md'), 'Clew paired native smoke fixture\n');
  runGit(['add', '.gitignore', 'README.md']);
  runGit(['commit', '-m', 'paired smoke fixture']);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const transport = new RunnerTransport({
    endpoint: `ws://127.0.0.1:${server.address().port}/runner/v1`,
    credential: 'live-smoke-credential',
    runnerId: 'live-runner',
    productVersion: '0.6.0',
    capabilities: ['execute', 'runner_local_terminal'],
    workspaces: [{ id: 'clew' }],
    store: runnerStore,
  });

  runner = new RunnerService({
    store: runnerStore,
    transport,
    closeStore: false,
    executionPort: new RunnerExecutionPort({
      workspaces: [{ id: 'clew', path: repository }],
      worktreeRoot: join(stateDirectory, 'runner-worktrees'),
      adapterConfig: {
        codexBin: process.env.CLEW_CODEX_BIN || 'codex',
        onApproval: async () => 'accept',
      },
    }),
  });
  runner.start();
  await waitFor(() => gateway.status().connected, 'Runner registration');
  controllerStore.createTask({
    id: 'LIVE-RUNNER-CODEX',
    title: 'Clew paired Codex smoke',
    goal: 'Create result.txt containing exactly CLEW_RUNNER_NATIVE_OK, then run a shell command that verifies its exact content.',
    profile: 'quick',
    risk: 'low',
    base_ref: 'main',
    acceptance: [
      {
        id: 'AC-1',
        criterion: 'result.txt contains exactly CLEW_RUNNER_NATIVE_OK and command evidence passes',
      },
    ],
  });
  const scheduler = new Scheduler(
    controllerStore,
    {},
    {
      executionPort: new PairedExecutionPort({
        store: controllerStore,
        transport: gateway,
        runnerId: 'live-runner',
      }),
      interruptPollMs: 50,
    },
  );
  const result = await scheduler.runTask('LIVE-RUNNER-CODEX', 'quick', 'codex');
  const run = controllerStore.getRun(result.runId);
  const runnerWorktree = join(
    stateDirectory,
    'runner-worktrees',
    'clew',
    'LIVE-RUNNER-CODEX-worker',
  );
  const outputFile = join(runnerWorktree, 'result.txt');

  if (
    !existsSync(outputFile) ||
    readFileSync(outputFile, 'utf8').trim() !== 'CLEW_RUNNER_NATIVE_OK'
  )
    throw new Error('paired Codex did not produce the expected Runner-local result.txt');
  await waitFor(() => runnerStore.status().outbox.entries === 0, 'Runner outbox acknowledgment');
  console.log(
    JSON.stringify(
      {
        harness: 'codex',
        executionMode: run.execution_mode,
        state: result.state,
        revision: result.revision,
        runnerId: run.runner_id,
        controllerWorkspace: run.workspace,
        terminalAccess: result.workspace.access,
        primaryCheckoutUntouched: !existsSync(join(repository, 'result.txt')),
      },
      null,
      2,
    ),
  );
  succeeded = true;
} finally {
  await runner?.stop();
  gateway.close();
  await new Promise((resolve) => server.close(resolve));
  runnerStore.close();
  controllerStore.close();
  if (succeeded) rmSync(repository, { recursive: true, force: true });
  else console.error(`Live paired smoke fixture retained for diagnosis: ${repository}`);
}

async function waitFor(predicate, message, timeoutMs = 10 * 60_000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${message}`);
}

function runGit(args) {
  return execFileSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
