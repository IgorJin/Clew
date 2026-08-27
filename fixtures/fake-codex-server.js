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
    else if (mode === 'complete') completeTurn('completed');
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
  process.stdout.write(
    `${JSON.stringify({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status }, output: { verdict: 'pass', findings: [] } } })}\n`,
  );
}
