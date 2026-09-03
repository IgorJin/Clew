import { randomUUID } from 'node:crypto';
import {
  resolveProfile,
  assertValidTaskTransition,
  validateExecutionPlan,
  validateVerificationReport,
  TASK_STATE,
  STAGE_STATUS,
  RUN_STATUS,
  PLAN_STATUS,
  REVIEW_VERDICT,
  FAILURE_CLASS,
  classifyFailure,
  HARNESS_NAME,
  EXECUTION_MODE,
} from './domain.js';
import {
  APPROVAL_DECISION,
  FakeHarness,
  CodexHarness,
  OpenCodeHarness,
  ExternalHarnessUnavailable,
  HarnessInterruptedError,
} from './harness.js';
import { FakeReviewer, CodexReviewer } from './review.js';
import { FakeArchitect, CodexArchitect } from './architect.js';
import { verificationEnvironment } from './trust.js';
import { createCodexLiveEndpoint, createRuntimeNamespace } from './runtime.js';
import { RUNNER_MESSAGE_KIND, createRunnerEnvelope } from './runner-protocol.js';

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
      adapterConfig = {},
      executionPort = null,
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
    this.adapterConfig = adapterConfig;
    this.executionPort = executionPort;
    this.taskSignals = new Map();
    this.resumeSessions = new Map();
  }
  async runTask(
    taskId,
    requestedProfile,
    requestedHarness = null,
    requestedReviewHarness = null,
    requestedArchitect = null,
    resumeSessionId = null,
    retryFeedback = [],
    options = {},
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
        resumeSessionId,
        retryFeedback,
        options,
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
    resumeSessionId = null,
    retryFeedback = [],
    options = {},
  ) {
    const row = this.store.getTask(taskId);

    if (!row) throw new Error(`task not found: ${taskId}`);
    const resolvedProfile = resolveProfile(requestedProfile || row.contract.profile);
    const harnessName = requestedHarness || resolvedProfile.harness;
    const profile = { ...resolvedProfile, harness: harnessName };

    const pairedExecution = this.executionPort?.describe().mode === 'paired';
    const harness = pairedExecution ? null : this.createHarnessAdapter(harnessName);

    if (profile.mode === EXECUTION_MODE.PARALLEL && !options.forceSingleWorker)
      return this.runDeep(
        row,
        profile,
        harness,
        harnessName,
        requestedReviewHarness,
        requestedArchitect,
        taskSignal,
        options,
      );
    if (pairedExecution)
      return this.runPairedTask(
        row,
        profile,
        harnessName,
        requestedReviewHarness,
        requestedArchitect,
        taskSignal,
        resumeSessionId,
        retryFeedback,
        options,
      );
    const stageId = options.stageId ?? 'worker';
    const continuationGrant = options.continuationGrantId
      ? this.store.getContinuationGrant(options.continuationGrantId)
      : null;
    let persistedRun = continuationGrant?.correction_run_id
      ? this.store.getRun(continuationGrant.correction_run_id)
      : null;

    if (!persistedRun) resumeSessionId = this.reconcileSingleWorker(row, resumeSessionId);
    else if (
      [
        TASK_STATE.RECOVERING,
        TASK_STATE.EXECUTING,
        TASK_STATE.VERIFYING,
        TASK_STATE.REVIEWING,
      ].includes(row.state)
    ) {
      if (row.state !== TASK_STATE.RECOVERING) {
        assertValidTaskTransition(row.state, TASK_STATE.RECOVERING);
        this.store.setTaskState(taskId, TASK_STATE.RECOVERING);
      }
      this.store.setTaskState(taskId, TASK_STATE.QUEUED);
      row.state = TASK_STATE.QUEUED;
    }
    if (
      ![
        TASK_STATE.DRAFT,
        TASK_STATE.QUEUED,
        TASK_STATE.READY,
        TASK_STATE.FAILED,
        TASK_STATE.WAITING_FOR_HUMAN,
      ].includes(row.state)
    )
      throw new Error(`task ${taskId} is already ${row.state}`);
    if (!this.store.listStages(taskId).some((stage) => stage.id === stageId))
      this.store.addStage(taskId, stageId, [], STAGE_STATUS.QUEUED);
    if (row.state !== TASK_STATE.QUEUED) {
      assertValidTaskTransition(row.state, TASK_STATE.QUEUED);
      this.store.setTaskState(taskId, TASK_STATE.QUEUED);
    }
    this.store.setTaskState(taskId, TASK_STATE.EXECUTING);
    this.store.setStage(taskId, stageId, STAGE_STATUS.RUNNING);
    let workspace;
    const startedAt = new Date().toISOString();
    let runId = persistedRun?.id ?? randomUUID();
    const attempt = persistedRun?.attempt ?? this.store.listRuns(taskId).length + 1;

    try {
      if (persistedRun) workspace = { path: persistedRun.workspace, branch: null, baseSha: null };
      else {
        workspace = this.workspaceManager.createWorktree(
          taskId,
          stageId,
          row.contract.base_ref,
          attempt,
        );
        const proposedRun = {
          id: runId,
          taskId,
          stageId,
          attempt,
          status: RUN_STATUS.RUNNING,
          harness: harnessName,
          profile: profile.name,
          policy: profile,
          workspace: workspace.path,
          startedAt,
          runtimeNamespace: createRuntimeNamespace(taskId, runId),
        };

        const createdRun = continuationGrant
          ? this.store.claimContinuationRun(continuationGrant.id, proposedRun)
          : (this.store.createRun(proposedRun), proposedRun);
        const allocatedHere = createdRun.id === proposedRun.id;

        persistedRun = createdRun;
        runId = persistedRun.id;
        if (!allocatedHere)
          workspace = { path: persistedRun.workspace, branch: null, baseSha: null };
        else
          this.store.appendEvent(taskId, 'STAGE_RUN_STARTED', {
            ...proposedRun,
            id: runId,
            branch: workspace.branch,
            baseSha: workspace.baseSha,
            continuationGrantId: continuationGrant?.id ?? null,
          });
      }
      const completedReport = this.store
        .listVerification(taskId)
        .find((report) => report.runId === runId);

      if (completedReport && persistedRun.status !== RUN_STATUS.COMPLETED) {
        this.store.finishRun(runId, RUN_STATUS.COMPLETED, completedReport.revision);
        if (continuationGrant) this.store.markContinuationWorkerCompleted(continuationGrant.id);
      }
      let result = null;
      let evidence;
      let revision;

      if (completedReport) {
        evidence = completedReport.evidence;
        revision = completedReport.revision;
      } else {
        const workerTask = this.withRetryFeedback(row.contract, retryFeedback);

        result = await this.runHarnessWithSessionFallback(
          harness,
          {
            task: workerTask,
            stageId,
            runId,
            cwd: workspace.path,
            onEvent: (event) => this.recordHarnessEvent(taskId, event, runId),
            signal: taskSignal,
            resumeSessionId,
            readOnly: options.readOnly === true,
            model: this.adapterConfig.models?.worker ?? null,
            runtimeNamespace:
              persistedRun.runtimeNamespace ?? createRuntimeNamespace(taskId, runId),
            liveEndpoint:
              harnessName === HARNESS_NAME.CODEX && this.adapterConfig.terminalManager
                ? createCodexLiveEndpoint(
                    persistedRun.runtimeNamespace ?? createRuntimeNamespace(taskId, runId),
                  )
                : null,
            onApproval: (request) => this.awaitHarnessApproval(taskId, runId, request, taskSignal),
          },
          taskId,
          runId,
        );

        this.store.recordUsage({
          ...(result.usage ?? {}),
          taskId,
          runId,
          stageId,
          attempt,
          sessionId: result.sessionId,
          turnId: result.turnId,
          harness: harnessName,
          model: this.adapterConfig.models?.worker ?? null,
        });

        const workerOutput =
          typeof result.output === 'string'
            ? result.output
            : JSON.stringify(result.output ?? null, null, 2);

        this.store.appendEvent(taskId, 'WORKER_OUTPUT_RECORDED', {
          taskId,
          runId,
          stageId,
          attempt,
          sessionId: result.sessionId ?? null,
          turnId: result.turnId ?? null,
          output: workerOutput.slice(0, 32_000),
        });

        this.assertVerificationPassed(result.verification);
        this.store.setRunIdentity(runId, result.sessionId ?? null, result.turnId ?? null);
        const status = this.workspaceManager.getWorktreeStatus(workspace.path);

        revision = this.workspaceManager.commitWorktreeChanges
          ? this.workspaceManager.commitWorktreeChanges(
              workspace.path,
              `clew(${taskId}): ${stageId} attempt ${attempt}`,
            )
          : status.sha;
        evidence = this.normalizeVerificationEvidence(
          row.contract,
          profile,
          result.verification,
        ).map((item) => {
          const environment = verificationEnvironment({
            command: item.command,
            cwd: workspace.path,
            revision,
          });

          return {
            ...item,
            revision,
            endedAt: item.endedAt ?? new Date().toISOString(),
            environment,
            environmentFingerprint: environment.fingerprint,
          };
        });
        const verificationReport = validateVerificationReport({
          taskId,
          stageId,
          runId,
          attempt,
          workspace: workspace.path,
          evidence,
          revision,
          rationale:
            result.rationale ?? 'Harness evidence satisfied the configured completion policy',
          skippedChecks: result.skippedChecks ?? [],
        });

        this.store.appendEvent(taskId, 'VERIFICATION_RECORDED', verificationReport);
        this.store.finishRun(runId, RUN_STATUS.COMPLETED, revision);
        if (continuationGrant) this.store.markContinuationWorkerCompleted(continuationGrant.id);
      }
      this.store.setStage(taskId, stageId, STAGE_STATUS.COMPLETED);
      this.store.setTaskState(taskId, TASK_STATE.VERIFYING);
      const needsReview = profile.review || options.correctionOnly;

      this.store.setTaskState(taskId, needsReview ? TASK_STATE.REVIEWING : TASK_STATE.READY);
      let review = null;

      if (needsReview) {
        const reviewer = this.createReviewerAdapter(
          requestedReviewHarness ??
            (harnessName === HARNESS_NAME.FAKE
              ? HARNESS_NAME.FAKE
              : (profile.reviewHarness ?? HARNESS_NAME.CODEX)),
        );
        const persistedReview = this.store
          .listEvents(taskId)
          .filter((event) => event.type === 'REVIEW_RECORDED')
          .map((event) => event.payload)
          .find((candidate) => candidate.runId === runId);

        review =
          persistedReview ??
          (await reviewer.review({
            task: row.contract,
            evidence,
            revision,
            cwd: workspace.path,
          }));

        if (!persistedReview)
          this.store.appendEvent(taskId, 'REVIEW_RECORDED', { ...review, runId, stageId });
        if (review.verdict === REVIEW_VERDICT.PASS)
          this.store.setTaskState(taskId, TASK_STATE.READY);
        else {
          const reviewAttempt = options.reviewAttempt ?? attempt;
          const requiresHuman = review.verdict === REVIEW_VERDICT.NEEDS_HUMAN;
          const exhausted =
            options.correctionOnly || requiresHuman || reviewAttempt >= profile.maxAttempts;

          this.store.setTaskState(
            taskId,
            exhausted ? TASK_STATE.WAITING_FOR_HUMAN : TASK_STATE.FAILED,
          );
          this.store.appendEvent(taskId, 'CHANGES_REQUESTED', { findings: review.findings });
          if (exhausted) {
            this.store.appendEvent(taskId, 'REVIEW_EXHAUSTED', {
              stageId,
              runId,
              attempts: reviewAttempt,
              findings: review.findings,
              reason: requiresHuman
                ? 'reviewer reported ambiguity requiring human judgment'
                : options.correctionOnly
                  ? 'explicit continuation correction completed'
                  : 'automatic review correction budget exhausted',
            });
          } else if (reviewAttempt < profile.maxAttempts) {
            this.store.appendEvent(taskId, 'RETRY_SCHEDULED', {
              failedAttempt: reviewAttempt,
              nextAttempt: reviewAttempt + 1,
              reason: 'blocking review findings',
            });
            this.store.setStage(taskId, stageId, STAGE_STATUS.QUEUED);
            this.store.setTaskState(taskId, TASK_STATE.QUEUED);

            return this.runTask(
              taskId,
              requestedProfile,
              requestedHarness,
              requestedReviewHarness,
              requestedArchitect,
              reviewAttempt === 1 ? (result?.sessionId ?? persistedRun.session_id ?? null) : null,
              review.findings,
              { ...options, reviewAttempt: reviewAttempt + 1 },
            );
          }
        }
      }
      if (continuationGrant)
        this.store.completeContinuation(continuationGrant.id, {
          state: this.store.getTask(taskId).state,
          review,
          runId,
        });

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
        this.store.setStage(taskId, stageId, STAGE_STATUS.CANCELLED);
        this.store.setTaskState(taskId, TASK_STATE.CANCELLED);
        this.store.appendEvent(taskId, 'RUN_INTERRUPTED', { message: error.message });
        this.store.clearInterruptRequest(taskId);
        throw error;
      }
      const failedRun = runId ? this.store.getRun(runId) : null;

      if (failedRun && failedRun.status !== RUN_STATUS.COMPLETED) {
        this.store.finishRun(runId, RUN_STATUS.FAILED);
        this.store.setStage(taskId, stageId, STAGE_STATUS.FAILED);
      } else this.store.setStage(taskId, stageId, STAGE_STATUS.COMPLETED);
      this.store.setTaskState(taskId, TASK_STATE.FAILED);

      const failureClass = classifyFailure(error);

      this.store.appendEvent(taskId, 'RUN_FAILED', {
        message: error.message,
        failureClass,
      });
      if (continuationGrant) {
        this.store.setTaskState(taskId, TASK_STATE.WAITING_FOR_HUMAN);
        this.store.appendEvent(taskId, 'CONTINUATION_INTERRUPTED', {
          grantId: continuationGrant.id,
          runId,
          reason: error.message,
        });
        throw error;
      }

      if (
        failureClass === FAILURE_CLASS.TIMEOUT &&
        attempt < profile.maxAttempts &&
        !taskSignal.aborted
      ) {
        this.store.appendEvent(taskId, 'RETRY_SCHEDULED', {
          failedAttempt: attempt,
          nextAttempt: attempt + 1,
          reason: failureClass,
        });
        this.store.setStage(taskId, stageId, STAGE_STATUS.QUEUED);
        this.store.setTaskState(taskId, TASK_STATE.QUEUED);
        const timedOutRun = this.store.listRuns(taskId).find((run) => run.id === runId);

        return this.runTask(
          taskId,
          requestedProfile,
          requestedHarness,
          requestedReviewHarness,
          requestedArchitect,
          attempt === 1 ? (timedOutRun?.session_id ?? null) : null,
        );
      }
      throw error;
    }
  }

  async runPairedTask(
    row,
    profile,
    harnessName,
    requestedReviewHarness,
    requestedArchitect,
    signal,
    resumeSessionId,
    retryFeedback,
    options = {},
  ) {
    const taskId = row.id;
    const stageId = options.stageId ?? 'worker';

    if (!this.store.listStages(taskId).some((stage) => stage.id === stageId))
      this.store.addStage(taskId, stageId, [], STAGE_STATUS.QUEUED);
    if (row.state !== TASK_STATE.QUEUED) this.store.setTaskState(taskId, TASK_STATE.QUEUED);
    this.store.setTaskState(taskId, TASK_STATE.EXECUTING);
    const needsReview = profile.review || options.correctionOnly;
    let stageResult;

    try {
      stageResult = await this.executePairedStage({
        task: this.withRetryFeedback(row.contract, retryFeedback),
        stage: { id: stageId, goal: row.contract.goal, kind: 'worker' },
        harnessName,
        policy: profile,
        signal,
        resumeSessionId,
        readOnly: options.readOnly === true,
        review: needsReview,
        reviewHarness:
          requestedReviewHarness ??
          (harnessName === HARNESS_NAME.FAKE ? HARNESS_NAME.FAKE : profile.reviewHarness),
        workspaceMappingId: options.workspaceMappingId,
      });
    } catch (error) {
      const currentState = this.store.getTask(taskId).state;

      if (![TASK_STATE.RECOVERING, TASK_STATE.CANCELLED].includes(currentState))
        this.store.setTaskState(taskId, TASK_STATE.FAILED);
      throw error;
    }

    this.store.setTaskState(taskId, TASK_STATE.VERIFYING);
    this.store.setTaskState(taskId, needsReview ? TASK_STATE.REVIEWING : TASK_STATE.READY);

    if (needsReview) {
      let review = stageResult.review;

      if (!review && harnessName === HARNESS_NAME.FAKE) {
        const reviewer = this.createReviewerAdapter(requestedReviewHarness ?? HARNESS_NAME.FAKE);

        review = await reviewer.review({
          task: row.contract,
          evidence: stageResult.evidence,
          revision: stageResult.revision,
          cwd: stageResult.workspace.path,
        });
      }
      if (!review) throw new Error('paired Runner completed without the required review result');
      this.store.appendEvent(taskId, 'REVIEW_RECORDED', {
        ...review,
        runId: stageResult.runId,
        stageId,
      });
      if (review.verdict === REVIEW_VERDICT.PASS) this.store.setTaskState(taskId, TASK_STATE.READY);
      else {
        const reviewAttempt = options.reviewAttempt ?? stageResult.attempt;
        const requiresHuman = review.verdict === REVIEW_VERDICT.NEEDS_HUMAN;
        const exhausted =
          options.correctionOnly || requiresHuman || reviewAttempt >= profile.maxAttempts;

        this.store.setTaskState(
          taskId,
          exhausted ? TASK_STATE.WAITING_FOR_HUMAN : TASK_STATE.FAILED,
        );
        this.store.appendEvent(taskId, 'CHANGES_REQUESTED', { findings: review.findings });
        if (exhausted) {
          this.store.appendEvent(taskId, 'REVIEW_EXHAUSTED', {
            stageId,
            runId: stageResult.runId,
            attempts: reviewAttempt,
            findings: review.findings,
            reason: requiresHuman
              ? 'reviewer reported ambiguity requiring human judgment'
              : options.correctionOnly
                ? 'explicit continuation correction completed'
                : 'automatic review correction budget exhausted',
          });
        } else {
          this.store.appendEvent(taskId, 'RETRY_SCHEDULED', {
            failedAttempt: reviewAttempt,
            nextAttempt: reviewAttempt + 1,
            reason: 'blocking review findings',
          });
          this.store.setStage(taskId, stageId, STAGE_STATUS.QUEUED);
          this.store.setTaskState(taskId, TASK_STATE.QUEUED);

          return this.runTask(
            taskId,
            profile.name,
            harnessName,
            requestedReviewHarness,
            requestedArchitect,
            null,
            review.findings,
            { ...options, reviewAttempt: reviewAttempt + 1 },
          );
        }
      }
    }

    return {
      taskId,
      runId: stageResult.runId,
      attempt: stageResult.attempt,
      workspace: stageResult.workspace,
      revision: stageResult.revision,
      state: this.store.getTask(taskId).state,
    };
  }

  async executePairedStage({
    task,
    stage,
    harnessName,
    policy,
    signal,
    resumeSessionId = null,
    readOnly = false,
    review = false,
    reviewHarness = null,
    operation = 'execute',
    dependencyRevisions = [],
    workspaceMappingId = null,
  }) {
    const taskId = task.id;
    const runnerDescription = this.executionPort.describe();
    const runner = runnerDescription.runner;

    if (!runner || !runnerDescription.available) throw new Error('paired Runner is unavailable');
    const mappingId = workspaceMappingId ?? runner.workspaces[0]?.id;

    if (!mappingId) throw new Error('paired Runner has no workspace mapping');
    const runId = randomUUID();
    const leaseId = randomUUID();
    const attempt =
      this.store.listRuns(taskId).filter((run) => run.stage_id === stage.id).length + 1;
    const requirements = {
      task: { ...task, title: stage.goal ?? task.title },
      operation,
      readOnly,
      review,
      reviewHarness,
      resumeSessionId,
      model: this.adapterConfig.models?.[stage.kind === 'qa' ? 'qa' : 'worker'] ?? null,
      dependencyRevisions,
    };
    const run = {
      id: runId,
      taskId,
      stageId: stage.id,
      attempt,
      status: RUN_STATUS.RUNNING,
      harness: harnessName,
      profile: policy?.name ?? task.profile,
      policy,
      startedAt: new Date().toISOString(),
    };
    const lease = {
      id: leaseId,
      runnerId: runner.runnerId,
      epoch: 1,
      workspaceMappingId: mappingId,
      requirements: { capabilities: ['execute'], operation },
    };
    const offer = createRunnerEnvelope({
      kind: RUNNER_MESSAGE_KIND.LEASE_OFFER,
      messageId: randomUUID(),
      idempotencyKey: `lease-offer:${leaseId}:1`,
      correlationId: leaseId,
      payload: {
        runnerId: runner.runnerId,
        leaseId,
        epoch: 1,
        taskId,
        stageId: stage.id,
        runId,
        attempt,
        workspaceId: mappingId,
        profile: policy?.name ?? task.profile,
        harness: harnessName,
        requirements,
      },
    });

    await this.executionPort.executeStage({
      run,
      lease,
      offer,
      requirements: lease.requirements,
    });
    let storedResult = null;

    while (!storedResult) {
      if (signal?.aborted) {
        const command = createRunnerEnvelope({
          kind: RUNNER_MESSAGE_KIND.CANCEL,
          messageId: randomUUID(),
          idempotencyKey: `lease-cancel:${leaseId}:1`,
          correlationId: leaseId,
          payload: {
            runnerId: runner.runnerId,
            leaseId,
            epoch: 1,
            reason: 'scheduler interrupted',
          },
        });

        await this.executionPort.cancelStage({
          leaseId,
          reason: 'scheduler interrupted',
          command,
        });
        this.store.finishRun(runId, RUN_STATUS.INTERRUPTED);
        this.store.setStage(taskId, stage.id, STAGE_STATUS.CANCELLED);
        throw new HarnessInterruptedError('paired Runner');
      }
      const currentLease = this.store.getRunnerLease(leaseId);

      if (currentLease?.state === 'recovering') {
        this.store.setTaskState(taskId, TASK_STATE.RECOVERING);
        const error = new Error(
          `paired Runner execution ${leaseId}@1 has ambiguous ownership; reconnect the same Runner or resolve recovery explicitly`,
        );

        error.code = 'AMBIGUOUS_RUNNER_LOSS';
        throw error;
      }
      if (currentLease?.state === 'failed' && !this.store.getRunnerLeaseResult(leaseId)) {
        this.store.finishRun(runId, RUN_STATUS.FAILED);
        this.store.setStage(taskId, stage.id, STAGE_STATUS.FAILED);
        throw new Error('paired Runner rejected or failed the lease');
      }
      storedResult = this.store.getRunnerLeaseResult(leaseId);
      if (!storedResult)
        await new Promise((resolveDelay) => setTimeout(resolveDelay, this.interruptPollMs));
    }
    const result = storedResult.result;

    if (result.status !== 'completed') {
      this.store.finishRun(
        runId,
        result.status === 'cancelled' ? RUN_STATUS.INTERRUPTED : RUN_STATUS.FAILED,
      );
      this.store.setStage(
        taskId,
        stage.id,
        result.status === 'cancelled' ? STAGE_STATUS.CANCELLED : STAGE_STATUS.FAILED,
      );
      throw new Error(`paired Runner ended ${result.status}`);
    }
    const revision = result.revision ?? `runner-result:${result.resultId}`;
    const evidence = this.normalizeVerificationEvidence(task, policy, result.evidence ?? []).map(
      (item) => ({ ...item, revision }),
    );

    try {
      this.assertVerificationPassed(evidence);
    } catch (error) {
      this.store.finishRun(runId, RUN_STATUS.FAILED);
      this.store.setStage(taskId, stage.id, STAGE_STATUS.FAILED);
      this.store.appendEvent(taskId, 'STAGE_RUN_FAILED', {
        stageId: stage.id,
        message: error.message,
        failureClass: classifyFailure(error),
      });
      throw error;
    }
    this.store.setRunIdentity(runId, result.sessionId ?? null, result.turnId ?? null);
    this.store.finishRun(runId, RUN_STATUS.COMPLETED, revision);
    this.store.setStage(taskId, stage.id, STAGE_STATUS.COMPLETED);
    this.store.appendEvent(
      taskId,
      'VERIFICATION_RECORDED',
      validateVerificationReport({
        taskId,
        stageId: stage.id,
        runId,
        attempt,
        workspace: `runner-workspace:${mappingId}`,
        revision,
        evidence,
        rationale: result.summary ?? 'Paired Runner reported completion',
        skippedChecks: [],
      }),
    );

    return {
      runId,
      stageId: stage.id,
      attempt,
      workspace: {
        path: `runner-workspace:${mappingId}`,
        ref: `runner-workspace:${mappingId}`,
        access: 'runner_local',
      },
      revision,
      evidence,
      review: result.review ?? null,
      plan: result.plan ?? null,
      leaseId,
    };
  }

  reconcileSingleWorker(row, requestedSessionId = null) {
    const recoverableStates = [
      TASK_STATE.RECOVERING,
      TASK_STATE.EXECUTING,
      TASK_STATE.VERIFYING,
      TASK_STATE.REVIEWING,
    ];

    if (!recoverableStates.includes(row.state)) return requestedSessionId;
    const runningRuns = this.store
      .listRuns(row.id)
      .filter((run) => run.status === RUN_STATUS.RUNNING);
    const latestRun = runningRuns.at(-1);

    if (row.state !== TASK_STATE.RECOVERING) {
      assertValidTaskTransition(row.state, TASK_STATE.RECOVERING);
      this.store.setTaskState(row.id, TASK_STATE.RECOVERING);
    }
    for (const run of runningRuns) {
      this.store.finishRun(run.id, RUN_STATUS.INTERRUPTED, run.commit_sha);
      this.store.appendEvent(row.id, 'RUN_INTERRUPTED', {
        runId: run.id,
        stageId: run.stage_id,
        reason: 'scheduler process restarted before terminal run state',
      });
    }
    this.store.setStage(row.id, 'worker', STAGE_STATUS.QUEUED);
    this.store.setTaskState(row.id, TASK_STATE.QUEUED);
    row.state = TASK_STATE.QUEUED;

    return requestedSessionId ?? latestRun?.session_id ?? null;
  }

  withRetryFeedback(task, findings = []) {
    if (!findings.length) return task;
    const feedback = findings
      .map((finding) => `- [${finding.severity}] ${finding.criterion}: ${finding.reason}`)
      .join('\n');

    return {
      ...task,
      goal: `${task.goal}\n\nReview feedback to address in this attempt:\n${feedback}`,
    };
  }

  async runHarnessWithSessionFallback(harness, options, taskId, runId) {
    try {
      return await harness.run(options);
    } catch (error) {
      const unavailable =
        options.resumeSessionId &&
        (['SESSION_NOT_FOUND', 'THREAD_NOT_FOUND', 'SESSION_STALE'].includes(error.code) ||
          /(?:session|thread).*(?:not found|unknown|stale|unavailable)/i.test(error.message));

      if (!unavailable) throw error;
      this.store.appendEvent(taskId, 'SESSION_RESUME_FALLBACK', {
        runId,
        sessionId: options.resumeSessionId,
        reason: error.message,
      });

      return harness.run({ ...options, resumeSessionId: null });
    }
  }

  normalizeVerificationEvidence(task, policy, evidence = []) {
    return evidence.map((item) => ({
      ...item,
      scope: item.scope ?? policy.verification,
      acceptanceCriteria:
        item.acceptanceCriteria ?? task.acceptance.map((criterion) => criterion.id),
    }));
  }

  assertVerificationPassed(evidence) {
    if (!Array.isArray(evidence) || !evidence.length) {
      const error = new Error('harness completed without verification evidence');

      error.code = 'VERIFICATION_FAILED';
      throw error;
    }
    if (!evidence.some((item) => item.result === 'passed')) {
      const error = new Error('harness completed without passing verification evidence');

      error.code = 'VERIFICATION_FAILED';
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
    options = {},
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
    const architectName =
      requestedArchitect ??
      (harnessName === HARNESS_NAME.FAKE ? HARNESS_NAME.FAKE : profile.architectHarness);

    if (!persistedPlan) {
      this.store.appendEvent(taskId, 'ARCHITECT_STARTED', {
        architect: this.planFactory ? 'plan-factory' : architectName,
      });
    }
    let proposedPlan;

    if (persistedPlan) proposedPlan = persistedPlan.plan;
    else if (this.planFactory) proposedPlan = await this.planFactory(row.contract, profile);
    else if (this.executionPort?.describe().mode === 'paired') {
      const architectStage = {
        id: 'control-architect',
        kind: 'architect',
        goal: `Architecture plan: ${row.contract.title}`,
      };

      this.store.addStage(taskId, architectStage.id, [], STAGE_STATUS.QUEUED);
      const planning = await this.executePairedStage({
        task: row.contract,
        stage: architectStage,
        harnessName: architectName,
        policy: profile,
        signal: taskSignal,
        readOnly: true,
        operation: 'plan',
        workspaceMappingId: options.workspaceMappingId,
      });

      if (!planning.plan) throw new Error('paired Runner completed without an execution plan');
      proposedPlan = planning;
    } else {
      proposedPlan = await this.createArchitectAdapter(architectName).createPlan({
        task: row.contract,
        cwd: this.workspaceManager.projectRoot ?? process.cwd(),
      });
    }
    const planResult = Array.isArray(proposedPlan?.stages)
      ? { plan: proposedPlan, sessionId: proposedPlan.sessionId ?? null }
      : proposedPlan;
    const plan = validateExecutionPlan(planResult.plan ?? proposedPlan);
    const architectSessionId = planResult.sessionId ?? null;

    if (architectSessionId && !persistedPlan) {
      this.store.saveAgentSession({
        taskId,
        role: 'architect',
        harness: architectName,
        sessionId: architectSessionId,
        workspace: this.workspaceManager.projectRoot,
      });
    }
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
        architect: this.planFactory ? 'plan-factory' : architectName,
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
      policy: profile,
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
    let review = integrationResult.review;

    if (!review) {
      const reviewer = this.createReviewerAdapter(
        requestedReviewHarness ??
          (harnessName === HARNESS_NAME.FAKE ? HARNESS_NAME.FAKE : profile.reviewHarness),
      );

      review = await reviewer.review({
        task: row.contract,
        evidence: integrationResult.evidence,
        revision: integrationResult.revision,
        cwd: integrationResult.workspace.path,
      });
    }

    this.store.appendEvent(taskId, 'REVIEW_RECORDED', {
      ...review,
      runId: integrationResult.runId,
      stageId: integrationStage.id,
    });
    if (review.verdict === REVIEW_VERDICT.PASS) this.store.setTaskState(taskId, TASK_STATE.READY);
    else if (review.verdict === REVIEW_VERDICT.NEEDS_HUMAN) {
      this.store.setTaskState(taskId, TASK_STATE.WAITING_FOR_HUMAN);
      this.store.appendEvent(taskId, 'CHANGES_REQUESTED', { findings: review.findings });
      this.store.appendEvent(taskId, 'REVIEW_EXHAUSTED', {
        stageId: integrationStage.id,
        runId: integrationResult.runId,
        attempts: 1,
        findings: review.findings,
        reason: 'reviewer reported ambiguity requiring human judgment',
      });
    } else {
      this.store.setTaskState(taskId, TASK_STATE.FAILED);
      this.store.appendEvent(taskId, 'CHANGES_REQUESTED', { findings: review.findings });
      this.store.appendEvent(taskId, 'RETRY_SCHEDULED', {
        failedAttempt: 1,
        nextAttempt: 2,
        reason: 'blocking review findings',
      });
      this.store.setStage(taskId, integrationStage.id, STAGE_STATUS.QUEUED);
      this.store.setTaskState(taskId, TASK_STATE.QUEUED);
      const integrationRun = this.store.getRun(integrationResult.runId);

      return this.runTask(
        taskId,
        profile.name,
        harnessName,
        requestedReviewHarness,
        requestedArchitect,
        integrationRun?.session_id ?? null,
        review.findings,
        {
          ...options,
          forceSingleWorker: true,
          stageId: integrationStage.id,
          reviewAttempt: 2,
        },
      );
    }

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
    policy,
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
        const stageHarnessName = stage.harness ?? harnessName;
        const stageHarness =
          this.executionPort?.describe().mode === 'paired'
            ? null
            : stage.harness
              ? this.createHarnessAdapter(stageHarnessName)
              : harness;

        pending.delete(stage.id);
        const stageExecution = this.executePlannedStage({
          task,
          plan,
          stage,
          harness: stageHarness,
          harnessName: stageHarnessName,
          completed,
          integrationStageId,
          policy,
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
        const failedStage = plan.stages.find((stage) => stage.id === settledStage.stageId);
        const stageRuns = this.store
          .listRuns(task.id)
          .filter((run) => run.stage_id === settledStage.stageId);
        const failedRun = stageRuns.at(-1);
        const canRetry =
          classifyFailure(settledStage.error) === FAILURE_CLASS.TIMEOUT &&
          stageRuns.length < policy.maxAttempts;

        if (canRetry) {
          this.store.appendEvent(task.id, 'RETRY_SCHEDULED', {
            stageId: settledStage.stageId,
            failedAttempt: stageRuns.length,
            nextAttempt: stageRuns.length + 1,
            reason: FAILURE_CLASS.TIMEOUT,
          });
          this.store.setStage(task.id, settledStage.stageId, STAGE_STATUS.QUEUED);
          pending.set(settledStage.stageId, failedStage);
          if (stageRuns.length === 1 && failedRun?.session_id) {
            const sessions = this.resumeSessions.get(task.id) ?? new Map();

            sessions.set(settledStage.stageId, failedRun.session_id);
            this.resumeSessions.set(task.id, sessions);
          }
        } else failures.set(settledStage.stageId, settledStage.error);
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
    policy,
    signal = null,
    resumeSessionId = null,
  }) {
    const attempt =
      this.store.listRuns(task.id).filter((run) => run.stage_id === stage.id).length + 1;

    if (stage.id === integrationStageId) {
      this.store.appendEvent(task.id, 'INTEGRATION_STARTED', {
        dependencies: stage.dependsOn,
      });
    }
    if (this.executionPort?.describe().mode === 'paired') {
      const ancestorStageIds = this.getAncestorStageIds(plan, stage.id);

      if (ancestorStageIds.length) {
        const revisions = ancestorStageIds.map((ancestorId) => completed.get(ancestorId).revision);

        this.store.appendEvent(task.id, 'STAGE_DEPENDENCIES_INTEGRATED', {
          stageId: stage.id,
          sourceStages: ancestorStageIds,
          revisions,
          mode: 'runner_workspace',
        });
        if (stage.id === integrationStageId)
          this.store.appendEvent(task.id, 'COMMITS_INTEGRATED', {
            sourceStages: ancestorStageIds,
            revisions,
            mode: 'runner_workspace',
          });
      }

      return this.executePairedStage({
        task,
        stage,
        harnessName,
        policy,
        signal,
        resumeSessionId,
        review: stage.id === integrationStageId,
        reviewHarness: harnessName === HARNESS_NAME.FAKE ? HARNESS_NAME.FAKE : policy.reviewHarness,
        dependencyRevisions: ancestorStageIds.map(
          (ancestorId) => completed.get(ancestorId).revision,
        ),
      });
    }

    let workspace;

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
        policy,
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
    policy = null,
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
      profile: policy?.name ?? task.profile,
      policy,
      workspace: stageWorkspace.path,
      startedAt: new Date().toISOString(),
      runtimeNamespace: createRuntimeNamespace(taskId, runId),
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
        runId,
        cwd: stageWorkspace.path,
        onEvent: (event) => this.recordHarnessEvent(taskId, event, runId),
        signal,
        resumeSessionId,
        model: this.adapterConfig.models?.[stage.kind === 'qa' ? 'qa' : 'worker'] ?? null,
        runtimeNamespace: run.runtimeNamespace,
        liveEndpoint:
          harnessName === HARNESS_NAME.CODEX ? createCodexLiveEndpoint(run.runtimeNamespace) : null,
        onApproval: (request) => this.awaitHarnessApproval(taskId, runId, request, signal),
      });

      this.store.recordUsage({
        ...(result.usage ?? {}),
        taskId,
        runId,
        stageId: stage.id,
        attempt,
        sessionId: result.sessionId,
        turnId: result.turnId,
        harness: harnessName,
        model: this.adapterConfig.models?.[stage.kind === 'qa' ? 'qa' : 'worker'] ?? null,
      });

      this.assertVerificationPassed(result.verification);
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
      const evidence = this.normalizeVerificationEvidence(task, policy, result.verification).map(
        (item) => {
          const environment = verificationEnvironment({
            command: item.command,
            cwd: stageWorkspace.path,
            revision,
          });

          return {
            ...item,
            revision,
            endedAt: item.endedAt ?? new Date().toISOString(),
            environment,
            environmentFingerprint: environment.fingerprint,
          };
        },
      );
      const verificationReport = validateVerificationReport({
        taskId,
        stageId: stage.id,
        runId,
        attempt,
        workspace: stageWorkspace.path,
        evidence,
        revision,
        rationale:
          result.rationale ?? 'Harness evidence satisfied the configured completion policy',
        skippedChecks: result.skippedChecks ?? [],
      });

      this.store.appendEvent(taskId, 'VERIFICATION_RECORDED', verificationReport);

      return {
        runId,
        stageId: stage.id,
        workspace: stageWorkspace,
        revision,
        evidence,
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
    if (harnessName === HARNESS_NAME.CODEX)
      return new CodexHarness({
        command: this.adapterConfig.codexBin,
        openDesktop: this.adapterConfig.openCodexDesktop,
        terminalManager: this.adapterConfig.terminalManager,
      });
    if (harnessName === HARNESS_NAME.OPENCODE)
      return new OpenCodeHarness({ baseUrl: this.adapterConfig.openCodeUrl });

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
    this.store.setTaskState(taskId, TASK_STATE.WAITING_FOR_HUMAN);

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
        if (
          approval.decision === APPROVAL_DECISION.ACCEPT ||
          approval.decision === APPROVAL_DECISION.ACCEPT_FOR_SESSION
        )
          this.store.setTaskState(taskId, TASK_STATE.EXECUTING);
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
    const run = runId ? this.store.getRun(runId) : null;

    this.store.appendEvent(taskId, eventType, {
      ...event,
      runId: runId ?? event.runId ?? null,
      stageId: run?.stage_id ?? event.stageId ?? null,
    });
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
      ? new CodexReviewer(
          new CodexHarness({
            command: this.adapterConfig.codexBin,
            model: this.adapterConfig.models?.reviewer,
          }),
        )
      : new FakeReviewer();
  }

  createArchitectAdapter(architectName) {
    if (this.architectFactory) return this.architectFactory(architectName);

    return architectName === HARNESS_NAME.CODEX
      ? new CodexArchitect(
          new CodexHarness({
            command: this.adapterConfig.codexBin,
            model: this.adapterConfig.models?.architect,
          }),
        )
      : new FakeArchitect();
  }
}
