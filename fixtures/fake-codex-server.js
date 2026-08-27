import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') respond(message.id, { userAgent: 'fixture' });
  if (message.method === 'thread/start') respond(message.id, { thread: { id: 'thr_fixture' } });
  if (message.method === 'turn/start') {
    process.stdout.write(
      `${JSON.stringify({ method: 'turn/started', params: { threadId: 'thr_fixture' } })}\n`,
    );
    process.stdout.write(
      `${JSON.stringify({ method: 'turn/completed', params: { status: 'completed', output: { verdict: 'pass', findings: [] } } })}\n`,
    );
  }
});

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}
