#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const sandbox = mkdtempSync(join(tmpdir(), 'clew-installed-'));
const npmEnvironment = {
  ...process.env,
  NPM_CONFIG_CACHE: process.env.NPM_CONFIG_CACHE ?? join(sandbox, 'npm-cache'),
};

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

try {
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
    'package/RELEASE-0.5.md',
  ]) {
    if (!listing.includes(required)) throw new Error(`tarball is missing ${required}`);
  }
  for (const forbidden of ['.clew/telemetry/', '.env', 'node_modules/']) {
    if (listing.includes(forbidden)) throw new Error(`tarball contains forbidden ${forbidden}`);
  }

  run('npm', ['init', '-y'], sandbox, { env: npmEnvironment });
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', packageFile], sandbox, {
    env: npmEnvironment,
  });
  const cli = join(sandbox, 'node_modules', '.bin', 'clew');

  if (!existsSync(cli)) throw new Error('installed clew executable is missing');
  const installedPackageJson = JSON.parse(
    readFileSync(join(sandbox, 'node_modules', 'clew', 'package.json'), 'utf8'),
  );

  if (installedPackageJson.version !== '0.5.0')
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
  run(process.execPath, [cli, 'init'], sandbox);
  const installedRoot = join(sandbox, 'node_modules', 'clew');
  const { LocalDaemon } = await import(pathToFileURL(join(installedRoot, 'src', 'daemon.js')).href);

  daemon = new LocalDaemon({ cwd: sandbox });
  let metadata = await daemon.start();
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

  await daemon.stop();
  daemon = new LocalDaemon({ cwd: sandbox });
  metadata = await daemon.start();
  const restartedTasks = await apiCommand(metadata, ['task', 'list']);

  if (restartedTasks.length !== 3) throw new Error('daemon restart lost or duplicated tasks');

  const version = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;

  console.log(`Installed package acceptance passed for clew ${version}`);
  console.log(
    `Tarball files inspected: ${readdirSync(sandbox)
      .filter((file) => file.endsWith('.tgz'))
      .join(', ')}`,
  );
} finally {
  await daemon?.stop();
  rmSync(sandbox, { recursive: true, force: true });
}
