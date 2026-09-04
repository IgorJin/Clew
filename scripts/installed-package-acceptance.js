#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const packageVersion = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
const sandbox = mkdtempSync(join(tmpdir(), 'clew-installed-'));
const npmEnvironment = {
  ...process.env,
  NPM_CONFIG_CACHE: process.env.NPM_CONFIG_CACHE ?? join(sandbox, 'npm-cache'),
};

function progress(message) {
  console.log(`[installed acceptance] ${message}`);
}

function run(command, args, cwd, options = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

async function apiCommand(metadata, args, cookie = null) {
  const token = readFileSync(metadata.tokenFile, 'utf8').trim();
  const response = await fetch(`${metadata.endpoint}/api/v1/command`, {
    method: 'POST',
    headers: {
      ...(!cookie ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      version: 1,
      requestId: `acceptance-${Date.now()}-${Math.random()}`,
      kind: 'command',
      name: 'service.execute',
      payload: { args },
    }),
  });
  const body = await response.json();

  if (!response.ok || body.kind === 'error')
    throw new Error(body.error?.message ?? `API command failed: ${response.status}`);

  return body.payload;
}

async function waitFor(predicate, message, timeoutMs = 10_000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const result = await predicate();

    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${message}`);
}

function stopChild(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Runner process did not stop')), 5_000);

    child.once('exit', (code, exitSignal) => {
      clearTimeout(timeout);
      if (code === 0 || exitSignal === signal) resolve();
      else reject(new Error(`Runner process exited with ${code ?? exitSignal}`));
    });
    child.kill(signal);
  });
}

function websocketHandshake(metadata, origin) {
  const endpoint = new URL(metadata.endpoint);
  const token = readFileSync(metadata.tokenFile, 'utf8').trim();

  return new Promise((resolve, reject) => {
    const socket = connect({ host: endpoint.hostname, port: Number(endpoint.port) });
    let response = '';
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('installed WebSocket handshake timed out'));
    }, 1_000);
    const finish = () => {
      clearTimeout(timeout);
      resolve(response);
    };

    socket.once('connect', () => {
      socket.write(
        [
          'GET /?after=0 HTTP/1.1',
          `Host: ${endpoint.host}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          `Authorization: Bearer ${token}`,
          `Origin: ${origin}`,
          '',
          '',
        ].join('\r\n'),
      );
    });
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
      if (response.includes('101 Switching Protocols') && response.includes('TASK_CREATED')) {
        socket.end();
        finish();
      }
    });
    socket.once('close', finish);
    socket.once('error', reject);
  });
}

let daemon = null;
let runnerProcess = null;
const originalUserConfig = process.env.CLEW_USER_CONFIG;

try {
  progress('packing artifact');
  const packed = run('npm', ['pack', '--json', '--pack-destination', sandbox], packageRoot, {
    env: npmEnvironment,
  });
  const tarball = JSON.parse(packed)[0]?.filename;

  if (!tarball) throw new Error('npm pack did not produce a tarball');

  const packageFile = join(sandbox, tarball);
  const listing = run('tar', ['-tf', packageFile], sandbox);

  for (const required of [
    'package/bin/clew.js',
    'package/src/control-service.js',
    'package/ui/dist/index.html',
    'package/migrations/012_control_plane_contracts.sql',
    'package/migrations/014_continuation_idempotency.sql',
    'package/migrations/015_continuation_lifecycle.sql',
    'package/migrations/010_telemetry_context.sql',
    'package/migrations/011_usage_costs.sql',
    'package/RELEASE-0.6.md',
    'package/RELEASE-0.8.md',
    'package/docs/GIT-WORKFLOW.md',
    'package/docs/adr/0002-diff-viewer.md',
    'package/migrations/021_run_git_provenance.sql',
    'package/migrations/017_runner_leases.sql',
    'package/src/runner-protocol.js',
    'package/src/runner-store.js',
    'package/src/runner-transport.js',
    'package/src/runner.js',
  ]) {
    if (!listing.includes(required)) throw new Error(`tarball is missing ${required}`);
  }
  for (const forbidden of ['.clew/telemetry/', '.env', 'node_modules/']) {
    if (listing.includes(forbidden)) throw new Error(`tarball contains forbidden ${forbidden}`);
  }

  progress('installing artifact');
  run('npm', ['init', '-y'], sandbox, { env: npmEnvironment });
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', packageFile], sandbox, {
    env: npmEnvironment,
  });
  const cli = join(sandbox, 'node_modules', '.bin', 'clew');

  if (!existsSync(cli)) throw new Error('installed clew executable is missing');
  const installedPackageJson = JSON.parse(
    readFileSync(join(sandbox, 'node_modules', 'clew', 'package.json'), 'utf8'),
  );

  if (installedPackageJson.version !== packageVersion)
    throw new Error(`installed package version is ${installedPackageJson.version}`);
  const installedAssets = readdirSync(
    join(sandbox, 'node_modules', 'clew', 'ui', 'dist', 'assets'),
  );

  if (
    !installedAssets.some((file) => file.endsWith('.css')) ||
    !installedAssets.some((file) => file.endsWith('.js'))
  )
    throw new Error('installed UI assets are incomplete');
  if (installedPackageJson.dependencies?.react || installedPackageJson.devDependencies?.react)
    throw new Error('installed package declares React instead of Preact');

  run('git', ['init', '-b', 'main'], sandbox);
  run('git', ['config', 'user.email', 'acceptance@example.com'], sandbox);
  run('git', ['config', 'user.name', 'Clew Acceptance'], sandbox);
  writeFileSync(join(sandbox, '.gitignore'), '.clew/\n');
  writeFileSync(join(sandbox, 'README.md'), 'installed package acceptance\n');
  run('git', ['add', '.gitignore', 'README.md', 'package.json', 'package-lock.json'], sandbox);
  run('git', ['commit', '-m', 'acceptance fixture'], sandbox);
  const primaryRevision = run('git', ['rev-parse', 'HEAD'], sandbox).trim();

  run(process.execPath, [cli, 'init'], sandbox);
  const installedRoot = join(sandbox, 'node_modules', 'clew');
  const { LocalDaemon } = await import(pathToFileURL(join(installedRoot, 'src', 'daemon.js')).href);
  const pairedCredential = 'installed-paired-transport-secret';
  const runnerStateDir = join(sandbox, 'runner-state');
  const userConfigPath = join(sandbox, 'clew-acceptance-config.json');

  writeFileSync(
    userConfigPath,
    JSON.stringify({
      controllerRunner: {
        runnerId: 'installed-runner',
        requiredCapabilities: ['execute'],
      },
      runner: {
        id: 'installed-runner',
        controllerUrl: 'ws://127.0.0.1:1/runner/v1',
        stateDir: runnerStateDir,
        workspaces: { installed: sandbox },
        capabilities: ['execute', 'runner_local_terminal'],
        reconnect: { minDelayMs: 25, maxDelayMs: 250 },
      },
    }),
  );
  process.env.CLEW_USER_CONFIG = userConfigPath;
  process.env.CLEW_CONTROLLER_RUNNER_TOKEN = pairedCredential;

  daemon = new LocalDaemon({ cwd: sandbox, port: 0 });
  let metadata = await daemon.start();

  progress('starting paired Runner');
  const acceptanceConfig = JSON.parse(readFileSync(userConfigPath, 'utf8'));

  acceptanceConfig.runner.controllerUrl = metadata.endpoint.replace(/^http/, 'ws') + '/runner/v1';
  writeFileSync(userConfigPath, JSON.stringify(acceptanceConfig));
  runnerProcess = spawn(process.execPath, [cli, 'runner', 'serve'], {
    cwd: sandbox,
    env: {
      ...process.env,
      CLEW_USER_CONFIG: userConfigPath,
      CLEW_RUNNER_TOKEN: pairedCredential,
      CLEW_CONTROLLER_RUNNER_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let runnerStderr = '';
  let runnerStdout = '';
  let lastRunnerSnapshot = null;

  runnerProcess.stdout.on('data', (chunk) => {
    runnerStdout += chunk.toString('utf8');
  });
  runnerProcess.stderr.on('data', (chunk) => {
    runnerStderr += chunk.toString('utf8');
  });
  try {
    await waitFor(async () => {
      if (runnerProcess.exitCode !== null)
        throw new Error(`installed Runner exited early: ${runnerStderr.trim()}`);
      const response = await fetch(`${metadata.endpoint}/api/v1/health`, {
        headers: { authorization: `Bearer ${readFileSync(metadata.tokenFile, 'utf8').trim()}` },
      });

      if (!response.ok) return false;
      const body = await response.json();

      lastRunnerSnapshot = body.runner;

      return body.runner?.connected === true;
    }, 'installed Runner registration');
  } catch (error) {
    throw new Error(
      `${error.message}; Runner stdout=${runnerStdout.trim()}; Runner stderr=${runnerStderr.trim()}; projection=${JSON.stringify(lastRunnerSnapshot)}`,
      { cause: error },
    );
  }
  const page = await fetch(`${metadata.endpoint}/`);

  if (!page.ok || !(await page.text()).includes('Clew / Task control plane'))
    throw new Error('installed daemon did not serve the production UI');
  const bootstrap = await fetch(`${metadata.endpoint}/api/v1/bootstrap`, {
    headers: { origin: metadata.endpoint },
  });

  if (bootstrap.status !== 204) throw new Error('installed browser bootstrap failed');
  const cookie = bootstrap.headers.get('set-cookie')?.split(';')[0];

  if (!cookie) throw new Error('installed browser bootstrap did not issue a session cookie');

  for (const profile of ['quick', 'standard']) {
    await apiCommand(
      metadata,
      [
        'task',
        'create',
        '--id',
        `PACK-${profile.toUpperCase()}`,
        '--title',
        `${profile} package`,
        '--goal',
        'installed package acceptance',
        '--accept',
        'fixture reaches READY',
        '--profile',
        profile,
      ],
      cookie,
    );
    const result = await apiCommand(
      metadata,
      ['run', `PACK-${profile.toUpperCase()}`, '--harness', 'fake'],
      cookie,
    );

    if (result.state !== 'READY')
      throw new Error(`${profile} installed run ended in ${result.state}`);
  }

  progress('local Quick and Standard passed');

  await apiCommand(
    metadata,
    [
      'task',
      'create',
      '--id',
      'PACK-DEEP',
      '--title',
      'deep package',
      '--goal',
      'installed package acceptance',
      '--accept',
      'fixture reaches READY',
      '--profile',
      'deep',
    ],
    cookie,
  );
  if (
    (
      await apiCommand(
        metadata,
        ['run', 'PACK-DEEP', '--harness', 'fake', '--architect', 'fake'],
        cookie,
      )
    ).state !== 'WAITING_FOR_HUMAN'
  )
    throw new Error('deep installed run did not wait for approval');
  await apiCommand(metadata, ['approve', 'PACK-DEEP'], cookie);
  if (
    (await apiCommand(metadata, ['run', 'PACK-DEEP', '--harness', 'fake'], cookie)).state !==
    'READY'
  )
    throw new Error('approved deep installed run did not reach READY');
  progress('local Deep passed');

  const quickShow = await apiCommand(metadata, ['task', 'show', 'PACK-QUICK'], cookie);
  const quickRun = quickShow.runs.at(-1);
  const quickChanges = await apiCommand(metadata, ['task', 'changes', quickRun.id], cookie);

  if (
    quickChanges.state !== 'available' ||
    quickChanges.revisions.base !== quickRun.base_sha ||
    !quickRun.branch
  )
    throw new Error('installed local run did not preserve inspectable Git provenance');
  await apiCommand(
    metadata,
    ['complete', 'PACK-QUICK', '--revision', quickRun.commit_sha, '--actor', 'acceptance'],
    cookie,
  );
  if (run('git', ['rev-parse', 'HEAD'], sandbox).trim() !== primaryRevision)
    throw new Error('installed completion changed the primary checkout');

  const continuation = await apiCommand(
    metadata,
    [
      'continue',
      'PACK-STANDARD',
      '--message',
      'Verify installed continuation audit',
      '--actor',
      'acceptance',
    ],
    cookie,
  );

  if (continuation.result?.state !== 'READY')
    throw new Error(`installed continuation ended in ${continuation.result?.state}`);
  const thread = await apiCommand(metadata, ['task', 'thread', 'PACK-STANDARD'], cookie);

  if (!thread.items.some((item) => item.kind === 'operator_message' && item.redacted))
    throw new Error('installed Task Thread did not include the redacted continuation message');
  const snapshotResponse = await fetch(`${metadata.endpoint}/api/v1/snapshot`, {
    headers: { cookie },
  });
  const snapshot = await snapshotResponse.json();

  if (!snapshotResponse.ok || snapshot.tasks?.length !== 3)
    throw new Error('installed daemon did not serve the aggregated control snapshot');
  const websocket = await websocketHandshake(metadata, metadata.endpoint);

  if (!websocket.includes('101 Switching Protocols') || !websocket.includes('TASK_CREATED'))
    throw new Error('installed WebSocket did not replay durable events');
  if (
    (await websocketHandshake(metadata, 'http://malicious.invalid')).includes(
      '101 Switching Protocols',
    )
  )
    throw new Error('installed WebSocket accepted a foreign origin');

  for (const profile of ['quick', 'standard', 'deep']) {
    const taskId = `PAIRED-${profile.toUpperCase()}`;

    await apiCommand(
      metadata,
      [
        'task',
        'create',
        '--id',
        taskId,
        '--title',
        `${profile} paired package`,
        '--goal',
        'installed paired package acceptance',
        '--accept',
        'paired fixture reaches READY',
        '--profile',
        profile,
      ],
      cookie,
    );
    let result = await apiCommand(
      metadata,
      ['run', taskId, '--harness', 'fake', '--execution', 'paired'],
      cookie,
    );

    if (profile === 'deep') {
      if (result.state !== 'WAITING_FOR_HUMAN')
        throw new Error(`paired deep did not wait for approval: ${result.state}`);
      await apiCommand(metadata, ['approve', taskId], cookie);
      result = await apiCommand(
        metadata,
        ['run', taskId, '--harness', 'fake', '--execution', 'paired'],
        cookie,
      );
    }
    if (result.state !== 'READY')
      throw new Error(`${profile} installed paired run ended in ${result.state}`);
  }
  progress('paired profiles passed');
  const pairedSnapshotResponse = await fetch(`${metadata.endpoint}/api/v1/snapshot`, {
    headers: { cookie },
  });
  const pairedSnapshot = await pairedSnapshotResponse.json();

  const pairedHealth = await (
    await fetch(`${metadata.endpoint}/api/v1/health`, { headers: { cookie } })
  ).json();

  if (!pairedHealth.runner?.connected)
    throw new Error('installed health projection lost the paired Runner');
  const pairedDeep = pairedSnapshot.tasks.find((task) => task.show.id === 'PAIRED-DEEP');

  if (
    !pairedDeep?.show.runs.every(
      (run) => run.execution_mode === 'paired' && run.terminalAccess === 'runner_local',
    )
  )
    throw new Error('installed paired projection did not preserve Runner-local ownership');
  const pairedRun = pairedDeep.show.runs.at(-1);
  const pairedChanges = await apiCommand(metadata, ['task', 'changes', pairedRun.id], cookie);

  if (pairedChanges.state !== 'unavailable' || pairedChanges.reason !== 'runner-local-unavailable')
    throw new Error('installed paired changes did not preserve the Runner-local boundary');
  await stopChild(runnerProcess);
  runnerProcess = null;
  const runnerStatus = JSON.parse(
    run(process.execPath, [cli, 'runner', 'status'], sandbox, {
      env: {
        ...process.env,
        CLEW_USER_CONFIG: userConfigPath,
        CLEW_RUNNER_TOKEN: pairedCredential,
        CLEW_CONTROLLER_RUNNER_TOKEN: '',
      },
    }),
  );

  if (runnerStatus.process.running || runnerStatus.process.stale)
    throw new Error('installed Runner shutdown left a process ownership lock');
  for (const database of [
    join(sandbox, '.clew', 'clew.sqlite'),
    join(runnerStateDir, 'runner.sqlite'),
  ]) {
    if (readFileSync(database).includes(Buffer.from(pairedCredential)))
      throw new Error(`installed persistence leaked the paired credential into ${database}`);
  }

  await daemon.stop();
  progress('checking restart persistence');
  daemon = new LocalDaemon({ cwd: sandbox });
  metadata = await daemon.start();
  const restartedTasks = await apiCommand(metadata, ['task', 'list']);

  if (restartedTasks.length !== 6) throw new Error('daemon restart lost or duplicated tasks');

  const version = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;

  console.log(`Installed package acceptance passed for clew ${version}`);
  console.log(
    `Tarball files inspected: ${readdirSync(sandbox)
      .filter((file) => file.endsWith('.tgz'))
      .join(', ')}`,
  );
} finally {
  await stopChild(runnerProcess).catch(() => {});
  await daemon?.stop();
  if (originalUserConfig === undefined) delete process.env.CLEW_USER_CONFIG;
  else process.env.CLEW_USER_CONFIG = originalUserConfig;
  delete process.env.CLEW_CONTROLLER_RUNNER_TOKEN;
  rmSync(sandbox, { recursive: true, force: true });
}
