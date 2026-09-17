import readline from 'node:readline';

// Deterministic stand-in for the Codex app-server used by the localhost
// stand. Unlike fixtures/fake-codex-server.js it returns a valid execution
// plan, so the Deep profile can run without a real Codex CLI.
const rl = readline.createInterface({ input: process.stdin });
const threadId = 'thr_stand_plan';
const turnId = 'turn_stand_plan';
const PLAN = {
  parallelizable: false,
  stages: [
    {
      id: 'implementation',
      kind: 'worker',
      harness: null,
      goal: 'Implement the change',
      dependsOn: [],
    },
    {
      id: 'integration',
      kind: 'integration',
      harness: null,
      goal: 'Integrate and verify',
      dependsOn: ['implementation'],
    },
  ],
};

rl.on('line', (line) => {
  const message = JSON.parse(line);

  if (message.method === 'initialize') response(message.id, { userAgent: 'clew-stand' });
  if (message.method === 'thread/start' || message.method === 'thread/resume')
    response(message.id, { thread: { id: threadId } });
  if (message.method === 'turn/start') {
    response(message.id, { turn: { id: turnId, status: 'inProgress' } });
    process.stdout.write(
      `${JSON.stringify({ method: 'item/completed', params: { threadId, turnId, completedAtMs: Date.now(), item: { id: 'cmd_stand', type: 'commandExecution', command: 'npm test', commandActions: [], cwd: process.cwd(), status: 'completed', exitCode: 0, aggregatedOutput: 'stand tests passed' } } })}\n`,
    );
    process.stdout.write(
      `${JSON.stringify({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' }, output: PLAN } })}\n`,
    );
  }
  if (message.method === 'turn/interrupt') {
    response(message.id, {});
    process.stdout.write(
      `${JSON.stringify({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'interrupted' } } })}\n`,
    );
  }
});

function response(id, result) {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}
