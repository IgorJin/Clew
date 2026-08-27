import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
const mode = process.argv[2] || 'complete';
const threadId = 'thr_fixture';
const turnId = 'turn_fixture';
const approvalRequestId = 900;

rl.on('line', (line) => {
  const message = JSON.parse(line);

  if (message.method === 'initialize') sendRpcResponse(message.id, { userAgent: 'fixture' });
  if (message.method === 'thread/start' || message.method === 'thread/resume')
    sendRpcResponse(message.id, { thread: { id: threadId } });
  if (message.method === 'turn/start') {
    sendRpcResponse(message.id, { turn: { id: turnId, status: 'inProgress' } });
    process.stdout.write(
      `${JSON.stringify({ method: 'turn/started', params: { threadId, turn: { id: turnId } } })}\n`,
    );
    if (mode === 'approval')
      process.stdout.write(
        `${JSON.stringify({ id: approvalRequestId, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId: 'item_fixture', command: ['npm', 'test'] } })}\n`,
      );
    else if (['complete', 'structured-item'].includes(mode)) completeTurn('completed');
    else if (mode === 'failed') completeTurn('failed');
  }
  if (message.method === 'turn/interrupt') {
    sendRpcResponse(message.id, {});
    completeTurn('interrupted');
  }
  if (message.id === approvalRequestId && message.result?.decision) completeTurn('completed');
});

function sendRpcResponse(id, result) {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

function completeTurn(status) {
  if (status === 'completed' && mode === 'structured-item')
    process.stdout.write(
      `${JSON.stringify({ method: 'item/completed', params: { threadId, turnId, completedAtMs: Date.now(), item: { id: 'message_fixture', type: 'agentMessage', text: '{"verdict":"pass","findings":[]}' } } })}\n`,
    );
  else if (status === 'completed')
    process.stdout.write(
      `${JSON.stringify({ method: 'item/completed', params: { threadId, turnId, completedAtMs: Date.now(), item: { id: 'command_fixture', type: 'commandExecution', command: 'npm test', commandActions: [], cwd: process.cwd(), status: 'completed', exitCode: 0, aggregatedOutput: 'tests passed' } } })}\n`,
    );
  const params = { threadId, turn: { id: turnId, status } };

  if (mode !== 'structured-item') params.output = { verdict: 'pass', findings: [] };
  process.stdout.write(`${JSON.stringify({ method: 'turn/completed', params })}\n`);
}
