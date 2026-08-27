import { randomUUID } from 'node:crypto';
import { effectiveProfile, assertTaskTransition, validatePlan } from './domain.js';
import {
  FakeHarness,
  CodexHarness,
  OpenCodeHarness,
  ExternalHarnessUnavailable,
} from './harness.js';
import { FakeReviewer, CodexReviewer } from './review.js';

export class Scheduler {
  constructor(store, workspaceManager, { harnessFactory = null, reviewerFactory = null } = {}) {
    this.store = store;
    this.workspaceManager = workspaceManager;
    this.harnessFactory = harnessFactory;
    this.reviewerFactory = reviewerFactory;
  }
  async runTask(taskId, requestedProfile, requestedHarness = null, requestedReviewHarness = null) {
    const row = this.store.getTask(taskId);
    if (!row) throw new Error(`task not found: ${taskId}`);
    const profile = effectiveProfile(requestedProfile || row.contract.profile);
    const harnessName = requestedHarness || profile.harness;
    const harness = this.createHarness(harnessName);
    if (profile.mode === 'parallel')
      return this.runDeep(row, profile, harness, harnessName, requestedReviewHarness);
    if (!['DRAFT', 'QUEUED', 'READY', 'FAILED'].includes(row.state))
      throw new Error(`task ${taskId} is already ${row.state}`);
    if (!this.store.stages(taskId).length) this.store.addStage(taskId, 'worker', [], 'QUEUED');
    if (row.state !== 'QUEUED') {
      assertTaskTransition(row.state, 'QUEUED');
      this.store.setTaskState(taskId, 'QUEUED');
    }
    this.store.setTaskState(taskId, 'EXECUTING');
    this.store.setStage(taskId, 'worker', 'RUNNING');
    let workspace;
    const startedAt = new Date().toISOString();
    const runId = randomUUID();
    const attempt = this.store.runs(taskId).length + 1;
    try {
      workspace = this.workspaceManager.create(taskId, 'worker', row.contract.base_ref, attempt);
      const run = {
        id: runId,
        taskId,
        stageId: 'worker',
        attempt,
        status: 'RUNNING',
        harness: harnessName,
        workspace: workspace.path,
        startedAt,
      };
      this.store.createRun(run);
      this.store.event(taskId, 'STAGE_RUN_STARTED', {
        ...run,
        branch: workspace.branch,
        baseSha: workspace.baseSha,
      });
      const result = await harness.run({
        task: row.contract,
        stageId: 'worker',
        cwd: workspace.path,
        onEvent: (event) => this.store.event(taskId, `HARNESS_${event.type}`, event),
      });
      this.store.setRunSession(runId, result.sessionId ?? null);
      const status = this.workspaceManager.status(workspace.path);
      const revision = this.workspaceManager.commit
        ? this.workspaceManager.commit(workspace.path, `clew(${taskId}): worker attempt ${attempt}`)
        : status.sha;
      this.store.event(taskId, 'VERIFICATION_RECORDED', {
        evidence: result.verification,
        revision,
      });
      this.store.finishRun(runId, 'COMPLETED', revision);
      this.store.setStage(taskId, 'worker', 'COMPLETED');
      this.store.setTaskState(taskId, 'VERIFYING');
      this.store.setTaskState(taskId, profile.review ? 'REVIEWING' : 'READY');
      if (profile.review) {
        const reviewer = this.createReviewer(requestedReviewHarness);
        const review = await reviewer.review({
          task: row.contract,
          evidence: result.verification,
          revision,
        });
        this.store.event(taskId, 'REVIEW_RECORDED', review);
        if (review.verdict === 'pass') this.store.setTaskState(taskId, 'READY');
        else {
          this.store.setTaskState(taskId, 'FAILED');
          this.store.event(taskId, 'CHANGES_REQUESTED', { findings: review.findings });
          if (attempt < profile.maxAttempts) {
            this.store.event(taskId, 'RETRY_SCHEDULED', {
              failedAttempt: attempt,
              nextAttempt: attempt + 1,
              reason: 'blocking review findings',
            });
            this.store.setStage(taskId, 'worker', 'QUEUED');
            this.store.setTaskState(taskId, 'QUEUED');
            return this.runTask(taskId, requestedProfile, requestedHarness, requestedReviewHarness);
          }
        }
      }
      return {
        taskId,
        runId,
        attempt,
        workspace,
        revision,
        state: this.store.getTask(taskId).state,
      };
    } catch (error) {
      if (runId) this.store.finishRun(runId, 'FAILED');
      this.store.setStage(taskId, 'worker', 'FAILED');
      this.store.setTaskState(taskId, 'FAILED');
      this.store.event(taskId, 'RUN_FAILED', { message: error.message });
      throw error;
    }
  }

  async runDeep(row, profile, harness, harnessName, requestedReviewHarness = null) {
    const taskId = row.id;
    if (!['DRAFT', 'QUEUED', 'READY', 'FAILED'].includes(row.state))
      throw new Error(`task ${taskId} is already ${row.state}`);
    const plan = validatePlan({
      parallelizable: true,
      stages: [
        { id: 'backend', goal: `${row.contract.goal} (backend)`, dependsOn: [] },
        { id: 'frontend', goal: `${row.contract.goal} (frontend)`, dependsOn: [] },
        {
          id: 'integration',
          goal: `${row.contract.goal} (integration)`,
          dependsOn: ['backend', 'frontend'],
        },
      ],
    });
    this.store.event(taskId, 'PLAN_VALIDATED', { plan });
    if (row.state === 'DRAFT' || row.state === 'FAILED') this.store.setTaskState(taskId, 'QUEUED');
    this.store.setTaskState(taskId, 'EXECUTING');
    for (const stage of plan.stages)
      this.store.addStage(taskId, stage.id, stage.dependsOn, 'QUEUED');
    const workerStages = plan.stages.filter((stage) => stage.id !== 'integration');
    const workerResults = await Promise.allSettled(
      workerStages.map((stage) =>
        this.runStage({ task: row.contract, stage, harness, harnessName, attempt: 1 }),
      ),
    );
    const failures = workerResults.filter((result) => result.status === 'rejected');
    if (failures.length) {
      this.store.setStage(taskId, 'integration', 'BLOCKED');
      this.store.event(taskId, 'INTEGRATION_BLOCKED', {
        failedStages: workerStages
          .filter((_, index) => workerResults[index].status === 'rejected')
          .map((stage) => stage.id),
      });
      this.store.setTaskState(taskId, 'FAILED');
      throw new Error('one or more parallel stages failed');
    }
    const completedWorkers = workerResults.map((result) => result.value);
    this.store.event(taskId, 'INTEGRATION_STARTED', { dependencies: ['backend', 'frontend'] });
    const integration = plan.stages.find((stage) => stage.id === 'integration');
    let integrationResult;
    try {
      const integrationWorkspace = this.workspaceManager.create(
        taskId,
        integration.id,
        row.contract.base_ref,
        1,
      );
      if (this.workspaceManager.integrate) {
        const integrationGitResult = this.workspaceManager.integrate(
          integrationWorkspace.path,
          completedWorkers.map((result) => result.revision),
        );
        this.store.event(taskId, 'COMMITS_INTEGRATED', integrationGitResult);
      }
      integrationResult = await this.runStage({
        task: row.contract,
        stage: integration,
        harness,
        harnessName,
        attempt: 1,
        workspace: integrationWorkspace,
      });
    } catch (error) {
      this.store.setStage(taskId, 'integration', 'FAILED');
      this.store.setTaskState(taskId, 'FAILED');
      this.store.event(
        taskId,
        error.name === 'IntegrationConflictError' ? 'INTEGRATION_CONFLICT' : 'INTEGRATION_FAILED',
        { message: error.message, commit: error.commit },
      );
      throw error;
    }
    this.store.event(taskId, 'INTEGRATION_COMPLETED', {
      result: 'passed',
      revision: integrationResult.revision,
    });
    this.store.setTaskState(taskId, 'VERIFYING');
    this.store.setTaskState(taskId, 'REVIEWING');
    const reviewer = this.createReviewer(requestedReviewHarness);
    const review = await reviewer.review({
      task: row.contract,
      evidence: integrationResult.evidence,
      revision: integrationResult.revision,
    });
    this.store.event(taskId, 'REVIEW_RECORDED', review);
    this.store.setTaskState(taskId, review.verdict === 'pass' ? 'READY' : 'FAILED');
    return {
      taskId,
      plan,
      state: this.store.getTask(taskId).state,
      stages: this.store.stages(taskId),
    };
  }

  async runStage({ task, stage, harness, harnessName, attempt, workspace = null }) {
    const taskId = task.id;
    const runId = randomUUID();
    this.store.setStage(taskId, stage.id, 'RUNNING');
    const stageWorkspace =
      workspace ?? this.workspaceManager.create(taskId, stage.id, task.base_ref, attempt);
    const run = {
      id: runId,
      taskId,
      stageId: stage.id,
      attempt,
      status: 'RUNNING',
      harness: harnessName,
      workspace: stageWorkspace.path,
      startedAt: new Date().toISOString(),
    };
    this.store.createRun(run);
    this.store.event(taskId, 'STAGE_RUN_STARTED', {
      ...run,
      branch: stageWorkspace.branch,
      baseSha: stageWorkspace.baseSha,
    });
    try {
      const result = await harness.run({
        task: { ...task, title: stage.goal },
        stageId: stage.id,
        cwd: stageWorkspace.path,
        onEvent: (event) => this.store.event(taskId, `HARNESS_${event.type}`, event),
      });
      const status = this.workspaceManager.status(stageWorkspace.path);
      const revision = this.workspaceManager.commit
        ? this.workspaceManager.commit(
            stageWorkspace.path,
            `clew(${taskId}): ${stage.id} attempt ${attempt}`,
          )
        : status.sha;
      this.store.setRunSession(runId, result.sessionId ?? null);
      this.store.finishRun(runId, 'COMPLETED', revision);
      this.store.setStage(taskId, stage.id, 'COMPLETED');
      this.store.event(taskId, 'VERIFICATION_RECORDED', {
        stageId: stage.id,
        evidence: result.verification,
        revision,
      });
      return {
        runId,
        stageId: stage.id,
        workspace: stageWorkspace,
        revision,
        evidence: result.verification,
      };
    } catch (error) {
      this.store.finishRun(runId, 'FAILED');
      this.store.setStage(taskId, stage.id, 'FAILED');
      this.store.event(taskId, 'STAGE_RUN_FAILED', { stageId: stage.id, message: error.message });
      throw error;
    }
  }

  createHarness(name) {
    if (this.harnessFactory) return this.harnessFactory(name);
    if (name === 'fake') return new FakeHarness();
    if (name === 'codex') return new CodexHarness();
    if (name === 'opencode') return new OpenCodeHarness();
    return new ExternalHarnessUnavailable(name);
  }

  createReviewer(name) {
    if (this.reviewerFactory) return this.reviewerFactory(name);
    return name === 'codex' ? new CodexReviewer(new CodexHarness()) : new FakeReviewer();
  }
}
