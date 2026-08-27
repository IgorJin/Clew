import { randomUUID } from 'node:crypto';
import { effectiveProfile, assertTaskTransition } from './domain.js';
import {
  FakeHarness,
  CodexHarness,
  OpenCodeHarness,
  ExternalHarnessUnavailable,
} from './harness.js';

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
    if (row.state !== 'DRAFT' && row.state !== 'READY' && row.state !== 'FAILED')
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
    try {
      workspace = this.workspaceManager.create(taskId, 'worker', row.contract.base_ref);
      const run = {
        id: runId,
        taskId,
        stageId: 'worker',
        attempt: this.store.runs(taskId).length + 1,
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
        this.store.event(taskId, 'REVIEW_DEFERRED', {
          reason: 'review adapter not configured; fixture evidence is available',
        });
        this.store.setTaskState(taskId, 'READY');
      }
      return {
        taskId,
        runId,
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
}
