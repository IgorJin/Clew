import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexArchitect } from '../src/architect.js';
import { validateExecutionPlan } from '../src/domain.js';
import { CodexHarness } from '../src/harness.js';
import { CodexReviewer } from '../src/review.js';

const repo = mkdtempSync(join(tmpdir(), 'clew-live-codex-roles-'));
let succeeded = false;

try {
  runGit(['init', '-b', 'main']);
  runGit(['config', 'user.email', 'clew-smoke@example.invalid']);
  runGit(['config', 'user.name', 'Clew Smoke']);
  runGit(['commit', '--allow-empty', '-m', 'roles fixture']);
  const task = {
    id: 'LIVE-CODEX-ROLES',
    title: 'Codex roles smoke',
    goal: 'Plan a single read-only documentation check',
    profile: 'deep',
    risk: 'low',
    base_ref: 'main',
    acceptance: [{ id: 'AC-1', criterion: 'the repository is unchanged' }],
  };
  const harness = new CodexHarness({ command: process.env.CLEW_CODEX_BIN || 'codex' });
  const plan = validateExecutionPlan(
    await new CodexArchitect(harness).createPlan({ task, cwd: repo }),
  );
  const revision = runGit(['rev-parse', 'HEAD']).trim();
  const review = await new CodexReviewer(harness).review({
    task,
    cwd: repo,
    revision,
    evidence: [
      {
        type: 'command',
        command: 'git status --porcelain',
        result: 'passed',
        output: '',
        acceptanceCriteria: ['AC-1'],
      },
    ],
  });
  const clean = runGit(['status', '--porcelain']).trim() === '';

  if (!clean) throw new Error('read-only Codex role changed the fixture repository');
  if (review.verdict !== 'pass')
    throw new Error(`native reviewer did not pass the clean fixture: ${review.verdict}`);
  console.log(
    JSON.stringify(
      {
        architectStages: plan.stages.map((stage) => stage.id),
        reviewerVerdict: review.verdict,
        readOnlyWorkspaceUnchanged: clean,
      },
      null,
      2,
    ),
  );
  succeeded = true;
} finally {
  if (succeeded) rmSync(repo, { recursive: true, force: true });
  else console.error(`Live Codex roles fixture retained for diagnosis: ${repo}`);
}

function runGit(args) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
