import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { Store } from '../src/store.js';
import { createRepositoryContext, repositoryContextChecksum } from '../src/scout-context.js';
import { HarnessInterruptedError } from '../src/harness.js';
import { SCOUT_EVENT, SCOUT_STATUS, ScoutRunner } from '../src/scout-runner.js';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function taskContract(id = 'SCOUT-1') {
  return {
    id,
    title: 'Scout execution fixture',
    goal: 'Inspect a read-only commit snapshot',
    profile: 'quick',
    risk: 'low',
    base_ref: 'HEAD',
    acceptance: [{ id: 'AC-1', criterion: 'The context is published atomically' }],
  };
}

function setupRepository() {
  const cwd = mkdtempSync(join(tmpdir(), 'clew-scout-execution-'));

  git(cwd, ['init', '-b', 'main']);
  git(cwd, ['config', 'user.email', 'test@example.com']);
  git(cwd, ['config', 'user.name', 'Clew Test']);
  writeFileSync(join(cwd, '.gitignore'), '.clew/\n');
  writeFileSync(join(cwd, 'README.md'), '# Scout fixture\n');
  writeFileSync(join(cwd, 'package.json'), '{"name":"scout-fixture","scripts":{"test":"true"}}\n');
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'src', 'index.js'), 'export const value = 1;\n');
  git(cwd, ['add', '.gitignore', 'README.md', 'package.json', 'src/index.js']);
  git(cwd, ['commit', '-m', 'fixture']);

  const store = new Store(join(cwd, '.clew', 'clew.sqlite'));

  return { cwd, store };
}

function outputFor(path = 'README.md', purpose = 'A committed fixture file') {
  return {
    components: [
      {
        id: 'readme',
        path,
        purpose,
        references: [{ path, revision: '__REVISION__' }],
      },
    ],
    relationships: [],
    checks: [],
    observations: [
      {
        kind: 'observed',
        statement: 'The file exists in the selected commit.',
        references: [{ path, revision: '__REVISION__' }],
      },
    ],
    unknowns: [],
    omissions: [],
  };
}

function makeHarness(outputFactory, { delayMs = 0, command = null } = {}) {
  return {
    async run({ scoutRequest, onEvent, signal }) {
      if (command) onEvent({ type: 'COMMAND_STARTED', command });
      if (delayMs) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);

          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(new HarnessInterruptedError('test scout harness'));
            },
            { once: true },
          );
        });
      }
      const output = outputFactory(scoutRequest.repository.revision);

      return { sessionId: 'test-session', output };
    },
  };
}

function createRunner(cwd, store, harnessFactory = null) {
  return new ScoutRunner({
    cwd,
    store,
    config: { worktreeRoot: cwd, codexBin: 'codex', openCodeUrl: 'http://127.0.0.1:4096' },
    harnessFactory,
  });
}

function cleanup({ cwd, store }) {
  store?.close();
  rmSync(cwd, { recursive: true, force: true });
}

const cliFile = fileURLToPath(new URL('../bin/clew.js', import.meta.url));

function runCli(args, cwd) {
  return execFileSync(process.execPath, [cliFile, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('group 1: fake Scout runs against a commit snapshot and publishes an idempotent context', async () => {
  const fixture = setupRepository();

  try {
    fixture.store.createTask(taskContract());
    const runner = createRunner(fixture.cwd, fixture.store);
    const first = await runner.run('SCOUT-1', ['SCOUT-1', '--harness', 'fake']);

    assert.equal(first.status, SCOUT_STATUS.COMPLETED);
    assert.equal(first.duplicate, false);
    assert.equal(first.dirtyChanges, false);
    assert.equal(first.context.provenance.runtime.harness, 'fake');
    assert.ok(first.context.components.length > 0);
    assert.ok(existsSync(join(fixture.cwd, first.path)));
    assert.equal(git(fixture.cwd, ['status', '--porcelain']).trim(), '');
    assert.equal(existsSync(join(fixture.cwd, '.clew-runs')), false);

    const duplicate = await runner.run('SCOUT-1', ['SCOUT-1', '--harness', 'fake']);

    assert.equal(duplicate.status, SCOUT_STATUS.COMPLETED);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.checksum, first.checksum);
    assert.equal(
      fixture.store.listEvents('SCOUT-1').filter((event) => event.type === SCOUT_EVENT.PUBLISHED)
        .length,
      1,
    );
    assert.equal(runner.show('SCOUT-1').context.provenance.checksum, first.checksum);
  } finally {
    cleanup(fixture);
  }
});

test('group 1: dirty checkout is reported while uncommitted files stay out of the context', async () => {
  const fixture = setupRepository();

  try {
    fixture.store.createTask(taskContract());
    writeFileSync(join(fixture.cwd, 'uncommitted.js'), 'should not be inspected\n');
    const runner = createRunner(fixture.cwd, fixture.store);
    const result = await runner.run('SCOUT-1', [
      'SCOUT-1',
      '--harness',
      'fake',
      '--request-id',
      'dirty-request',
      '--attempt-id',
      'dirty-attempt',
    ]);

    assert.equal(result.status, SCOUT_STATUS.COMPLETED);
    assert.equal(result.dirtyChanges, true);
    assert.equal(
      result.context.components.some((component) => component.path === 'uncommitted.js'),
      false,
    );
    assert.equal(result.context.source.revision, git(fixture.cwd, ['rev-parse', 'HEAD']).trim());
  } finally {
    cleanup(fixture);
  }
});

test('group 1: the CLI exposes scout run and human show output', () => {
  const fixture = setupRepository();

  try {
    fixture.store.close();
    fixture.store = null;
    runCli(
      [
        'task',
        'create',
        '--id',
        'SCOUT-CLI',
        '--title',
        'CLI scout',
        '--description',
        'Inspect a committed fixture',
      ],
      fixture.cwd,
    );
    const result = JSON.parse(
      runCli(['task', 'scout', 'SCOUT-CLI', '--harness', 'fake'], fixture.cwd),
    );
    const human = runCli(['task', 'scout', 'show', 'SCOUT-CLI', '--human'], fixture.cwd);

    assert.equal(result.status, SCOUT_STATUS.COMPLETED);
    assert.match(human, /Scout: completed/);
    assert.match(human, /Dirty changes present: no/);
  } finally {
    cleanup(fixture);
  }
});

test('group 2: invalid, forbidden, and oversized harness output never publishes a context', async () => {
  const cases = [
    {
      requestId: 'invalid-output',
      harness: makeHarness(() => ({ nope: true })),
      error: /scout output\.components must be an array/,
    },
    {
      requestId: 'forbidden-command',
      harness: makeHarness(
        (revision) => {
          const output = outputFor();

          output.components[0].references[0].revision = revision;
          output.observations[0].references[0].revision = revision;

          return output;
        },
        { command: 'npm test' },
      ),
      error: /forbidden tool command/,
    },
    {
      requestId: 'invalid-line-range',
      harness: makeHarness((revision) => {
        const output = outputFor();

        output.components[0].references[0].revision = revision;
        output.components[0].references[0].lineStart = 999;
        output.observations[0].references[0].revision = revision;

        return output;
      }),
      error: /line range exceeds README\.md/,
    },
    {
      requestId: 'oversized-output',
      harness: makeHarness((revision) => {
        const output = outputFor();

        output.observations[0].references[0].revision = revision;
        output.components = Array.from({ length: 40 }, (_, index) => ({
          id: `file-${index}`,
          path: 'README.md',
          purpose: `component ${index} ${'x'.repeat(1_900)}`,
          references: [{ path: 'README.md', revision }],
        }));

        return output;
      }),
      error: /exceeds 65536 UTF-8 bytes/,
    },
  ];

  for (const item of cases) {
    const fixture = setupRepository();

    try {
      fixture.store.createTask(taskContract());
      const runner = createRunner(fixture.cwd, fixture.store, () => item.harness);
      const result = await runner.run('SCOUT-1', [
        'SCOUT-1',
        '--harness',
        'fake',
        '--request-id',
        item.requestId,
        '--attempt-id',
        item.requestId,
      ]);

      assert.ok([SCOUT_STATUS.FAILED, SCOUT_STATUS.INTERRUPTED].includes(result.status));
      assert.match(result.error, item.error);
      assert.equal(
        fixture.store.listEvents('SCOUT-1').some((event) => event.type === SCOUT_EVENT.PUBLISHED),
        false,
      );
      assert.equal(existsSync(join(fixture.cwd, '.clew', 'scout', 'SCOUT-1')), false);
    } finally {
      cleanup(fixture);
    }
  }
});

test('group 2: timeout and cancel leave an explicit retryable interruption', async () => {
  const fixture = setupRepository();

  try {
    fixture.store.createTask(taskContract());
    const runner = createRunner(fixture.cwd, fixture.store, () =>
      makeHarness(
        (revision) => ({
          ...outputFor(),
          components: [
            { ...outputFor().components[0], references: [{ path: 'README.md', revision }] },
          ],
        }),
        { delayMs: 500 },
      ),
    );
    const timedOut = await runner.run('SCOUT-1', [
      'SCOUT-1',
      '--harness',
      'fake',
      '--request-id',
      'timeout-request',
      '--attempt-id',
      'timeout-request',
      '--timeout-ms',
      '100',
    ]);

    assert.equal(timedOut.status, SCOUT_STATUS.FAILED);
    assert.match(timedOut.error, /timed out/i);

    const cancelRunner = createRunner(fixture.cwd, fixture.store, () =>
      makeHarness(
        (revision) => ({
          ...outputFor(),
          components: [
            { ...outputFor().components[0], references: [{ path: 'README.md', revision }] },
          ],
        }),
        { delayMs: 500 },
      ),
    );
    const pending = cancelRunner.run('SCOUT-1', [
      'SCOUT-1',
      '--harness',
      'fake',
      '--request-id',
      'cancel-request',
      '--attempt-id',
      'cancel-request',
    ]);

    await delay(20);
    const cancellation = cancelRunner.cancel('SCOUT-1', [
      'cancel',
      'SCOUT-1',
      '--request-id',
      'cancel-request',
    ]);
    const cancelled = await pending;

    assert.equal(cancellation.status, SCOUT_STATUS.CANCELLED);
    assert.equal(cancelled.status, SCOUT_STATUS.CANCELLED);
    assert.equal(cancelled.retryRequired, true);
  } finally {
    cleanup(fixture);
  }
});

test('group 3: interrupted requests require a new attempt and a file without its event is recovered', async () => {
  const fixture = setupRepository();

  try {
    fixture.store.createTask(taskContract());
    const runner = createRunner(fixture.cwd, fixture.store);
    const requestInfo = runner.requestFor(fixture.store.getTask('SCOUT-1'), [
      'SCOUT-1',
      '--harness',
      'fake',
      '--request-id',
      'interrupted-request',
      '--attempt-id',
      'interrupted-request',
    ]);

    fixture.store.appendEvent('SCOUT-1', SCOUT_EVENT.REQUESTED, {
      requestId: requestInfo.request.requestId,
      attemptId: requestInfo.request.attemptId,
      revision: requestInfo.metadata.revision,
      dirtyChanges: requestInfo.metadata.dirty,
      ownerPid: 999999,
      status: SCOUT_STATUS.RUNNING,
    });
    const interrupted = await runner.run('SCOUT-1', [
      'SCOUT-1',
      '--harness',
      'fake',
      '--request-id',
      'interrupted-request',
      '--attempt-id',
      'interrupted-request',
    ]);

    assert.equal(interrupted.status, SCOUT_STATUS.INTERRUPTED);
    assert.equal(interrupted.duplicate, true);

    const recoveryRequest = runner.requestFor(fixture.store.getTask('SCOUT-1'), [
      'SCOUT-1',
      '--harness',
      'fake',
      '--request-id',
      'recovery-request',
      '--attempt-id',
      'recovery-attempt',
    ]);
    const recoveryContext = createRepositoryContext({
      request: recoveryRequest.request,
      generatedAt: '2026-09-11T11:00:00.000Z',
      runtime: { harness: 'fake' },
      components: [
        {
          id: 'readme',
          path: 'README.md',
          purpose: 'Recovered context file',
          references: [{ path: 'README.md', revision: recoveryRequest.metadata.revision }],
        },
      ],
      observations: [
        {
          kind: 'observed',
          statement: 'The recovered file belongs to the selected commit.',
          references: [{ path: 'README.md', revision: recoveryRequest.metadata.revision }],
        },
      ],
    });
    const recoveryPath = join(
      fixture.cwd,
      '.clew',
      'scout',
      'SCOUT-1',
      `${recoveryContext.contextId}.json`,
    );

    mkdirSync(join(fixture.cwd, '.clew', 'scout', 'SCOUT-1'), { recursive: true });
    writeFileSync(recoveryPath, `${JSON.stringify(recoveryContext)}\n`);
    fixture.store.appendEvent('SCOUT-1', SCOUT_EVENT.REQUESTED, {
      requestId: recoveryRequest.request.requestId,
      attemptId: recoveryRequest.request.attemptId,
      revision: recoveryRequest.metadata.revision,
      dirtyChanges: recoveryRequest.metadata.dirty,
      ownerPid: 999999,
      status: SCOUT_STATUS.RUNNING,
    });
    const recovered = await runner.run('SCOUT-1', [
      'SCOUT-1',
      '--harness',
      'fake',
      '--request-id',
      'recovery-request',
      '--attempt-id',
      'recovery-attempt',
    ]);

    assert.equal(recovered.status, SCOUT_STATUS.COMPLETED);
    assert.equal(recovered.duplicate, true);
    assert.equal(recovered.checksum, repositoryContextChecksum(recoveryContext));
    assert.equal(
      fixture.store.listEvents('SCOUT-1').some((event) => event.type === SCOUT_EVENT.RECOVERED),
      true,
    );
  } finally {
    cleanup(fixture);
  }
});

test('group 3: concurrent duplicate requests claim one durable attempt', async () => {
  const fixture = setupRepository();

  try {
    fixture.store.createTask(taskContract());
    let harnessCalls = 0;
    const harnessFactory = () => {
      harnessCalls += 1;

      return makeHarness(
        (revision) => {
          const output = outputFor();

          output.components[0].references[0].revision = revision;
          output.observations[0].references[0].revision = revision;

          return output;
        },
        { delayMs: 50 },
      );
    };
    const runnerA = createRunner(fixture.cwd, fixture.store, harnessFactory);
    const runnerB = createRunner(fixture.cwd, fixture.store, harnessFactory);
    const args = [
      'SCOUT-1',
      '--harness',
      'fake',
      '--request-id',
      'concurrent-request',
      '--attempt-id',
      'concurrent-request',
    ];
    const [first, second] = await Promise.all([
      runnerA.run('SCOUT-1', args),
      runnerB.run('SCOUT-1', args),
    ]);

    assert.equal(harnessCalls, 1);
    assert.deepEqual(
      [first.status, second.status].sort(),
      [SCOUT_STATUS.COMPLETED, SCOUT_STATUS.RUNNING].sort(),
    );
    assert.equal(
      fixture.store.listEvents('SCOUT-1').filter((event) => event.type === SCOUT_EVENT.REQUESTED)
        .length,
      1,
    );
  } finally {
    cleanup(fixture);
  }
});
