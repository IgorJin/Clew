import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { GitWorktreeManager } from '../src/workspace.js';

const harnessName = process.argv[2];

if (!['codex', 'opencode'].includes(harnessName))
  throw new Error('usage: node scripts/live-adapter-smoke.js codex|opencode');

const repo = mkdtempSync(join(tmpdir(), `clew-live-${harnessName}-`));
const stateDir = join(repo, '.clew');
let store;
let succeeded = false;
let approvalTimer;

try {
  runGit(['init', '-b', 'main']);
  runGit(['config', 'user.email', 'clew-smoke@example.invalid']);
  runGit(['config', 'user.name', 'Clew Smoke']);
  writeFileSync(join(repo, '.gitignore'), '.clew/\n');
  writeFileSync(join(repo, 'README.md'), 'Clew native adapter smoke fixture\n');
  runGit(['add', '.gitignore', 'README.md']);
  runGit(['commit', '-m', 'smoke fixture']);

  store = new Store(join(stateDir, 'clew.sqlite'));
  store.createTask({
    id: `LIVE-${harnessName.toUpperCase()}`,
    title: `Clew ${harnessName} live smoke`,
    goal: 'Create result.txt containing exactly CLEW_NATIVE_OK, then run a shell command that verifies its exact content.',
    profile: 'quick',
    risk: 'low',
    base_ref: 'main',
    acceptance: [
      {
        id: 'AC-1',
        criterion: 'result.txt contains exactly CLEW_NATIVE_OK and a command verifies it',
      },
    ],
  });
  const scheduler = new Scheduler(
    store,
    new GitWorktreeManager(join(stateDir, 'worktrees'), repo),
    {
      adapterConfig: {
        codexBin: process.env.CLEW_CODEX_BIN || 'codex',
        openCodeUrl: process.env.CLEW_OPENCODE_URL || 'http://127.0.0.1:4096',
      },
      approvalPollMs: 50,
    },
  );

  approvalTimer = setInterval(() => {
    for (const approval of store.listHarnessApprovals(`LIVE-${harnessName.toUpperCase()}`))
      if (!approval.decision) store.decideHarnessApproval(approval.id, 'accept', 'live-smoke');
  }, 50);
  const result = await scheduler.runTask(`LIVE-${harnessName.toUpperCase()}`, 'quick', harnessName);
  const outputFile = join(result.workspace.path, 'result.txt');

  if (!existsSync(outputFile) || readFileSync(outputFile, 'utf8').trim() !== 'CLEW_NATIVE_OK')
    throw new Error('native harness did not produce the expected result.txt');
  const verification = store
    .listEvents(`LIVE-${harnessName.toUpperCase()}`)
    .find((event) => event.type === 'VERIFICATION_RECORDED')?.payload;

  console.log(
    JSON.stringify(
      {
        harness: harnessName,
        state: result.state,
        revision: result.revision,
        evidence: verification?.evidence,
        primaryCheckoutUntouched: !existsSync(join(repo, 'result.txt')),
      },
      null,
      2,
    ),
  );
  succeeded = true;
} finally {
  clearInterval(approvalTimer);
  store?.close();
  if (succeeded) rmSync(repo, { recursive: true, force: true });
  else console.error(`Live smoke fixture retained for diagnosis: ${repo}`);
}

function runGit(args) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
