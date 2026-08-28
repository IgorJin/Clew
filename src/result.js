import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
export function buildResultManifest(store, taskId, { cwd = process.cwd(), revision = null } = {}) {
  const task = store.getTask(taskId);

  if (!task) throw new Error(`task not found: ${taskId}`);
  const runs = store.listRuns(taskId);
  const resultRevision = revision ?? runs.at(-1)?.commit_sha ?? null;

  if (!resultRevision) throw new Error('result revision is not available');
  const verifications = store.listVerification(taskId);
  const manifest = {
    schema: 'clew.result-manifest.v1',
    taskId,
    contract: task.contract,
    baseRevision: task.contract.base_ref,
    resultRevision,
    stages: runs.map((run) => ({
      stageId: run.stage_id,
      attempt: run.attempt,
      revision: run.commit_sha,
      runId: run.id,
    })),
    evidence: verifications
      .flatMap((report) => report.evidence ?? [])
      .map(({ output: _output, ...item }) => item),
    evidenceCoverage: [
      ...new Set(
        verifications
          .flatMap((report) => report.evidence ?? [])
          .flatMap((item) => item.acceptanceCriteria ?? []),
      ),
    ],
    review: store.latestReview(taskId),
    decisions: store.listOperatorActions(taskId),
    skippedChecks: verifications.flatMap((report) => report.skippedChecks ?? []),
    knownLimitations: [],
    usage: store.refreshUsageCosts(taskId),
    generatedAt: new Date().toISOString(),
  };
  const checksum = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');

  return { manifest, checksum, cwd: resolve(cwd) };
}
export function exportResult(
  store,
  taskId,
  outputDir,
  { cwd = process.cwd(), revision = null } = {},
) {
  const { manifest, checksum } = buildResultManifest(store, taskId, { cwd, revision });
  const target = resolve(outputDir);
  const primaryCheckout = resolve(cwd);

  if (target === primaryCheckout || target.startsWith(`${primaryCheckout}/`))
    throw new Error('refusing export inside the primary checkout');

  if (git(['status', '--porcelain'], cwd))
    throw new Error('refusing export from a dirty primary checkout');

  mkdirSync(target, { recursive: true });
  const base = manifest.baseRevision;
  const result = manifest.resultRevision;

  git(['diff', '--quiet', base, result], cwd);
  writeFileSync(join(target, `${taskId}.manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(target, `${taskId}.manifest.sha256`),
    `${checksum}  ${taskId}.manifest.json\n`,
  );
  writeFileSync(join(target, `${taskId}.patch`), git(['diff', `${base}..${result}`], cwd));
  git(['bundle', 'create', join(target, `${taskId}.bundle`), base, result], cwd);
  store.appendEvent(taskId, 'RESULT_EXPORTED', { outputDir: target, checksum, revision: result });

  return { taskId, outputDir: target, checksum, manifest };
}
