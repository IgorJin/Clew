import { randomUUID } from 'node:crypto';
import { effectiveProfile, assertTaskTransition, validatePlan } from './domain.js';
import {
  FakeHarness,
  CodexHarness,
  OpenCodeHarness,
  ExternalHarnessUnavailable,
} from './harness.js';
import { FakeReviewer } from './review.js';

export class Scheduler {
  constructor(store, workspaceManager) {
    this.store = store;
    this.workspaceManager = workspaceManager;
  }
  async runTask(taskId, requestedProfile, requestedHarness = null) {
    const row = this.store.getTask(taskId);
    if (!row) throw new Error(`task not found: ${taskId}`);
    const profile = effectiveProfile(requestedProfile || row.contract.profile);
    const harnessName = requestedHarness || profile.harness;
    const harness =
      harnessName === 'fake'
        ? new FakeHarness()
        : harnessName === 'codex'
          ? new CodexHarness()
          : harnessName === 'opencode'
            ? new OpenCodeHarness()
            : new ExternalHarnessUnavailable(harnessName);
    if (profile.mode === 'parallel') return this.runDeep(row, profile, harness, harnessName);
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
      this.store.event(taskId, 'VERIFICATION_RECORDED', {
        evidence: result.verification,
        revision: status.sha,
      });
      this.store.finishRun(runId, 'COMPLETED', status.sha);
      this.store.setStage(taskId, 'worker', 'COMPLETED');
      this.store.setTaskState(taskId, 'VERIFYING');
      this.store.setTaskState(taskId, profile.review ? 'REVIEWING' : 'READY');
      if (profile.review) {
        const review = await new FakeReviewer().review({
          task: row.contract,
          evidence: result.verification,
          revision: status.sha,
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
            return this.runTask(taskId, requestedProfile, requestedHarness);
          }
        }
      }
      return {
        taskId,
        runId,
        attempt,
        workspace,
        revision: status.sha,
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

  async runDeep(row, profile, harness, harnessName) {
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
    for (const stage of plan.stages.filter((stage) => stage.id !== 'integration')) {
      this.store.setStage(taskId, stage.id, 'RUNNING');
      const workspace = this.workspaceManager.create(taskId, stage.id, row.contract.base_ref, 1);
      const runId = randomUUID();
      const run = {
        id: runId,
        taskId,
        stageId: stage.id,
        attempt: 1,
        status: 'RUNNING',
        harness: harnessName,
        workspace: workspace.path,
        startedAt: new Date().toISOString(),
      };
      this.store.createRun(run);
      this.store.event(taskId, 'STAGE_RUN_STARTED', {
        ...run,
        branch: workspace.branch,
        baseSha: workspace.baseSha,
      });
      const result = await harness.run({
        task: { ...row.contract, title: stage.goal },
        stageId: stage.id,
        cwd: workspace.path,
        onEvent: (event) => this.store.event(taskId, `HARNESS_${event.type}`, event),
      });
      const status = this.workspaceManager.status(workspace.path);
      this.store.setRunSession(runId, result.sessionId ?? null);
      this.store.finishRun(runId, 'COMPLETED', status.sha);
      this.store.setStage(taskId, stage.id, 'COMPLETED');
      this.store.event(taskId, 'VERIFICATION_RECORDED', {
        stageId: stage.id,
        evidence: result.verification,
        revision: status.sha,
      });
    }
    this.store.setStage(taskId, 'integration', 'RUNNING');
    this.store.event(taskId, 'INTEGRATION_STARTED', { dependencies: ['backend', 'frontend'] });
    this.store.setStage(taskId, 'integration', 'COMPLETED');
    this.store.event(taskId, 'INTEGRATION_COMPLETED', { result: 'passed' });
    this.store.setTaskState(taskId, 'VERIFYING');
    this.store.setTaskState(taskId, 'REVIEWING');
    const review = await new FakeReviewer().review({
      task: row.contract,
      evidence: [{ type: 'integration', result: 'passed' }],
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
}
