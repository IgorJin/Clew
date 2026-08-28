import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { Scheduler } from '../src/scheduler.js';
import { FakeHarness } from '../src/harness.js';

const blockingReview = (revision = 'abc') => ({
  verdict: 'request_changes',
  findings: [{ severity: 'blocking', criterion: 'AC-1', reason: 'still open' }],
  revision,
});

const passingReview = (revision = 'abc') => ({ verdict: 'pass', findings: [], revision });

function workspaceManager(dir) {
  return {
    createWorktree: (_task, stage) => ({ path: dir, branch: `test-${stage}`, baseSha: 'abc' }),
    getWorktreeStatus: () => ({ path: dir, sha: 'abc', dirty: false }),
  };
}

function fixtureStore() {
  const dir = mkdtempSync(join(tmpdir(), 'clew-continuation-'));
  const store = new Store(join(dir, 'state.sqlite'));

  store.createTask({
    id: 'CONT-1',
    title: 'Continuation',
    goal: 'test continuation',
    profile: 'standard',
    risk: 'medium',
    base_ref: 'HEAD',
    acceptance: [{ id: 'AC-1', criterion: 'works' }],
  });

  return { dir, store };
}

test('continuation grants are idempotent and operator messages are redacted', () => {
  const { dir, store } = fixtureStore();

  try {
    const message = store.recordOperatorMessage({
      taskId: 'CONT-1',
      actor: 'operator',
      message: 'Fix Bearer secret-value',
      target: { stageId: 'worker', cause: 'review_exhaustion' },
    });
    const grant = {
      id: 'grant-1',
      taskId: 'CONT-1',
      stageId: 'worker',
      actor: 'operator',
      reason: message.message,
      expectedRevision: 'rev-1',
      expiresAt: '2026-08-29T00:00:00.000Z',
      idempotencyKey: 'request-1',
    };
    const first = store.recordContinuationGrant(grant);
    const replay = store.recordContinuationGrant({ ...grant, id: 'grant-2' });

    assert.equal(message.message, 'Fix Bearer [REDACTED]');
    assert.equal(first.id, 'grant-1');
    assert.equal(replay.id, 'grant-1');
    assert.equal(store.getContinuationGrantByKey('request-1').task_id, 'CONT-1');
    assert.equal(store.listOperatorMessages('CONT-1').length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('completion override preserves unresolved findings and is idempotent', () => {
  const { dir, store } = fixtureStore();

  try {
    const findings = [{ severity: 'blocking', criterion: 'AC-1', reason: 'still open' }];
    const first = store.recordCompletionOverride({
      taskId: 'CONT-1',
      expectedRevision: 'rev-1',
      actor: 'operator',
      reason: 'accepted with risk',
      unresolvedFindings: findings,
      idempotencyKey: 'override-1',
    });
    const replay = store.recordCompletionOverride({
      taskId: 'CONT-1',
      expectedRevision: 'rev-2',
      actor: 'other',
      reason: 'replay',
      idempotencyKey: 'override-1',
    });

    assert.deepEqual(first.unresolvedFindings, findings);
    assert.equal(replay.id, first.id);
    assert.equal(store.listEvents('CONT-1').at(-1).type, 'COMPLETION_OVERRIDE_RECORDED');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart after worker completion resumes the same continuation Run and only reviews once', async () => {
  const { dir, store } = fixtureStore();

  try {
    await new Scheduler(store, workspaceManager(dir)).runTask('CONT-1', 'quick', 'fake');
    const previousRun = store.listRuns('CONT-1').at(-1);
    const grant = store.recordContinuationRequest({
      message: 'Apply the correction',
      target: {
        stageId: 'worker',
        runId: previousRun.id,
        sessionId: previousRun.session_id,
        cause: 'operator_feedback',
      },
      grant: {
        id: 'restart-grant',
        taskId: 'CONT-1',
        stageId: 'worker',
        runId: previousRun.id,
        sessionId: previousRun.session_id,
        actor: 'operator',
        reason: 'Apply the correction',
        expectedRevision: previousRun.commit_sha,
        expiresAt: '2026-08-29T00:00:00.000Z',
        idempotencyKey: 'restart-request',
      },
    });
    let reviews = 0;
    const crashingScheduler = new Scheduler(store, workspaceManager(dir), {
      reviewerFactory: () => ({
        review: async () => {
          reviews += 1;
          throw new Error('reviewer process stopped');
        },
      }),
    });

    await assert.rejects(
      () =>
        crashingScheduler.runTask(
          'CONT-1',
          'quick',
          'fake',
          null,
          null,
          previousRun.session_id,
          [{ severity: 'blocking', criterion: 'operator', reason: 'Apply the correction' }],
          {
            correctionOnly: true,
            forceSingleWorker: true,
            stageId: 'worker',
            continuationGrantId: grant.id,
          },
        ),
      /reviewer process stopped/,
    );
    const runCountAfterCrash = store.listRuns('CONT-1').length;
    const correctionRun = store.getRun(store.getContinuationGrant(grant.id).correction_run_id);

    assert.equal(correctionRun.status, 'COMPLETED');
    assert.equal(store.getContinuationGrant(grant.id).status, 'WORKER_COMPLETED');
    const resumedScheduler = new Scheduler(store, workspaceManager(dir), {
      harnessFactory: () => ({ run: async () => assert.fail('worker must not run twice') }),
      reviewerFactory: () => ({
        review: async ({ revision }) => {
          reviews += 1;

          return passingReview(revision);
        },
      }),
    });
    const resumed = await resumedScheduler.runTask(
      'CONT-1',
      'quick',
      'fake',
      null,
      null,
      previousRun.session_id,
      [],
      {
        correctionOnly: true,
        forceSingleWorker: true,
        stageId: 'worker',
        continuationGrantId: grant.id,
      },
    );

    assert.equal(resumed.state, 'READY');
    assert.equal(store.listRuns('CONT-1').length, runCountAfterCrash);
    assert.equal(store.getContinuationGrant(grant.id).status, 'COMPLETED');
    assert.equal(reviews, 2);
    assert.equal(
      store
        .listEvents('CONT-1')
        .filter(
          (event) => event.type === 'REVIEW_RECORDED' && event.payload.runId === correctionRun.id,
        ).length,
      1,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restart after Run allocation reuses the claimed continuation Run', async () => {
  const { dir, store } = fixtureStore();

  try {
    await new Scheduler(store, workspaceManager(dir)).runTask('CONT-1', 'quick', 'fake');
    const previousRun = store.listRuns('CONT-1').at(-1);
    const grant = store.recordContinuationRequest({
      message: 'Resume the allocated run',
      target: { stageId: 'worker', runId: previousRun.id, sessionId: previousRun.session_id },
      grant: {
        id: 'allocated-grant',
        taskId: 'CONT-1',
        stageId: 'worker',
        runId: previousRun.id,
        sessionId: previousRun.session_id,
        actor: 'operator',
        reason: 'Resume the allocated run',
        expectedRevision: previousRun.commit_sha,
        expiresAt: '2026-08-29T00:00:00.000Z',
        idempotencyKey: 'allocated-request',
      },
    });

    store.claimContinuationRun(grant.id, {
      id: 'claimed-run',
      taskId: 'CONT-1',
      stageId: 'worker',
      attempt: 2,
      status: 'RUNNING',
      harness: 'fake',
      profile: 'quick',
      policy: { name: 'quick', review: false, maxAttempts: 3 },
      workspace: dir,
      startedAt: new Date().toISOString(),
    });
    store.setTaskState('CONT-1', 'EXECUTING');
    const result = await new Scheduler(store, workspaceManager(dir), {
      reviewerFactory: () => ({ review: async ({ revision }) => passingReview(revision) }),
    }).runTask('CONT-1', 'quick', 'fake', null, null, previousRun.session_id, [], {
      correctionOnly: true,
      forceSingleWorker: true,
      stageId: 'worker',
      continuationGrantId: grant.id,
    });

    assert.equal(result.runId, 'claimed-run');
    assert.equal(store.listRuns('CONT-1').length, 2);
    assert.equal(store.getContinuationGrant(grant.id).status, 'COMPLETED');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale native session falls back to a fresh correction with the same feedback', async () => {
  const { dir, store } = fixtureStore();

  try {
    await new Scheduler(store, workspaceManager(dir)).runTask('CONT-1', 'quick', 'fake');
    const previousRun = store.listRuns('CONT-1').at(-1);
    const grant = store.recordContinuationRequest({
      message: 'Keep the operator feedback',
      target: {
        stageId: 'worker',
        runId: previousRun.id,
        sessionId: previousRun.session_id,
        cause: 'operator_feedback',
      },
      grant: {
        id: 'fallback-grant',
        taskId: 'CONT-1',
        stageId: 'worker',
        runId: previousRun.id,
        sessionId: previousRun.session_id,
        actor: 'operator',
        reason: 'Keep the operator feedback',
        expectedRevision: previousRun.commit_sha,
        expiresAt: '2026-08-29T00:00:00.000Z',
        idempotencyKey: 'fallback-request',
      },
    });
    const sessions = [];
    const goals = [];
    const harness = {
      run: async (options) => {
        sessions.push(options.resumeSessionId);
        goals.push(options.task.goal);
        if (options.resumeSessionId) {
          const error = new Error('native session not found');

          error.code = 'SESSION_NOT_FOUND';
          throw error;
        }

        return new FakeHarness().run(options);
      },
    };
    const result = await new Scheduler(store, workspaceManager(dir), {
      harnessFactory: () => harness,
      reviewerFactory: () => ({ review: async ({ revision }) => passingReview(revision) }),
    }).runTask(
      'CONT-1',
      'quick',
      'fake',
      null,
      null,
      previousRun.session_id,
      [{ severity: 'blocking', criterion: 'operator', reason: 'Keep the operator feedback' }],
      {
        correctionOnly: true,
        forceSingleWorker: true,
        stageId: 'worker',
        continuationGrantId: grant.id,
      },
    );

    assert.equal(result.state, 'READY');
    assert.deepEqual(sessions, [previousRun.session_id, null]);
    assert.match(goals.at(-1), /Keep the operator feedback/);
    assert.ok(store.listEvents('CONT-1').some((event) => event.type === 'SESSION_RESUME_FALLBACK'));
    assert.equal(store.listOperatorMessages('CONT-1')[0].target.sessionId, previousRun.session_id);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Deep review exhaustion is bounded to three reviews and hands off to a human', async () => {
  const { dir, store } = fixtureStore();

  try {
    store.db
      .prepare("UPDATE tasks SET contract=json_set(contract, '$.profile', 'deep') WHERE id=?")
      .run('CONT-1');
    let reviews = 0;
    const result = await new Scheduler(store, workspaceManager(dir), {
      requirePlanApproval: false,
      reviewerFactory: () => ({
        review: async ({ revision }) => {
          reviews += 1;

          return blockingReview(revision);
        },
      }),
    }).runTask('CONT-1', 'deep', 'fake');
    const exhaustion = store
      .listEvents('CONT-1')
      .filter((event) => event.type === 'REVIEW_EXHAUSTED');

    assert.equal(result.state, 'WAITING_FOR_HUMAN');
    assert.equal(reviews, 3);
    assert.equal(exhaustion.length, 1);
    assert.equal(exhaustion[0].payload.attempts, 3);
    assert.equal(exhaustion[0].payload.findings.length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('review ambiguity hands off immediately without automatic correction', async () => {
  const { dir, store } = fixtureStore();

  try {
    let reviews = 0;
    const result = await new Scheduler(store, workspaceManager(dir), {
      reviewerFactory: () => ({
        review: async ({ revision }) => {
          reviews += 1;

          return { verdict: 'needs_human', findings: [], revision };
        },
      }),
    }).runTask('CONT-1', 'standard', 'fake');
    const exhaustion = store
      .listEvents('CONT-1')
      .find((event) => event.type === 'REVIEW_EXHAUSTED');

    assert.equal(result.state, 'WAITING_FOR_HUMAN');
    assert.equal(reviews, 1);
    assert.equal(store.listRuns('CONT-1').length, 1);
    assert.match(exhaustion.payload.reason, /ambiguity/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('human completion preserves unresolved findings and COMPLETED remains terminal', async () => {
  const { dir, store } = fixtureStore();

  try {
    const scheduler = new Scheduler(store, workspaceManager(dir), {
      reviewerFactory: () => ({
        review: async ({ revision }) => blockingReview(revision),
      }),
    });
    const waiting = await scheduler.runTask('CONT-1', 'standard', 'fake');
    const manifest = store.getResultManifest('CONT-1');
    const findings = store
      .listEvents('CONT-1')
      .filter((event) => event.type === 'REVIEW_EXHAUSTED')
      .at(-1).payload.findings;
    const completion = store.recordCompletion(
      {
        taskId: 'CONT-1',
        expectedRevision: waiting.revision,
        actor: 'human-operator',
        note: 'accepted with known findings',
        reviewOverride: true,
        unresolvedFindings: findings,
        idempotencyKey: 'completion-request',
      },
      manifest,
    );

    assert.equal(completion.actor, 'human-operator');
    assert.equal(completion.manifest.reviewOverride, true);
    assert.deepEqual(completion.manifest.unresolvedFindings, findings);
    assert.equal(store.getTask('CONT-1').state, 'COMPLETED');
    await assert.rejects(
      () => scheduler.runTask('CONT-1', 'standard', 'fake'),
      /already COMPLETED/,
    );
    assert.throws(
      () =>
        store.recordCompletion(
          {
            taskId: 'CONT-1',
            expectedRevision: waiting.revision,
            actor: 'other',
          },
          manifest,
        ),
      /must be READY/,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
