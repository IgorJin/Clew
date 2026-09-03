import { chmodSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

if (process.platform !== 'win32') {
  const require = createRequire(import.meta.url);
  const moduleDirectory = dirname(require.resolve('node-pty'));
  const helperCandidates = [
    join(moduleDirectory, '..', 'build', 'Release', 'spawn-helper'),
    join(moduleDirectory, '..', 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
  ];
  const helper = helperCandidates.find((candidate) => existsSync(candidate));

  if (helper) chmodSync(helper, 0o755);
  else
    throw new Error(
      `node-pty spawn helper is unavailable for ${process.platform}-${process.arch}: ${helperCandidates.join(', ')}`,
    );
}
