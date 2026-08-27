import { randomUUID } from 'node:crypto';
import {
  resolveProfile,
  assertValidTaskTransition,
  validateExecutionPlan,
  TASK_STATE,
  STAGE_STATUS,
  RUN_STATUS,
  PLAN_STATUS,
  classifyFailure,
  HARNESS_NAME,
  EXECUTION_MODE,
} from './domain.js';
import {
  FakeHarness,
  CodexHarness,
  OpenCodeHarness,
  ExternalHarnessUnavailable,
  HarnessInterruptedError,
} from './harness.js';
import { FakeReviewer, CodexReviewer } from './review.js';
import { FakeArchitect, CodexArchitect } from './architect.js';

export class Scheduler {
  constructor(
    store,
    workspaceManager,
    {
      harnessFactory = null,
      reviewerFactory = null,
      architectFactory = null,
      planFactory = null,
      requirePlanApproval = true,
      signal = null,
      interruptPollMs = 250,
      approvalPollMs = 250,
      approvalTimeoutMs = 30 * 60_000,
    } = {},
  ) {
    this.store = store;
    this.workspaceManager = workspaceManager;
    this.harnessFactory = harnessFactory;
    this.reviewerFactory = reviewerFactory;
    this.architectFactory = architectFactory;
    this.planFactory = planFactory;
    this.requirePlanApproval = requirePlanApproval;
    this.signal = signal;
    this.interruptPollMs = interruptPollMs;
    this.approvalPollMs = approvalPollMs;
    this.approvalTimeoutMs = approvalTimeoutMs;
    this.taskSignals = new Map();
    this.resumeSessions = new Map();
  }
  async runTask(
    taskId,
    requestedProfile,
    requestedHarness = null,
    requestedReviewHarness = null,
    requestedArchitect = null,
  ) {
    const taskSignal = this.getTaskSignal(taskId);

    try {
      return await this.runTaskInternal(
        taskId,
        requestedProfile,
        requestedHarness,
        requestedReviewHarness,
        requestedArchitect,
        taskSignal,
      );
    } finally {
      this.releaseTaskSignal(taskId);
    }
  }
  async runTaskInternal(
    taskId,
    requestedProfile,
    requestedHarness = null,
    requestedReviewHarness = null,
    requestedArchitect = null,
    taskSignal = this.getTaskSignal(taskId),
  ) {
    const row = this.store.getTask(taskId);

    if (!row) throw new Error(`task not found: ${taskId}`);
    const profile = resolveProfile(requestedProfile || row.contract.profile);
    const harnessName = requestedHarness || profile.harness;
    const harness = this.createHarnessAdapter(harnessName);

    if (profile.mode === EXECUTION_MODE.PARALLEL)
      return this.runDeep(
        row,
        profile,
        harness,
        harnessName,
        requestedReviewHarness,
        requestedArchitect,
        taskSignal,
      );
    if (
      ![TASK_STATE.DRAFT, TASK_STATE.QUEUED, TASK_STATE.READY, TASK_STATE.FAILED].includes(
        row.state,
      )
    )
      throw new Error(`task ${taskId} is already ${row.state}`);
    if (!this.store.listStages(taskId).length)
      this.store.addStage(taskId, 'worker', [], STAGE_STATUS.QUEUED);
    if (row.state !== TASK_STATE.QUEUED) {
      assertValidTaskTransition(row.state, TASK_STATE.QUEUED);
      this.store.setTaskState(taskId, TASK_STATE.QUEUED);
    }
    this.store.setTaskState(taskId, TASK_STATE.EXECUTING);
    this.store.setStage(taskId, 'worker', STAGE_STATUS.RUNNING);
    let workspace;
    const startedAt = new Date().toISOString();
    const runId = randomUUID();
    const attempt = this.store.listRuns(taskId).length + 1;

    try {
      workspace = this.workspaceManager.createWorktree(
        taskId,
        'worker',
        row.contract.base_ref,
        attempt,
      );
      const run = {
        id: runId,
        taskId,
        stageId: 'worker',
        attempt,
        status: RUN_STATUS.RUNNING,
        harness: harnessName,
        workspace: workspace.path,
        startedAt,
      };

      this.store.createRun(run);
      this.store.appendEvent(taskId, 'STAGE_RUN_STARTED', {
        ...run,
        branch: workspace.branch,
        baseSha: workspace.baseSha,
      });
      const result = await harness.run({
        task: row.contract,
        stageId: 'worker',
        cwd: workspace.path,
        onEvent: (event) => this.recordHarnessEvent(taskId, event, runId),
        signal: taskSignal,
        onApproval: (request) => this.awaitHarnessApproval(taskId, runId, request, taskSignal),
      });

      this.store.setRunIdentity(runId, result.sessionId ?? null, result.turnId ?? null);
      const status = this.workspaceManager.getWorktreeStatus(workspace.path);
      const revision = this.workspaceManager.commitWorktreeChanges
        ? this.workspaceManager.commitWorktreeChanges(
            workspace.path,
            `clew(${taskId}): worker attempt ${attempt}`,
          )
        : status.sha;

      this.store.appendEvent(taskId, 'VERIFICATION_RECORDED', {
        evidence: result.verification,
        revision,
      });
      this.store.finishRun(runId, RUN_STATUS.COMPLETED, revision);
      this.store.setStage(taskId, 'worker', STAGE_STATUS.COMPLETED);
      this.store.setTaskState(taskId, TASK_STATE.VERIFYING);
      this.store.setTaskState(taskId, profile.review ? TASK_STATE.REVIEWING : TASK_STATE.READY);
      if (profile.review) {
        const reviewer = this.createReviewerAdapter(requestedReviewHarness);
        const review = await reviewer.review({
          task: row.contract,
          evidence: result.verification,
          revision,
        });

        this.store.appendEvent(taskId, 'REVIEW_RECORDED', review);
        if (review.verdict === 'pass') this.store.setTaskState(taskId, TASK_STATE.READY);
        else {
          this.store.setTaskState(taskId, TASK_STATE.FAILED);
          this.store.appendEvent(taskId, 'CHANGES_REQUESTED', { findings: review.findings });
          if (attempt < profile.maxAttempts) {
            this.store.appendEvent(taskId, 'RETRY_SCHEDULED', {
              failedAttempt: attempt,
              nextAttempt: attempt + 1,
              reason: 'blocking review findings',
            });
            this.store.setStage(taskId, 'worker', STAGE_STATUS.QUEUED);
            this.store.setTaskState(taskId, TASK_STATE.QUEUED);

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
      if (error instanceof HarnessInterruptedError || error.code === 'HARNESS_INTERRUPTED') {
        this.store.finishRun(runId, RUN_STATUS.INTERRUPTED);
        this.store.setStage(taskId, 'worker', STAGE_STATUS.CANCELLED);
        this.store.setTaskState(taskId, TASK_STATE.CANCELLED);
        this.store.appendEvent(taskId, 'RUN_INTERRUPTED', { message: error.message });
        this.store.clearInterruptRequest(taskId);
        throw error;
      }
      if (runId) this.store.finishRun(runId, RUN_STATUS.FAILED);
      this.store.setStage(taskId, 'worker', STAGE_STATUS.FAILED);
      this.store.setTaskState(taskId, TASK_STATE.FAILED);
      this.store.appendEvent(taskId, 'RUN_FAILED', {
        message: error.message,
        failureClass: classifyFailure(error),
      });
      throw error;
    }
  }

  async runDeep(
    row,
    profile,
    harness,
    harnessName,
    requestedReviewHarness = null,
    requestedArchitect = null,
    taskSignal = null,
  ) {
    const taskId = row.id;

    if (
      ![
        TASK_STATE.DRAFT,
        TASK_STATE.PLAN_READY,
        TASK_STATE.QUEUED,
        TASK_STATE.RECOVERING,
        TASK_STATE.EXECUTING,
        TASK_STATE.VERIFYING,
        TASK_STATE.REVIEWING,
        TASK_STATE.WAITING_FOR_HUMAN,
        TASK_STATE.READY,
        TASK_STATE.FAILED,
        TASK_STATE.BLOCKED,
      ].includes(row.state)
    )
      throw new Error(`task ${taskId} is already ${row.state}`);
    const latestPlan = this.store.getLatestPlan(taskId);
    const persistedPlan = latestPlan?.status === PLAN_STATUS.REJECTED ? null : latestPlan;

    if (!persistedPlan) {
      this.store.appendEvent(taskId, 'ARCHITECT_STARTED', {
        architect: requestedArchitect || (this.planFactory ? 'plan-factory' : HARNESS_NAME.FAKE),
      });
    }
    const proposedPlan = persistedPlan
      ? persistedPlan.plan
      : this.planFactory
        ? await this.planFactory(row.contract, profile)
        : await this.createArchitectAdapter(requestedArchitect).createPlan({
            task: row.contract,
            cwd: this.workspaceManager.projectRoot ?? process.cwd(),
          });
    const plan = validateExecutionPlan(proposedPlan);
    const integrationStage = this.getIntegrationStage(plan);
    const planRecord =
      persistedPlan ??
      this.store.savePlan(
        taskId,
        plan,
        this.requirePlanApproval ? PLAN_STATUS.PENDING_APPROVAL : PLAN_STATUS.APPROVED,
      );

    if (!persistedPlan) {
      this.store.appendEvent(taskId, 'ARCHITECT_COMPLETED', {
        architect: requestedArchitect || (this.planFactory ? 'plan-factory' : HARNESS_NAME.FAKE),
        planVersion: planRecord.version,
      });
    }
    this.store.appendEvent(taskId, 'PLAN_VALIDATED', {
      version: planRecord.version,
      plan,
    });
    if (planRecord.status !== PLAN_STATUS.APPROVED) {
      if (row.state !== TASK_STATE.WAITING_FOR_HUMAN) {
        if (row.state !== TASK_STATE.PLAN_READY) {
          assertValidTaskTransition(row.state, TASK_STATE.PLAN_READY);
          this.store.setTaskState(taskId, TASK_STATE.PLAN_READY);
        }
        this.store.setTaskState(taskId, TASK_STATE.WAITING_FOR_HUMAN);
      }
      this.store.appendEvent(taskId, 'PLAN_APPROVAL_REQUIRED', {
        version: planRecord.version,
        gateId: 'deep-plan',
      });

      return {
        taskId,
        state: TASK_STATE.WAITING_FOR_HUMAN,
        attention: 'PLAN_APPROVAL_REQUIRED',
        planVersion: planRecord.version,
        plan,
      };
    }
    const existingStages = this.store.listStages(taskId);

    for (const stage of plan.stages)
      this.store.addStage(taskId, stage.id, stage.dependsOn, STAGE_STATUS.QUEUED);

    const isRecovery =
      existingStages.length > 0 &&
      [
        TASK_STATE.QUEUED,
        TASK_STATE.RECOVERING,
        TASK_STATE.EXECUTING,
        TASK_STATE.VERIFYING,
        TASK_STATE.REVIEWING,
        TASK_STATE.FAILED,
        TASK_STATE.BLOCKED,
      ].includes(row.state);
    let recoveredStages = new Map();

    if (isRecovery) {
      if (row.state !== TASK_STATE.RECOVERING) {
        assertValidTaskTransition(row.state, TASK_STATE.RECOVERING);
        this.store.setTaskState(taskId, TASK_STATE.RECOVERING);
      }
      this.store.appendEvent(taskId, 'TASK_RECOVERY_STARTED', {
        planVersion: planRecord.version,
        previousState: row.state,
      });
      recoveredStages = this.reconcilePlanStages(taskId, plan);
      this.store.setTaskState(taskId, TASK_STATE.EXECUTING);
    } else {
      for (const stage of plan.stages) this.store.setStage(taskId, stage.id, STAGE_STATUS.QUEUED);
      if (row.state !== TASK_STATE.QUEUED) {
        assertValidTaskTransition(row.state, TASK_STATE.QUEUED);
        this.store.setTaskState(taskId, TASK_STATE.QUEUED);
      }
      this.store.setTaskState(taskId, TASK_STATE.EXECUTING);
    }
    const execution = await this.executePlan({
      task: row.contract,
      plan,
      harness,
      harnessName,
      maxWorkers: profile.maxWorkers,
      integrationStageId: integrationStage.id,
      initialCompleted: recoveredStages,
      signal: taskSignal,
    });

    if (execution.failures.size) {
      this.store.setTaskState(taskId, TASK_STATE.FAILED);
      const failedStages = [...execution.failures.keys()];

      if (execution.blocked.includes(integrationStage.id)) {
        this.store.appendEvent(taskId, 'INTEGRATION_BLOCKED', {
          failedStages,
          blockedStages: execution.blocked,
        });
      }
      this.store.appendEvent(taskId, 'PLAN_EXECUTION_FAILED', {
        failedStages,
        blockedStages: execution.blocked,
      });
      throw new Error('one or more plan stages failed', {
        cause: execution.failures.values().next().value,
      });
    }
    const integrationResult = execution.completed.get(integrationStage.id);

    this.store.appendEvent(taskId, 'INTEGRATION_COMPLETED', {
      result: 'passed',
      revision: integrationResult.revision,
    });
    this.store.setTaskState(taskId, TASK_STATE.VERIFYING);
    this.store.setTaskState(taskId, TASK_STATE.REVIEWING);
    const reviewer = this.createReviewerAdapter(requestedReviewHarness);
    const review = await reviewer.review({
      task: row.contract,
      evidence: integrationResult.evidence,
      revision: integrationResult.revision,
    });

    this.store.appendEvent(taskId, 'REVIEW_RECORDED', review);
    this.store.setTaskState(
      taskId,
      review.verdict === 'pass' ? TASK_STATE.READY : TASK_STATE.FAILED,
    );

    return {
      taskId,
      plan,
      state: this.store.getTask(taskId).state,
      stages: this.store.listStages(taskId),
    };
  }

  reconcilePlanStages(taskId, plan) {
    const stageRecords = new Map(this.store.listStages(taskId).map((stage) => [stage.id, stage]));
    const runs = this.store.listRuns(taskId);
    const events = this.store.listEvents(taskId);
    const recoveredStages = new Map();
    const resumableSessions = new Map();
    const interruptRun = (run) => {
      if (run.session_id) resumableSessions.set(run.stage_id, run.session_id);
      this.store.finishRun(run.id, RUN_STATUS.INTERRUPTED, run.commit_sha);
      this.store.appendEvent(taskId, 'RUN_INTERRUPTED', {
        stageId: run.stage_id,
        runId: run.id,
        reason: 'scheduler process restarted before terminal run state',
      });
    };

    for (const stage of plan.stages) {
      const stageRecord = stageRecords.get(stage.id);
      const stageRuns = runs.filter((run) => run.stage_id === stage.id);
      const latestRun = stageRuns.at(-1);
      const runningStageRuns = stageRuns.filter((run) => run.status === RUN_STATUS.RUNNING);
      const canRecoverCompletedRun =
        stageRecord?.status === STAGE_STATUS.COMPLETED ||
        (stageRecord?.status === STAGE_STATUS.RUNNING &&
          latestRun?.status === RUN_STATUS.COMPLETED);

      if (canRecoverCompletedRun) {
        for (const runningRun of runningStageRuns) interruptRun(runningRun);
        if (!latestRun?.commit_sha) {
          this.store.setStage(taskId, stage.id, STAGE_STATUS.BLOCKED);
          this.store.setTaskState(taskId, TASK_STATE.BLOCKED);
          this.store.appendEvent(taskId, 'RECOVERY_BLOCKED', {
            stageId: stage.id,
            reason: 'completed stage has no persisted revision',
          });
          throw new Error(`cannot recover stage ${stage.id} without a persisted revision`);
        }
        const verificationEvent = events
          .toReversed()
          .find(
            (event) =>
              event.type === 'VERIFICATION_RECORDED' &&
              event.payload.stageId === stage.id &&
              event.payload.revision === latestRun.commit_sha,
          );

        this.store.setStage(taskId, stage.id, STAGE_STATUS.COMPLETED);
        recoveredStages.set(stage.id, {
          runId: latestRun.id,
          stageId: stage.id,
          workspace: { path: latestRun.workspace },
          revision: latestRun.commit_sha,
          evidence: verificationEvent?.payload.evidence ?? [],
        });
        this.store.appendEvent(taskId, 'STAGE_RECOVERED', {
          stageId: stage.id,
          runId: latestRun.id,
          revision: latestRun.commit_sha,
        });
        continue;
      }

      for (const runningRun of runningStageRuns) interruptRun(runningRun);
      if (stageRecord?.status !== STAGE_STATUS.QUEUED) {
        this.store.setStage(taskId, stage.id, STAGE_STATUS.QUEUED);
        this.store.appendEvent(taskId, 'STAGE_REQUEUED', {
          stageId: stage.id,
          previousStatus: stageRecord?.status,
        });
      }
    }

    this.resumeSessions.set(taskId, resumableSessions);

    return recoveredStages;
  }

  getIntegrationStage(plan) {
    const integrationStages = plan.stages.filter(
      (stage) => stage.kind === 'integration' || stage.id === 'integration',
    );

    if (integrationStages.length !== 1)
      throw new Error('a Deep plan must contain exactly one integration stage');
    const integrationStage = integrationStages[0];

    if (plan.stages.some((stage) => stage.dependsOn.includes(integrationStage.id)))
      throw new Error('the integration stage must be terminal');

    const stagesById = new Map(plan.stages.map((stage) => [stage.id, stage]));
    const ancestors = new Set();
    const collectAncestors = (stageId) => {
      for (const dependency of stagesById.get(stageId).dependsOn) {
        if (ancestors.has(dependency)) continue;
        ancestors.add(dependency);
        collectAncestors(dependency);
      }
    };

    collectAncestors(integrationStage.id);
    if (plan.stages.some((stage) => stage.id !== integrationStage.id && !ancestors.has(stage.id)))
      throw new Error('every Deep plan stage must feed the integration stage');

    return integrationStage;
  }

  async executePlan({
    task,
    plan,
    harness,
    harnessName,
    maxWorkers,
    integrationStageId,
    initialCompleted = new Map(),
    signal = null,
  }) {
    const pending = new Map(
      plan.stages
        .filter((stage) => !initialCompleted.has(stage.id))
        .map((stage) => [stage.id, stage]),
    );
    const running = new Map();
    const completed = new Map(initialCompleted);
    const failures = new Map();
    const blocked = [];
    const concurrencyLimit = Math.max(1, Number(maxWorkers) || 1);

    while (pending.size || running.size) {
      for (const [stageId, stage] of pending) {
        const hasBlockedDependency = stage.dependsOn.some(
          (dependency) => failures.has(dependency) || blocked.includes(dependency),
        );

        if (!hasBlockedDependency) continue;
        pending.delete(stageId);
        blocked.push(stageId);
        this.store.setStage(task.id, stageId, STAGE_STATUS.BLOCKED);
        this.store.appendEvent(task.id, 'STAGE_BLOCKED', {
          stageId,
          dependencies: stage.dependsOn,
        });
      }

      const runnableStages = [...pending.values()].filter((stage) =>
        stage.dependsOn.every((dependency) => completed.has(dependency)),
      );

      while (running.size < concurrencyLimit && runnableStages.length) {
        const stage = runnableStages.shift();

        pending.delete(stage.id);
        const stageExecution = this.executePlannedStage({
          task,
          plan,
          stage,
          harness,
          harnessName,
          completed,
          integrationStageId,
          signal,
          resumeSessionId: this.takeResumeSession(task.id, stage.id),
        }).then(
          (value) => ({ stageId: stage.id, status: 'fulfilled', value }),
          (error) => ({ stageId: stage.id, status: 'rejected', error }),
        );

        running.set(stage.id, stageExecution);
      }

      if (!running.size) {
        if (pending.size) throw new Error('validated plan reached an unrunnable state');
        break;
      }

      const settledStage = await Promise.race(running.values());

      running.delete(settledStage.stageId);
      if (settledStage.status === 'fulfilled')
        completed.set(settledStage.stageId, settledStage.value);
      else {
        if (settledStage.error?.code === 'HARNESS_INTERRUPTED') {
          this.store.setTaskState(task.id, TASK_STATE.CANCELLED);
          this.store.clearInterruptRequest(task.id);
          for (const pendingStage of pending.values())
            this.store.setStage(task.id, pendingStage.id, STAGE_STATUS.CANCELLED);
          await Promise.allSettled(running.values());
          throw settledStage.error;
        }
        failures.set(settledStage.stageId, settledStage.error);
      }
    }

    return { completed, failures, blocked };
  }

  async executePlannedStage({
    task,
    plan,
    stage,
    harness,
    harnessName,
    completed,
    integrationStageId,
    signal = null,
    resumeSessionId = null,
  }) {
    let workspace;
    const attempt =
      this.store.listRuns(task.id).filter((run) => run.stage_id === stage.id).length + 1;

    if (stage.id === integrationStageId) {
      this.store.appendEvent(task.id, 'INTEGRATION_STARTED', {
        dependencies: stage.dependsOn,
      });
    }
    try {
      workspace = this.workspaceManager.createWorktree(task.id, stage.id, task.base_ref, attempt);
      const ancestorStageIds = this.getAncestorStageIds(plan, stage.id);
      const dependencyRevisions = ancestorStageIds.map(
        (ancestorId) => completed.get(ancestorId).revision,
      );

      if (dependencyRevisions.length && this.workspaceManager.integrateCommits) {
        const integrationResult = this.workspaceManager.integrateCommits(
          workspace.path,
          dependencyRevisions,
        );

        this.store.appendEvent(task.id, 'STAGE_DEPENDENCIES_INTEGRATED', {
          stageId: stage.id,
          sourceStages: ancestorStageIds,
          ...integrationResult,
        });
        if (stage.id === integrationStageId)
          this.store.appendEvent(task.id, 'COMMITS_INTEGRATED', integrationResult);
      }
    } catch (error) {
      this.store.setStage(task.id, stage.id, STAGE_STATUS.FAILED);
      const eventType =
        stage.id === integrationStageId
          ? error.name === 'IntegrationConflictError'
            ? 'INTEGRATION_CONFLICT'
            : 'INTEGRATION_FAILED'
          : 'STAGE_PREPARATION_FAILED';

      this.store.appendEvent(task.id, eventType, {
        stageId: stage.id,
        message: error.message,
        commit: error.commit,
      });
      throw error;
    }
    try {
      return await this.executeStage({
        task,
        stage,
        harness,
        harnessName,
        attempt,
        workspace,
        signal,
        resumeSessionId,
      });
    } catch (error) {
      if (stage.id === integrationStageId)
        this.store.appendEvent(task.id, 'INTEGRATION_FAILED', {
          stageId: stage.id,
          message: error.message,
        });
      throw error;
    }
  }

  getAncestorStageIds(plan, stageId) {
    const stagesById = new Map(plan.stages.map((stage) => [stage.id, stage]));
    const visited = new Set();
    const ordered = [];
    const collect = (currentStageId) => {
      for (const dependency of stagesById.get(currentStageId).dependsOn) {
        if (visited.has(dependency)) continue;
        collect(dependency);
        visited.add(dependency);
        ordered.push(dependency);
      }
    };

    collect(stageId);

    return ordered;
  }

  async executeStage({
    task,
    stage,
    harness,
    harnessName,
    attempt,
    workspace = null,
    signal = null,
    resumeSessionId = null,
  }) {
    const taskId = task.id;
    const runId = randomUUID();

    this.store.setStage(taskId, stage.id, STAGE_STATUS.RUNNING);
    const stageWorkspace =
      workspace ?? this.workspaceManager.createWorktree(taskId, stage.id, task.base_ref, attempt);
    const run = {
      id: runId,
      taskId,
      stageId: stage.id,
      attempt,
      status: RUN_STATUS.RUNNING,
      harness: harnessName,
      workspace: stageWorkspace.path,
      startedAt: new Date().toISOString(),
    };

    this.store.createRun(run);
    this.store.appendEvent(taskId, 'STAGE_RUN_STARTED', {
      ...run,
      branch: stageWorkspace.branch,
      baseSha: stageWorkspace.baseSha,
    });
    try {
      const result = await harness.run({
        task: { ...task, title: stage.goal },
        stageId: stage.id,
        cwd: stageWorkspace.path,
        onEvent: (event) => this.recordHarnessEvent(taskId, event, runId),
        signal,
        resumeSessionId,
        onApproval: (request) => this.awaitHarnessApproval(taskId, runId, request, signal),
      });
      const status = this.workspaceManager.getWorktreeStatus(stageWorkspace.path);
      const revision = this.workspaceManager.commitWorktreeChanges
        ? this.workspaceManager.commitWorktreeChanges(
            stageWorkspace.path,
            `clew(${taskId}): ${stage.id} attempt ${attempt}`,
          )
        : status.sha;

      this.store.setRunIdentity(runId, result.sessionId ?? null, result.turnId ?? null);
      this.store.finishRun(runId, RUN_STATUS.COMPLETED, revision);
      this.store.setStage(taskId, stage.id, STAGE_STATUS.COMPLETED);
      this.store.appendEvent(taskId, 'VERIFICATION_RECORDED', {
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
      if (error?.code === 'HARNESS_INTERRUPTED') {
        this.store.finishRun(runId, RUN_STATUS.INTERRUPTED);
        this.store.setStage(taskId, stage.id, STAGE_STATUS.CANCELLED);
        this.store.appendEvent(taskId, 'STAGE_RUN_INTERRUPTED', {
          stageId: stage.id,
          message: error.message,
        });
        throw error;
      }
      this.store.finishRun(runId, RUN_STATUS.FAILED);
      this.store.setStage(taskId, stage.id, STAGE_STATUS.FAILED);
      this.store.appendEvent(taskId, 'STAGE_RUN_FAILED', {
        stageId: stage.id,
        message: error.message,
        failureClass: classifyFailure(error),
      });
      throw error;
    }
  }

  createHarnessAdapter(harnessName) {
    if (this.harnessFactory) return this.harnessFactory(harnessName);
    if (harnessName === HARNESS_NAME.FAKE) return new FakeHarness();
    if (harnessName === HARNESS_NAME.CODEX) return new CodexHarness();
    if (harnessName === HARNESS_NAME.OPENCODE) return new OpenCodeHarness();

    return new ExternalHarnessUnavailable(harnessName);
  }

  getTaskSignal(taskId) {
    const existing = this.taskSignals.get(taskId);

    if (existing) return existing.controller.signal;
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    const pollTimer = setInterval(() => {
      if (this.store.isInterruptRequested(taskId)) controller.abort();
    }, this.interruptPollMs);

    pollTimer.unref?.();
    this.signal?.addEventListener('abort', onExternalAbort, { once: true });
    if (this.signal?.aborted || this.store.isInterruptRequested(taskId)) controller.abort();
    this.taskSignals.set(taskId, { controller, pollTimer, onExternalAbort });

    return controller.signal;
  }

  releaseTaskSignal(taskId) {
    const entry = this.taskSignals.get(taskId);

    if (!entry) return;
    clearInterval(entry.pollTimer);
    this.signal?.removeEventListener('abort', entry.onExternalAbort);
    this.taskSignals.delete(taskId);
  }

  awaitHarnessApproval(taskId, runId, request, signal) {
    const approvalId = `${taskId}:${runId}:${request.id}`;

    this.store.createHarnessApproval({
      id: approvalId,
      taskId,
      runId,
      method: request.method,
      params: request.params,
    });

    return new Promise((resolve, reject) => {
      let pollTimer;
      const timeoutTimer = setTimeout(() => {
        cleanup();
        reject(new Error(`harness approval timed out: ${approvalId}`));
      }, this.approvalTimeoutMs);
      const cleanup = () => {
        clearInterval(pollTimer);
        clearTimeout(timeoutTimer);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(new HarnessInterruptedError('harness approval'));
      };
      const poll = () => {
        const approval = this.store.getHarnessApproval(approvalId);

        if (!approval?.decision) return;
        cleanup();
        resolve(approval.decision);
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      pollTimer = setInterval(poll, this.approvalPollMs);
      pollTimer.unref?.();
      poll();
    });
  }

  recordHarnessEvent(taskId, event, runId = null) {
    const eventType = event.type.startsWith('HARNESS_') ? event.type : `HARNESS_${event.type}`;

    this.store.appendEvent(taskId, eventType, event);
    if (runId && event.sessionId)
      this.store.setRunIdentity(runId, event.sessionId, event.turnId ?? null);
  }

  takeResumeSession(taskId, stageId) {
    const sessions = this.resumeSessions.get(taskId);
    const sessionId = sessions?.get(stageId) ?? null;

    sessions?.delete(stageId);

    return sessionId;
  }

  createReviewerAdapter(reviewerName) {
    if (this.reviewerFactory) return this.reviewerFactory(reviewerName);

    return reviewerName === HARNESS_NAME.CODEX
      ? new CodexReviewer(new CodexHarness())
      : new FakeReviewer();
  }

  createArchitectAdapter(architectName) {
    if (this.architectFactory) return this.architectFactory(architectName);

    return architectName === HARNESS_NAME.CODEX
      ? new CodexArchitect(new CodexHarness())
      : new FakeArchitect();
  }
}
