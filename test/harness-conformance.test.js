import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadableStream } from 'node:stream/web';
import { TextEncoder } from 'node:util';
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

function createSseResponse(events) {
  const encoder = new TextEncoder();

  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        for (const event of events)
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      },
    }),
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

test('Fake harness scripts approvals, events, verification and failures', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'clew-harness-script-'));
  const events = [];
  const scriptedError = new Error('scripted failure');
  const harness = new FakeHarness({
    approval: { id: 'approval-1', method: 'fixture/requestApproval', params: {} },
    events: [{ type: HARNESS_EVENT_TYPE.TOOL_STARTED, tool: 'fixture-tool' }],
    failures: [null, scriptedError],
    verification: [{ type: 'targeted', result: 'passed', command: 'fixture check' }],
  });
  const options = {
    task: fixtureTask,
    stageId: 'worker',
    cwd: directory,
    onApproval: () => APPROVAL_DECISION.ACCEPT,
    onEvent: (event) => events.push(event),
  };
  const first = await harness.run(options);

  assert.equal(first.verification[0].command, 'fixture check');
  assert.ok(events.some((event) => event.type === HARNESS_EVENT_TYPE.APPROVAL_DECIDED));
  await assert.rejects(harness.run(options), /scripted failure/);
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

test('Codex harness parses structured output from the completed agent message item', async () => {
  const harness = new CodexHarness({
    command: process.execPath,
    args: ['fixtures/fake-codex-server.js', 'structured-item'],
    timeoutMs: 2_000,
  });
  const result = await harness.run({
    task: fixtureTask,
    cwd: process.cwd(),
    onEvent: () => {},
  });

  assert.deepEqual(result.output, { verdict: 'pass', findings: [] });
});

test('Codex harness rejects a failed native turn', async () => {
  const harness = new CodexHarness({
    command: process.execPath,
    args: ['fixtures/fake-codex-server.js', 'failed'],
    timeoutMs: 2_000,
  });

  await assert.rejects(
    harness.run({ task: fixtureTask, cwd: process.cwd(), onEvent: () => {} }),
    /Codex turn failed/,
  );
});

test('Codex harness resumes an existing thread before starting a new turn', async () => {
  const harness = new CodexHarness({
    command: process.execPath,
    args: ['fixtures/fake-codex-server.js'],
    timeoutMs: 2_000,
  });
  const events = [];
  const result = await harness.run({
    task: fixtureTask,
    cwd: process.cwd(),
    resumeSessionId: 'thr_previous',
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.sessionId, 'thr_fixture');
  assert.ok(events.some((event) => event.type === HARNESS_EVENT_TYPE.SESSION_RESUMED));
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
    url.includes('/session?directory=')
      ? createJsonResponse({ id: 'opencode_fixture' })
      : createJsonResponse({});
  const harness = new OpenCodeHarness({ fetchImpl });
  const { result } = await assertSuccessfulLifecycle(harness, process.cwd());

  assert.equal(result.sessionId, 'opencode_fixture');
});

test('OpenCode harness resumes a persisted session without creating a new one', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });

    return createJsonResponse({ id: 'opencode_turn_fixture' });
  };
  const harness = new OpenCodeHarness({ fetchImpl });
  const events = [];
  const result = await harness.run({
    task: fixtureTask,
    cwd: process.cwd(),
    resumeSessionId: 'opencode_existing',
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.sessionId, 'opencode_existing');
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /\/event\?/);
  assert.match(requests[1].url, /session\/opencode_existing\/message$/);
  assert.equal(events[0].type, HARNESS_EVENT_TYPE.SESSION_RESUMED);
});

test('OpenCode harness streams and correlates tool and completion events', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/session?directory=')) return createJsonResponse({ id: 'opencode_stream' });
    if (url.includes('/event?'))
      return createSseResponse([
        { type: 'server.connected', properties: {} },
        {
          type: 'session.status',
          properties: { sessionID: 'opencode_stream', status: { type: 'idle' } },
        },
        {
          type: 'message.part.updated',
          properties: {
            part: {
              sessionID: 'other-session',
              type: 'tool',
              tool: 'ignored',
              state: { status: 'completed' },
            },
          },
        },
        {
          type: 'message.part.updated',
          properties: {
            part: {
              sessionID: 'opencode_stream',
              messageID: 'message-1',
              type: 'tool',
              tool: 'bash',
              state: { status: 'running' },
            },
          },
        },
        {
          type: 'message.part.updated',
          properties: {
            part: {
              sessionID: 'opencode_stream',
              messageID: 'message-1',
              type: 'tool',
              tool: 'bash',
              state: { status: 'completed' },
            },
          },
        },
        {
          type: 'session.status',
          properties: { sessionID: 'opencode_stream', status: { type: 'idle' } },
        },
      ]);

    return createJsonResponse({}, 204);
  };
  const events = [];
  const result = await new OpenCodeHarness({ fetchImpl }).run({
    task: fixtureTask,
    cwd: process.cwd(),
    onEvent: (event) => events.push(event),
  });

  assert.equal(result.turnId, 'message-1');
  assert.deepEqual(
    events
      .filter((event) => event.type === HARNESS_EVENT_TYPE.TOOL_STARTED)
      .map((event) => event.tool),
    ['bash'],
  );
  assert.equal(
    events.filter((event) => event.type === HARNESS_EVENT_TYPE.TOOL_COMPLETED).length,
    1,
  );
  assert.equal(events.at(-1).type, HARNESS_EVENT_TYPE.HARNESS_COMPLETED);
});

test('OpenCode harness preserves provider failure diagnostics from the event stream', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/session?directory=')) return createJsonResponse({ id: 'opencode_failure' });
    if (url.includes('/event?'))
      return createSseResponse([
        {
          type: 'session.status',
          properties: {
            sessionID: 'opencode_failure',
            status: { type: 'retry', message: 'Cannot connect to provider API' },
          },
        },
        { type: 'session.error', properties: { sessionID: 'opencode_failure' } },
      ]);

    return createJsonResponse({}, 204);
  };

  await assert.rejects(
    new OpenCodeHarness({ fetchImpl }).run({
      task: fixtureTask,
      cwd: process.cwd(),
      onEvent: () => {},
    }),
    (error) =>
      error.code === 'EXTERNAL_HARNESS_UNAVAILABLE' &&
      error.message === 'Cannot connect to provider API',
  );
});

test('OpenCode harness exposes AbortSignal interruption', async () => {
  const fetchImpl = (url, options) => {
    if (url.includes('/session?directory='))
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
