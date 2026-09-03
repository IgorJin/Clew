import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControllerRunnerGateway } from '../src/controller-runner-gateway.js';
import { PairedExecutionPort } from '../src/execution-port.js';
import { RunnerExecutionPort } from '../src/runner-execution.js';
import { RunnerService } from '../src/runner.js';
import { RunnerStore } from '../src/runner-store.js';
import { RunnerTransport } from '../src/runner-transport.js';
import { Scheduler } from '../src/scheduler.js';
import { Store } from '../src/store.js';
import { PLAN_STATUS, RUN_STATUS, STAGE_STATUS } from '../src/domain.js';

class EvidenceFailureRunnerExecutionPort extends RunnerExecutionPort {
  async accept(offer, context) {
    if (offer.taskId === 'TASK-FAILED')
      return {
        status: 'completed',
        revision: 'runner-failed-evidence',
        summary: 'Native execution completed but verification failed',
        evidence: [
          {
            type: 'command',
            command: 'npm test',
            result: 'failed',
            exitCode: 1,
          },
        ],
      };

    return super.accept(offer, context);
  }
}

async function waitFor(predicate, message, timeoutMs = 3_000) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const value = predicate();

    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${message}`);
}

test('paired Quick, Standard, and Deep fake stages share one durable transport history', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'clew-paired-'));
  const controllerStore = new Store(join(directory, 'controller.sqlite'));
  const runnerStore = new RunnerStore(join(directory, 'runner.sqlite'), {
    configuredRunnerId: 'runner-1',
  });
  const server = createServer();
  const gateway = new ControllerRunnerGateway({
    store: controllerStore,
    credential: 'paired-secret',
    runnerId: 'runner-1',
    requiredCapabilities: ['execute'],
  }).attach(server);

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  } catch (error) {
    gateway.close();
    controllerStore.close();
    runnerStore.close();
    rmSync(directory, { recursive: true, force: true });
    if (error?.code === 'EPERM') {
      t.skip('sandbox disallows local loopback listeners');

      return;
    }
    throw error;
  }
  const port = server.address().port;
  const transport = new RunnerTransport({
    endpoint: `ws://127.0.0.1:${port}/runner/v1`,
    credential: 'paired-secret',
    runnerId: 'runner-1',
    productVersion: '0.6.0',
    capabilities: ['execute', 'runner_local_terminal'],
    workspaces: [{ id: 'clew' }],
    store: runnerStore,
  });
  const runner = new RunnerService({
    store: runnerStore,
    transport,
    closeStore: false,
    executionPort: new EvidenceFailureRunnerExecutionPort({
      workspaces: [{ id: 'clew', path: directory }],
    }),
  });

  try {
    runner.start();
    await waitFor(() => gateway.status().connected, 'Runner registration');
    const paired = new PairedExecutionPort({
      store: controllerStore,
      transport: gateway,
      runnerId: 'runner-1',
    });

    for (const [index, profile] of ['quick', 'standard', 'deep'].entries()) {
      const suffix = index + 1;
      const taskId = `TASK-${suffix}`;
      const task = {
        id: taskId,
        title: `${profile} paired task`,
        goal: 'Execute through the paired Runner',
        profile,
        acceptance: [{ id: 'AC-1', criterion: 'paired result is durable' }],
      };

      controllerStore.createTask(task);
      const scheduler = new Scheduler(
        controllerStore,
        {},
        {
          executionPort: paired,
          interruptPollMs: 10,
        },
      );
      let outcome = await scheduler.runTask(taskId, profile, 'fake');

      if (profile === 'deep') {
        assert.equal(outcome.state, 'WAITING_FOR_HUMAN');
        controllerStore.decideLatestPlan(taskId, PLAN_STATUS.APPROVED, {
          actor: 'paired-acceptance',
        });
        outcome = await scheduler.runTask(taskId, profile, 'fake');
      }

      assert.equal(outcome.state, 'READY');
      assert.equal(controllerStore.getTask(taskId).state, 'READY');
      const runs = controllerStore.listRuns(taskId);
      const leases = controllerStore.listRunnerLeases().filter((item) => item.taskId === taskId);

      assert.equal(leases.length, profile === 'deep' ? 4 : 1);
      assert.equal(runs.length, leases.length);
      assert.ok(
        leases.every(
          (lease) =>
            lease.state === 'completed' &&
            controllerStore.getRunnerLeaseResult(lease.id).result.status === 'completed',
        ),
      );
      assert.ok(runs.every((run) => run.execution_mode === 'paired' && run.workspace === null));
      const events = controllerStore.listEvents(taskId).map((event) => event.type);

      assert.equal(events.includes('REVIEW_RECORDED'), profile !== 'quick');
      if (profile === 'deep') {
        assert.ok(events.includes('ARCHITECT_COMPLETED'));
        assert.ok(events.includes('PLAN_APPROVAL_REQUIRED'));
        assert.ok(events.includes('INTEGRATION_COMPLETED'));
        assert.deepEqual(
          controllerStore
            .listStages(taskId)
            .filter((stage) => stage.id !== 'control-architect')
            .map((stage) => stage.id)
            .sort(),
          ['backend', 'frontend', 'integration'],
        );
      }
    }
    const failedTask = {
      id: 'TASK-FAILED',
      title: 'paired verification failure',
      goal: 'Do not leave a completed native turn represented as running',
      profile: 'quick',
      acceptance: [{ id: 'AC-1', criterion: 'failure state is durable' }],
    };

    controllerStore.createTask(failedTask);
    const failedScheduler = new Scheduler(
      controllerStore,
      {},
      { executionPort: paired, interruptPollMs: 10 },
    );

    await assert.rejects(
      failedScheduler.runTask(failedTask.id, 'quick', 'fake'),
      /without passing verification evidence/,
    );
    assert.equal(controllerStore.getTask(failedTask.id).state, 'FAILED');
    assert.equal(controllerStore.listRuns(failedTask.id).at(-1).status, RUN_STATUS.FAILED);
    assert.equal(controllerStore.listStages(failedTask.id).at(-1).status, STAGE_STATUS.FAILED);
    await waitFor(() => runnerStore.status().outbox.entries === 0, 'Runner outbox ACK cleanup');
    assert.equal(controllerStore.listRunnerLeases().length, 7);
    assert.equal(JSON.stringify(gateway.status()).includes('paired-secret'), false);
  } finally {
    await runner.stop();
    runnerStore.close();
    gateway.close();
    await new Promise((resolve) => server.close(resolve));
    controllerStore.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
