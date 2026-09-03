import { FakeHarness, CodexHarness, OpenCodeHarness } from './harness.js';
import { FakeReviewer, CodexReviewer } from './review.js';
import { FakeArchitect, CodexArchitect } from './architect.js';
import { join } from 'node:path';
import { GitWorktreeManager } from './workspace.js';

function boundedText(value, limit = 4_000) {
  return typeof value === 'string' ? value.slice(0, limit) : undefined;
}

function safeEvidence(evidence = []) {
  return evidence.slice(0, 100).map((item) => ({
    type: item.type ?? 'command',
    command: boundedText(item.command, 1_000) ?? 'verification',
    result: item.result === 'passed' ? 'passed' : 'failed',
    exitCode: Number.isInteger(item.exitCode) ? item.exitCode : null,
    ...(item.startedAt ? { startedAt: item.startedAt } : {}),
    ...(item.endedAt ? { endedAt: item.endedAt } : {}),
    ...(Array.isArray(item.acceptanceCriteria)
      ? { acceptanceCriteria: item.acceptanceCriteria.slice(0, 100) }
      : {}),
  }));
}

function safeReview(review) {
  if (!review || typeof review !== 'object') return undefined;

  return {
    verdict: review.verdict,
    revision: boundedText(review.revision, 128),
    findings: Array.isArray(review.findings)
      ? review.findings.slice(0, 100).map((finding) => ({
          severity: finding.severity,
          criterion: boundedText(finding.criterion, 256) ?? 'unknown',
          reason: boundedText(finding.reason, 2_000) ?? 'Runner reviewer finding',
          evidence: boundedText(finding.evidence, 2_000) ?? null,
          target: boundedText(finding.target, 1_000) ?? null,
        }))
      : [],
  };
}

function safePlan(plan) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.stages)) return undefined;

  return {
    parallelizable: plan.parallelizable === true,
    stages: plan.stages.slice(0, 100).map((stage) => ({
      id: boundedText(stage.id, 128),
      kind: boundedText(stage.kind, 128),
      ...(stage.harness ? { harness: boundedText(stage.harness, 64) } : {}),
      goal: boundedText(stage.goal, 4_000),
      dependsOn: Array.isArray(stage.dependsOn)
        ? stage.dependsOn.slice(0, 100).map((dependency) => boundedText(dependency, 128))
        : [],
    })),
  };
}

export class RunnerExecutionPort {
  constructor({
    workspaces = [],
    worktreeRoot = null,
    harnessFactory = null,
    adapterConfig = {},
  } = {}) {
    this.workspaces = new Map(workspaces.map((workspace) => [workspace.id, workspace.path]));
    this.workspaceManagers = new Map(
      worktreeRoot
        ? workspaces.map((workspace) => [
            workspace.id,
            new GitWorktreeManager(
              join(worktreeRoot, workspace.id.replace(/[^A-Za-z0-9_.-]/g, '-')),
              workspace.path,
            ),
          ])
        : [],
    );
    this.harnessFactory = harnessFactory;
    this.adapterConfig = adapterConfig;
    this.active = new Map();
  }

  capabilities() {
    return Object.freeze({ execute: true, terminal: { access: 'runner_local' } });
  }

  createHarness(name) {
    if (this.harnessFactory) return this.harnessFactory(name);
    if (name === 'fake') return new FakeHarness();
    if (name === 'codex')
      return new CodexHarness({
        command: this.adapterConfig.codexBin ?? 'codex',
        openDesktop: this.adapterConfig.openCodexDesktop ?? false,
      });
    if (name === 'opencode')
      return new OpenCodeHarness({ baseUrl: this.adapterConfig.openCodeUrl });
    throw new Error(`unsupported Runner harness: ${name}`);
  }

  createReviewer(name) {
    if (name === 'fake') return new FakeReviewer();
    if (name === 'codex') return new CodexReviewer(this.createHarness('codex'));
    throw new Error(`unsupported Runner reviewer: ${name}`);
  }

  createArchitect(name) {
    if (name === 'fake') return new FakeArchitect();
    if (name === 'codex') return new CodexArchitect(this.createHarness('codex'));
    throw new Error(`unsupported Runner architect: ${name}`);
  }

  async accept(offer, { signal, onEvent } = {}) {
    const projectRoot = this.workspaces.get(offer.workspaceId);

    if (!projectRoot)
      throw new Error(`Runner workspace mapping is unavailable: ${offer.workspaceId}`);
    const requirements = offer.requirements ?? {};
    const task = requirements.task;

    if (!task || typeof task !== 'object')
      throw new Error('Runner lease requirements must contain a bounded Task contract');
    const harnessName = offer.harness ?? 'fake';
    const operation = requirements.operation ?? 'execute';
    const key = `${offer.leaseId}:${offer.epoch}`;

    this.active.set(key, { operation, harness: harnessName });
    try {
      if (operation === 'plan') {
        const plan = await this.createArchitect(harnessName).createPlan({ task, cwd: projectRoot });

        return {
          status: 'completed',
          revision: `runner-plan:${offer.leaseId}`,
          summary: 'Runner architecture plan completed',
          evidence: [
            {
              type: 'runner_operation',
              command: 'architect.createPlan',
              result: 'passed',
              exitCode: 0,
            },
          ],
          plan: safePlan(plan),
        };
      }
      if (operation !== 'execute') throw new Error(`unsupported Runner operation: ${operation}`);
      const workspaceManager = this.workspaceManagers.get(offer.workspaceId);
      const workspace = workspaceManager
        ? workspaceManager.createWorktree(
            task.id,
            offer.stageId,
            task.base_ref ?? 'HEAD',
            offer.attempt,
          )
        : { path: projectRoot };
      const dependencyRevisions = Array.isArray(requirements.dependencyRevisions)
        ? requirements.dependencyRevisions
        : [];

      if (workspaceManager && dependencyRevisions.length)
        workspaceManager.integrateCommits(workspace.path, dependencyRevisions);
      const harness = this.createHarness(harnessName);
      const result = await harness.run({
        task,
        stageId: offer.stageId,
        runId: offer.runId,
        cwd: workspace.path,
        signal,
        readOnly: requirements.readOnly === true,
        model: requirements.model ?? null,
        resumeSessionId: requirements.resumeSessionId ?? null,
        onEvent,
        onApproval: this.adapterConfig.onApproval,
      });
      const revision = boundedText(
        workspaceManager
          ? workspaceManager.commitWorktreeChanges(
              workspace.path,
              `clew(${task.id}): ${offer.stageId} attempt ${offer.attempt}`,
            )
          : (result.revision ?? requirements.revision),
        128,
      );
      const evidence = safeEvidence(result.verification);
      const review = requirements.review
        ? await this.createReviewer(requirements.reviewHarness ?? harnessName).review({
            task,
            evidence,
            revision,
            cwd: workspace.path,
          })
        : null;

      return {
        status: 'completed',
        revision,
        summary: boundedText(result.rationale ?? 'Runner execution completed'),
        evidence,
        usage: result.usage ?? undefined,
        sessionId: boundedText(result.sessionId, 128),
        turnId: boundedText(result.turnId, 128),
        ...(review ? { review: safeReview(review) } : {}),
      };
    } finally {
      this.active.delete(key);
    }
  }

  async cancel() {}

  async shutdown() {
    this.active.clear();
  }
}

export class FakeRunnerExecutionPort extends RunnerExecutionPort {
  constructor({ workspaces = [{ id: 'default', path: process.cwd() }], resultFactory } = {}) {
    super({ workspaces, harnessFactory: () => new FakeHarness() });
    this.resultFactory = resultFactory;
  }

  async accept(offer, context) {
    if (this.resultFactory) return this.resultFactory(offer, context);

    return super.accept(offer, context);
  }
}
