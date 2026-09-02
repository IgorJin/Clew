import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
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

test('Codex harness exposes a live app-server endpoint and opens the active thread in a terminal', async () => {
  const endpoint = `unix://${join(tmpdir(), `clew-harness-${Date.now()}.sock`)}`;
  const socketPath = endpoint.slice('unix://'.length);
  const calls = [];
  const terminalBegins = [];
  const terminalHandoffs = [];
  const terminalWrites = [];
  const requests = [];
  let proxyChild;
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();

    child.pid = 41 + calls.length;
    child.kill = () => {};
    child.unref = () => {};
    if (args.includes('--listen')) {
      writeFileSync(socketPath, 'fixture');

      return child;
    }
    if (args[0] === 'app') return child;
    proxyChild = child;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    let input = '';
    const send = (message) =>
      Promise.resolve().then(() => child.stdout.write(`${JSON.stringify(message)}\n`));

    child.stdin.on('data', (chunk) => {
      input += chunk.toString();
      let newline;

      while ((newline = input.indexOf('\n')) >= 0) {
        const line = input.slice(0, newline).trim();

        input = input.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);

        requests.push(message);
        if (message.method === 'initialize') send({ id: message.id, result: {} });
        else if (message.method === 'thread/start')
          send({ id: message.id, result: { thread: { id: 'thread-live' } } });
        else if (message.method === 'thread/name/set') send({ id: message.id, result: {} });
        else if (message.method === 'turn/start') {
          send({ id: message.id, result: { turn: { id: 'turn-live' } } });
          send({
            method: 'item/completed',
            params: {
              item: {
                type: 'commandExecution',
                command: 'npm test',
                exitCode: 0,
                aggregatedOutput: 'passed',
              },
            },
          });
          send({
            method: 'turn/completed',
            params: { threadId: 'thread-live', turn: { id: 'turn-live', status: 'completed' } },
          });
        }
      }
    });

    return child;
  };
  const harness = new CodexHarness({
    command: 'codex-fixture',
    openDesktop: true,
    terminalManager: {
      begin: (options) => terminalBegins.push(options),
      handoff: (id, options) => {
        terminalHandoffs.push({ id, ...options });

        return Promise.resolve(true);
      },
      write: (id, value) => terminalWrites.push({ id, value }),
    },
    spawnImpl,
    timeoutMs: 2_000,
  });
  const result = await harness.run({
    task: fixtureTask,
    stageId: 'worker',
    runId: 'run-live',
    cwd: process.cwd(),
    liveEndpoint: endpoint,
    onEvent: () => {},
  });

  assert.equal(result.sessionId, 'thread-live');
  assert.deepEqual(calls[0].args, ['app-server', '--listen', endpoint]);
  assert.deepEqual(calls[1].args, ['app-server', 'proxy', '--sock', socketPath]);
  assert.deepEqual(calls[2].args, ['app', process.cwd()]);
  assert.equal(terminalBegins.length, 1);
  assert.equal(terminalBegins[0].id, 'run-live');
  assert.equal(terminalBegins[0].sessionId, 'thread-live');
  assert.equal(terminalBegins[0].proxyChild, proxyChild);
  assert.equal(terminalHandoffs.length, 1);
  assert.equal(terminalHandoffs[0].id, 'run-live');
  assert.equal(terminalHandoffs[0].command, 'codex-fixture');
  assert.deepEqual(terminalHandoffs[0].args, ['resume', '--remote', endpoint, 'thread-live']);
  assert.equal(terminalHandoffs[0].cwd, process.cwd());
  assert.equal(
    terminalWrites.some(({ value }) => value.includes('passed')),
    true,
  );
  assert.deepEqual(requests.find((request) => request.method === 'thread/name/set')?.params, {
    threadId: 'thread-live',
    name: `[Clew] ${fixtureTask.id} · worker — ${fixtureTask.title}`,
  });
});

test('daemon Codex harness makes the TUI the sole worker and reads its result after finish', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'clew-harness-interactive-'));
  const socketPath = join(directory, 'codex.sock');
  const endpoint = `unix://${socketPath}`;
  const calls = [];
  const requests = [];
  const terminalStarts = [];
  const identities = [];
  const events = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();

    child.exitCode = null;
    child.kill = () => {
      child.exitCode = 0;
    };
    if (args.includes('--listen')) {
      writeFileSync(socketPath, 'fixture');

      return child;
    }
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    let input = '';
    const send = (message) =>
      Promise.resolve().then(() => child.stdout.write(`${JSON.stringify(message)}\n`));

    child.stdin.on('data', (chunk) => {
      input += chunk.toString();
      let newline;

      while ((newline = input.indexOf('\n')) >= 0) {
        const line = input.slice(0, newline).trim();

        input = input.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);

        requests.push(message);
        if (message.method === 'initialize') send({ id: message.id, result: {} });
        else if (message.method === 'thread/list')
          send({ id: message.id, result: { data: [{ id: 'thread-interactive' }] } });
        else if (message.method === 'thread/name/set') send({ id: message.id, result: {} });
        else if (message.method === 'thread/read')
          send({
            id: message.id,
            result: {
              thread: {
                id: 'thread-interactive',
                turns: [
                  {
                    id: 'turn-interactive',
                    items: [
                      { type: 'commandExecution', command: 'npm test', exitCode: 0 },
                      { type: 'agentMessage', text: 'Implemented interactively.' },
                    ],
                  },
                ],
              },
            },
          });
      }
    });

    return child;
  };
  const terminalManager = {
    start: (options) => terminalStarts.push(options),
    waitForFinish: async () => ({ exitCode: 0 }),
    setSessionIdentity: (id, sessionId) => identities.push({ id, sessionId }),
    release: () => true,
    close: () => true,
  };
  const harness = new CodexHarness({
    command: 'codex-fixture',
    terminalManager,
    spawnImpl,
    startupTimeoutMs: 100,
  });

  try {
    const result = await harness.run({
      task: fixtureTask,
      stageId: 'worker',
      runId: 'run-interactive',
      cwd: directory,
      liveEndpoint: endpoint,
      onEvent: (event) => events.push(event),
    });

    assert.equal(terminalStarts.length, 1);
    assert.equal(terminalStarts[0].command, 'codex-fixture');
    assert.ok(terminalStarts[0].args.includes('--remote'));
    assert.ok(terminalStarts[0].args.includes(endpoint));
    assert.match(terminalStarts[0].args.at(-1), /Work interactively in this terminal/);
    assert.deepEqual(calls[1].args, ['app-server']);
    assert.equal(
      requests.some(({ method }) => method === 'thread/start'),
      false,
    );
    assert.equal(
      requests.some(({ method }) => method === 'turn/start'),
      false,
    );
    assert.equal(
      requests.filter(({ id }) => id !== undefined).every(({ jsonrpc }) => jsonrpc === '2.0'),
      true,
    );
    assert.deepEqual(
      requests.filter(({ method }) => method?.startsWith('thread/')).map(({ method }) => method),
      ['thread/list', 'thread/name/set', 'thread/read'],
    );
    assert.deepEqual(identities, [{ id: 'run-interactive', sessionId: 'thread-interactive' }]);
    assert.equal(result.sessionId, 'thread-interactive');
    assert.equal(result.turnId, 'turn-interactive');
    assert.equal(result.output, 'Implemented interactively.');
    assert.equal(events.at(-1).type, HARNESS_EVENT_TYPE.HARNESS_COMPLETED);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('interactive Codex harness never resumes a synthetic pre-discovery session id', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'clew-harness-synthetic-resume-'));
  const socketPath = join(directory, 'codex.sock');
  const endpoint = `unix://${socketPath}`;
  const terminalStarts = [];
  const spawnImpl = (_command, args) => {
    const child = new EventEmitter();

    child.exitCode = null;
    child.kill = () => {
      child.exitCode = 0;
    };
    if (args.includes('--listen')) writeFileSync(socketPath, 'fixture');
    else {
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stdin.on('data', (chunk) => {
        const request = JSON.parse(String(chunk).trim());
        const result =
          request.method === 'thread/list'
            ? { data: [{ id: 'native-thread', cwd: directory }] }
            : request.method === 'thread/read'
              ? {
                  thread: {
                    id: 'native-thread',
                    turns: [
                      {
                        id: 'native-turn',
                        status: 'completed',
                        items: [{ type: 'agentMessage', text: 'done' }],
                      },
                    ],
                  },
                }
              : {};

        if (request.id !== undefined)
          setTimeout(
            () =>
              child.stdout.write(
                `${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`,
              ),
            0,
          );
      });
    }

    return child;
  };
  const terminalManager = {
    start: (options) => terminalStarts.push(options),
    waitForFinish: async () => ({ exitCode: 0 }),
    updateInteraction: () => true,
    setSessionIdentity: () => true,
    release: () => true,
    close: () => true,
  };
  const harness = new CodexHarness({
    command: 'codex-fixture',
    terminalManager,
    spawnImpl,
    startupTimeoutMs: 100,
  });

  try {
    await harness.run({
      task: fixtureTask,
      stageId: 'worker',
      runId: 'run-synthetic-resume',
      cwd: directory,
      liveEndpoint: endpoint,
      resumeSessionId: 'codex-82d367a2-0d09-4931-922a-10cef71a028f',
      onEvent: () => {},
    });

    assert.equal(terminalStarts[0].args[0], '--remote');
    assert.equal(terminalStarts[0].args.includes('resume'), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
