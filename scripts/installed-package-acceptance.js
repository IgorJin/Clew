#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const sandbox = mkdtempSync(join(tmpdir(), 'clew-installed-'));
const npmEnvironment = { ...process.env, NPM_CONFIG_CACHE: join(sandbox, 'npm-cache') };

function run(command, args, cwd, options = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function clew(cli, args) {
  return JSON.parse(run(process.execPath, [cli, ...args], sandbox));
}

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
    'package/migrations/010_telemetry_context.sql',
    'package/migrations/011_usage_costs.sql',
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

  run('git', ['init', '-b', 'main'], sandbox);
  run('git', ['config', 'user.email', 'acceptance@example.com'], sandbox);
  run('git', ['config', 'user.name', 'Clew Acceptance'], sandbox);
  writeFileSync(join(sandbox, '.gitignore'), '.clew/\n');
  writeFileSync(join(sandbox, 'README.md'), 'installed package acceptance\n');
  run('git', ['add', '.gitignore', 'README.md', 'package.json', 'package-lock.json'], sandbox);
  run('git', ['commit', '-m', 'acceptance fixture'], sandbox);
  run(process.execPath, [cli, 'init'], sandbox);

  for (const profile of ['quick', 'standard']) {
    run(
      process.execPath,
      [
        cli,
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
      sandbox,
    );
    const result = clew(cli, ['run', `PACK-${profile.toUpperCase()}`, '--harness', 'fake']);

    if (result.state !== 'READY')
      throw new Error(`${profile} installed run ended in ${result.state}`);
  }

  run(
    process.execPath,
    [
      cli,
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
    sandbox,
  );
  if (
    clew(cli, ['run', 'PACK-DEEP', '--harness', 'fake', '--architect', 'fake']).state !==
    'WAITING_FOR_HUMAN'
  )
    throw new Error('deep installed run did not wait for approval');
  clew(cli, ['approve', 'PACK-DEEP']);
  if (clew(cli, ['run', 'PACK-DEEP', '--harness', 'fake']).state !== 'READY')
    throw new Error('approved deep installed run did not reach READY');

  const version = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;

  console.log(`Installed package acceptance passed for clew ${version}`);
  console.log(
    `Tarball files inspected: ${readdirSync(sandbox)
      .filter((file) => file.endsWith('.tgz'))
      .join(', ')}`,
  );
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
