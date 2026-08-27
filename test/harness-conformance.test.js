import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APPROVAL_DECISION,
  CodexHarness,
  FakeHarness,
  HARNESS_EVENT_TYPE,
  HarnessInterruptedError,
  HarnessTimeoutError,
  OpenCodeHarness,
} from '../src/harness.js';

const fixtureTask = Object.freeze({
  id: 'HARNESS-1',
  title: 'Harness conformance',
  goal: 'Exercise the normalized harness lifecycle',
  acceptance: [{ id: 'AC-1', criterion: 'the lifecycle is correlated' }],
});

function createJsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

async function assertSuccessfulLifecycle(harness, cwd) {
  const events = [];
  const result = await harness.run({
    task: fixtureTask,
    stageId: 'worker',
    cwd,
    onEvent: (event) => events.push(event),
  });
  const eventTypes = events.map((event) => event.type);

  assert.ok(result.sessionId);
  assert.ok(eventTypes.indexOf(HARNESS_EVENT_TYPE.SESSION_STARTED) >= 0);
  assert.ok(
    eventTypes.indexOf(HARNESS_EVENT_TYPE.SESSION_STARTED) <
      eventTypes.indexOf(HARNESS_EVENT_TYPE.TURN_STARTED),
  );
  assert.ok(
    eventTypes.indexOf(HARNESS_EVENT_TYPE.TURN_STARTED) <
      eventTypes.indexOf(HARNESS_EVENT_TYPE.HARNESS_COMPLETED),
  );
  assert.equal(
    events.filter((event) =>
      [
        HARNESS_EVENT_TYPE.HARNESS_COMPLETED,
        HARNESS_EVENT_TYPE.HARNESS_INTERRUPTED,
        HARNESS_EVENT_TYPE.HARNESS_TIMED_OUT,
        HARNESS_EVENT_TYPE.HARNESS_FAILED,
      ].includes(event.type),
    ).length,
    1,
  );
  assert.ok(events.every((event) => event.sessionId === result.sessionId));

  return { events, result };
}

test('Fake harness conforms to the normalized successful lifecycle', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'clew-harness-fake-'));

  try {
    await assertSuccessfulLifecycle(new FakeHarness(), directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Fake harness exposes deterministic AbortSignal interruption', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'clew-harness-interrupt-'));
  const controller = new AbortController();
  const events = [];
  const run = new FakeHarness({ delayMs: 1_000 }).run({
    task: fixtureTask,
    stageId: 'worker',
    cwd: directory,
    signal: controller.signal,
    onEvent: (event) => events.push(event),
  });

  controller.abort();
  await assert.rejects(run, HarnessInterruptedError);
  assert.equal(events.at(-1).type, HARNESS_EVENT_TYPE.HARNESS_INTERRUPTED);
  rmSync(directory, { recursive: true, force: true });
});

test('Codex harness conforms and persists native thread and turn identity', async () => {
  const harness = new CodexHarness({
    command: process.execPath,
    args: ['fixtures/fake-codex-server.js'],
    timeoutMs: 2_000,
  });
  const { result } = await assertSuccessfulLifecycle(harness, process.cwd());

  assert.equal(result.sessionId, 'thr_fixture');
  assert.equal(result.turnId, 'turn_fixture');
});

test('Codex harness routes approval requests through an explicit decision callback', async () => {
  const harness = new CodexHarness({
    command: process.execPath,
    args: ['fixtures/fake-codex-server.js', 'approval'],
    timeoutMs: 2_000,
  });
  const events = [];

  await harness.run({
    task: fixtureTask,
    cwd: process.cwd(),
    onApproval: () => APPROVAL_DECISION.ACCEPT,
    onEvent: (event) => events.push(event),
  });

  assert.equal(
    events.find((event) => event.type === HARNESS_EVENT_TYPE.APPROVAL_DECIDED)?.decision,
    APPROVAL_DECISION.ACCEPT,
  );
});

test('Codex harness uses turn/interrupt and reports an interrupted terminal event', async () => {
  const harness = new CodexHarness({
    command: process.execPath,
    args: ['fixtures/fake-codex-server.js', 'wait'],
    timeoutMs: 2_000,
    interruptTimeoutMs: 500,
  });
  const controller = new AbortController();
  const events = [];
  const run = harness.run({
    task: fixtureTask,
    cwd: process.cwd(),
    signal: controller.signal,
    onEvent: (event) => {
      events.push(event);
      if (event.type === HARNESS_EVENT_TYPE.TURN_STARTED) controller.abort();
    },
  });

  await assert.rejects(run, HarnessInterruptedError);
  assert.ok(events.some((event) => event.type === HARNESS_EVENT_TYPE.INTERRUPT_REQUESTED));
  assert.equal(events.at(-1).type, HARNESS_EVENT_TYPE.HARNESS_INTERRUPTED);
});

test('Codex harness reports timeout as a normalized terminal failure', async () => {
  const harness = new CodexHarness({
    command: process.execPath,
    args: ['fixtures/fake-codex-server.js', 'wait'],
    timeoutMs: 30,
  });
  const events = [];

  await assert.rejects(
    harness.run({
      task: fixtureTask,
      cwd: process.cwd(),
      onEvent: (event) => events.push(event),
    }),
    HarnessTimeoutError,
  );
  assert.equal(events.at(-1).type, HARNESS_EVENT_TYPE.HARNESS_TIMED_OUT);
});

test('OpenCode harness conforms to the normalized successful lifecycle', async () => {
  const fetchImpl = async (url) =>
    url.endsWith('/session')
      ? createJsonResponse({ id: 'opencode_fixture' })
      : createJsonResponse({});
  const harness = new OpenCodeHarness({ fetchImpl });
  const { result } = await assertSuccessfulLifecycle(harness, process.cwd());

  assert.equal(result.sessionId, 'opencode_fixture');
});

test('OpenCode harness exposes AbortSignal interruption', async () => {
  const fetchImpl = (url, options) => {
    if (url.endsWith('/session'))
      return Promise.resolve(createJsonResponse({ id: 'opencode_interrupt_fixture' }));

    return new Promise((_resolve, reject) => {
      if (options.signal.aborted) {
        reject(new Error('The operation was aborted'));

        return;
      }
      options.signal.addEventListener(
        'abort',
        () => reject(new Error('The operation was aborted')),
        { once: true },
      );
    });
  };
  const harness = new OpenCodeHarness({ fetchImpl, timeoutMs: 2_000 });
  const controller = new AbortController();
  const events = [];
  const run = harness.run({
    task: fixtureTask,
    cwd: process.cwd(),
    signal: controller.signal,
    onEvent: (event) => {
      events.push(event);
      if (event.type === HARNESS_EVENT_TYPE.TURN_STARTED) controller.abort();
    },
  });

  await assert.rejects(run, HarnessInterruptedError);
  assert.equal(events.at(-1).type, HARNESS_EVENT_TYPE.HARNESS_INTERRUPTED);
});
