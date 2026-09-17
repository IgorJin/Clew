#!/usr/bin/env node
/** Localhost plugin lab: a real Clew daemon + deterministic runtimes.
 *
 * Boots an isolated stand under `./.clew-stand` (its own state, config,
 * fake Codex binaries, and an OpenCode HTTP/SSE stub) and a loopback
 * daemon, so you can poke the full plugin stack by hand — no external
 * Codex/OpenCode CLI, no account, no network.
 *
 * Usage:
 *   node scripts/plugins-stand-server.js start     # boot and leave running
 *   node scripts/plugins-stand-server.js status    # show endpoints + health
 *   node scripts/plugins-stand-server.js stop      # stop daemon + stub
 *   node scripts/plugins-stand-server.js reset     # stop and delete stand
 *
 * npm: stand:serve / stand:status / stand:stop / stand:reset
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLEW_BIN = join(REPO_ROOT, 'bin', 'clew.js');
const STUB_SERVER = join(REPO_ROOT, 'scripts', 'stand', 'opencode-stub-server.js');
const STAND_DIR = join(REPO_ROOT, '.clew-stand');
const PROJECT_DIR = join(STAND_DIR, 'project');
const HOME_DIR = join(STAND_DIR, 'home');
const BIN_DIR = join(STAND_DIR, 'bin');
const LOG_DIR = join(STAND_DIR, 'logs');
const STAND_STATE = join(STAND_DIR, 'stand.json');
const USER_CONFIG = join(HOME_DIR, 'config.json');
const HELPER = join(STAND_DIR, 'clew');

const command = process.argv[2] ?? 'start';

function log(message) {
  console.log(message);
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();

      server.close(() => resolvePort(port));
    });
  });
}

function standEnv(extra = {}) {
  return { ...process.env, CLEW_USER_CONFIG: USER_CONFIG, ...extra };
}

function clew(args, { cwd = PROJECT_DIR, capture = true, env = {} } = {}) {
  const result = spawnSync(process.execPath, [CLEW_BIN, ...args], {
    cwd,
    env: standEnv(env),
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });

  if (result.status !== 0)
    throw new Error(
      `clew ${args.join(' ')} failed (exit ${result.status}): ${result.stderr?.trim()}`,
    );

  const output = result.stdout.trim();

  if (!capture) return null;
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

function readStand() {
  if (!existsSync(STAND_STATE)) return null;

  return JSON.parse(readFileSync(STAND_STATE, 'utf8'));
}

function writeExecutable(path, contents) {
  writeFileSync(path, contents, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function fakeCodexWrapper({ fixture, mode = null }) {
  const node = process.execPath;
  const args = mode ? `"${fixture}" ${mode}` : `"${fixture}"`;

  return `#!/bin/sh
case "$1" in
  --version) echo "codex-cli 0.148.0"; exit 0;;
  login) echo "Logged in"; exit 0;;
esac
exec "${node}" ${args}
`;
}

function ensureProject() {
  mkdirSync(PROJECT_DIR, { recursive: true });
  if (existsSync(join(PROJECT_DIR, '.git'))) return;
  const git = (args) => execFileSync('git', args, { cwd: PROJECT_DIR, stdio: 'ignore' });

  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'stand@example.com']);
  git(['config', 'user.name', 'Plugin Stand']);
  writeFileSync(join(PROJECT_DIR, 'README.md'), '# Plugin stand project\n');
  git(['add', 'README.md']);
  git(['commit', '-m', 'stand base']);
}

function writeConfig(stubPort) {
  const connections = [
    {
      id: 'codex-stand',
      plugin: 'clew.runtime.codex',
      enabled: true,
      config: { bin: join(BIN_DIR, 'fake-codex') },
    },
    {
      id: 'codex-plan',
      plugin: 'clew.runtime.codex',
      enabled: true,
      config: { bin: join(BIN_DIR, 'fake-codex-plan') },
    },
    {
      id: 'opencode-stand',
      plugin: 'clew.runtime.opencode',
      enabled: true,
      config: { baseUrl: `http://127.0.0.1:${stubPort}` },
    },
  ];
  const agents = {
    worker: { connection: 'codex-stand', model: null },
    reviewer: { connection: 'codex-stand', model: null },
    architect: { connection: 'codex-plan', model: null },
    qa: { connection: 'opencode-stand', model: null },
  };

  writeFileSync(USER_CONFIG, `${JSON.stringify({ connections, agents }, null, 2)}\n`);
}

function writeHelper(daemonPort) {
  void daemonPort;
  writeExecutable(
    HELPER,
    `#!/bin/sh
# Stand CLI wrapper: pins cwd + user config so every command hits the lab.
export CLEW_USER_CONFIG="${USER_CONFIG}"
cd "${PROJECT_DIR}" || exit 1
exec "${process.execPath}" "${CLEW_BIN}" "$@"
`,
  );
}

async function waitForHealth(port, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/global/health`);

      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }

  return false;
}

function startStub(port) {
  const logFile = join(LOG_DIR, 'opencode-stub.log');
  const out = openSync(logFile, 'a', 0o600);
  const child = spawn(process.execPath, [STUB_SERVER], {
    env: { ...process.env, STAND_OPENCODE_PORT: String(port) },
    detached: true,
    stdio: ['ignore', out, out],
  });

  child.unref();

  return child.pid;
}

async function start() {
  const existing = readStand();

  if (existing) {
    try {
      const status = clew(['daemon', 'status']);

      if (status?.status === 'running') {
        log('Stand is already running. Use `stand:status` or `stand:stop`, or `stand:reset`.');
        printBanner(existing);

        return;
      }
    } catch {
      // stale; continue and rebuild
    }
  }

  rmSync(STAND_DIR, { recursive: true, force: true });
  for (const dir of [STAND_DIR, PROJECT_DIR, HOME_DIR, BIN_DIR, LOG_DIR])
    mkdirSync(dir, { recursive: true });
  ensureProject();

  writeExecutable(
    join(BIN_DIR, 'fake-codex'),
    fakeCodexWrapper({
      fixture: join(REPO_ROOT, 'fixtures', 'fake-codex-server.js'),
      mode: 'complete',
    }),
  );
  writeExecutable(
    join(BIN_DIR, 'fake-codex-plan'),
    fakeCodexWrapper({ fixture: join(REPO_ROOT, 'fixtures', 'stand', 'codex-plan-server.js') }),
  );

  const stubPort = await freePort();
  const daemonPort = await freePort();
  const stubPid = startStub(stubPort);

  if (!(await waitForHealth(stubPort))) throw new Error('OpenCode stub did not become healthy');

  writeConfig(stubPort);
  writeHelper(daemonPort);

  const metadata = clew(['daemon', 'start', '--port', String(daemonPort)]);
  const state = {
    version: 1,
    startedAt: new Date().toISOString(),
    stubPid,
    stubPort,
    daemonPort,
    endpoint: metadata?.endpoint ?? `http://127.0.0.1:${daemonPort}`,
    projectDir: PROJECT_DIR,
    userConfig: USER_CONFIG,
    helper: HELPER,
  };

  writeFileSync(STAND_STATE, `${JSON.stringify(state, null, 2)}\n`);

  seedTasks();
  printBanner(state);
}

function seedTasks() {
  let projectId = null;

  try {
    const project = clew(['project', 'add', PROJECT_DIR, '--name', 'Plugin Stand']);

    projectId = project?.id ?? null;
  } catch (error) {
    log(`  (project seed skipped: ${error.message.split('\n')[0]})`);
  }

  const seeds = [
    {
      id: 'STAND-QUICK',
      title: 'Stand: quick worker on fake Codex',
      goal: 'Prove the worker path through the localhost daemon',
      profile: 'quick',
    },
    {
      id: 'STAND-STANDARD',
      title: 'Stand: standard worker + reviewer on fake Codex',
      goal: 'Prove review and retry routing through the daemon',
      profile: 'standard',
    },
    {
      id: 'STAND-OPENCODE',
      title: 'Stand: worker on the OpenCode SSE stub',
      goal: 'Prove the OpenCode adapter against a localhost server',
      profile: 'quick',
    },
  ];

  for (const seed of seeds) {
    try {
      clew([
        'task',
        'create',
        '--id',
        seed.id,
        '--title',
        seed.title,
        '--goal',
        seed.goal,
        '--accept',
        'the stand run completes',
        '--profile',
        seed.profile,
        '--verify',
        'npm test',
        ...(projectId ? ['--project', projectId] : []),
      ]);
    } catch (error) {
      log(`  (seed ${seed.id} skipped: ${error.message.split('\n')[0]})`);
    }
  }
}

function printBanner(state) {
  log('');
  log('============================================================');
  log(' Plugin lab is running');
  log('============================================================');
  log(`  daemon endpoint : ${state.endpoint}`);
  log(`  UI              : ${state.endpoint}/`);
  log(`  OpenCode stub   : http://127.0.0.1:${state.stubPort} (pid ${state.stubPid})`);
  log(`  project         : ${state.projectDir}`);
  log(`  user config     : ${state.userConfig}`);
  log(
    `  logs            : ${join(LOG_DIR, 'opencode-stub.log')}, ${join(PROJECT_DIR, '.clew', 'daemon.log')}`,
  );
  log('');
  log('  Use the generated wrapper for every command:');
  log('');
  log(`    ${HELPER} daemon status`);
  log(`    ${HELPER} connections list`);
  log(`    ${HELPER} doctor`);
  log('');
  log('  Run the seeded tasks (worker/reviewer per project .clew.json):');
  log('');
  log(`    ${HELPER} run STAND-QUICK`);
  log(`    ${HELPER} run STAND-STANDARD`);
  log(`    ${HELPER} run STAND-OPENCODE --connection opencode-stand`);
  log(`    ${HELPER} status STAND-QUICK --watch`);
  log(`    ${HELPER} task result STAND-QUICK`);
  log(`    ${HELPER} events STAND-QUICK`);
  log('');
  log('  Or drive it over HTTP with the generated token:');
  log('');
  log(`    TOKEN=$(cat ${join(PROJECT_DIR, '.clew', 'daemon.token')})`);
  log('    curl -s -H "authorization: Bearer $TOKEN" \\');
  log(`      -X POST ${state.endpoint}/api/v1/command \\`);
  log('      -H "content-type: application/json" \\');
  log('      -d \'{"version":1,"command":["status","STAND-QUICK"]}\'');
  log('');
  log('  Real Codex CLI (host-resolved) and git changes:');
  log('');
  log(`    ${HELPER} doctor --connection codex-default     # ready + auth when logged in`);
  log(`    ${HELPER} run STAND-QUICK --connection codex-default   # real Codex turn`);
  log(`    ${HELPER} task changes <RUN-ID>                  # files + unified patch`);
  log(
    `    ${HELPER} task open-changes STAND-QUICK --run <RUN-ID> --viewer cursor|vscode|worktree-path`,
  );
  log('');
  log('  Stop with:  npm run stand:stop   (or node scripts/plugins-stand-server.js stop)');
  log('');
}

function stop({ silent = false } = {}) {
  const state = readStand();

  if (!state) {
    if (!silent) log('Stand is not running.');

    return;
  }

  try {
    clew(['daemon', 'stop']);
    if (!silent) log('Daemon stopped.');
  } catch (error) {
    if (!silent) log(`Daemon stop: ${error.message.split('\n')[0]}`);
  }

  if (state.stubPid) {
    try {
      process.kill(state.stubPid, 'SIGTERM');
      if (!silent) log('OpenCode stub stopped.');
    } catch {
      // already gone
    }
  }

  rmSync(STAND_STATE, { force: true });
}

async function status() {
  const state = readStand();

  if (!state) {
    log('Stand is not running. Start it with `npm run stand:serve`.');

    return;
  }

  log(`daemon endpoint : ${state.endpoint}`);
  log(`UI              : ${state.endpoint}/`);
  const daemon = clew(['daemon', 'status']);

  log(`daemon status   : ${daemon?.status ?? 'unknown'}`);
  const healthy = await waitForHealth(state.stubPort, 1_000);

  log(
    `opencode stub   : ${healthy ? 'healthy' : 'unreachable'} (http://127.0.0.1:${state.stubPort})`,
  );
  log('');
  log('connections:');
  const connections = clew(['connections', 'list']);

  for (const entry of connections.connections ?? [])
    log(`  - ${entry.id} [${entry.plugin}] enabled=${entry.enabled}`);
  log('');
  log('tasks:');
  const tasks = clew(['task', 'list']);

  for (const task of tasks ?? []) log(`  - ${task.id} ${task.state}`);
  log('');
  log(`Run: ${HELPER} run STAND-QUICK`);
}

function reset() {
  stop({ silent: true });
  rmSync(STAND_DIR, { recursive: true, force: true });
  log('Stand removed.');
}

switch (command) {
  case 'start':
    await start();
    break;
  case 'stop':
    stop();
    break;
  case 'status':
    await status();
    break;
  case 'reset':
    reset();
    break;
  default:
    log('usage: plugins-stand-server.js start|status|stop|reset');
    process.exit(2);
}
