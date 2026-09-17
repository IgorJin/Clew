#!/usr/bin/env node
// Minimal OpenCode server stub for the localhost stand: HTTP + SSE, no
// external provider. It streams a text part, a completed tool part (so
// verification evidence is produced), then an idle status with usage.
import { createServer } from 'node:http';
import { URL } from 'node:url';

const port = Number(process.env.STAND_OPENCODE_PORT ?? process.argv[2] ?? 0);
const host = '127.0.0.1';
const streams = new Set();
let sessionCounter = 0;

function sendJson(response, data, status = 200) {
  const body = JSON.stringify(data);

  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

async function readBody(request) {
  let body = '';

  for await (const chunk of request) body += chunk;

  try {
    return body ? JSON.parse(body) : {};
  } catch {
    return {};
  }
}

function framesFor(sessionId) {
  return [
    {
      type: 'message.part.updated',
      properties: {
        sessionID: sessionId,
        part: { type: 'text', text: 'stand: implementation complete ' },
      },
    },
    {
      type: 'message.part.updated',
      properties: {
        sessionID: sessionId,
        part: {
          type: 'tool',
          tool: 'npm',
          state: {
            status: 'completed',
            input: { command: 'npm test' },
            output: 'stand tests passed',
          },
        },
      },
    },
    {
      type: 'session.status',
      properties: {
        sessionID: sessionId,
        status: { type: 'idle' },
        usage: { inputTokens: 7, outputTokens: 11, model: 'stand-model' },
      },
    },
  ];
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${host}:${server.address()?.port ?? port}`);
  const path = url.pathname;
  const method = request.method ?? 'GET';

  if (method === 'GET' && path === '/global/health')
    return sendJson(response, { healthy: true, version: '9.9.9' });

  if (method === 'POST' && path === '/session') {
    sessionCounter += 1;

    return sendJson(response, { id: `sess-stand-${sessionCounter}` });
  }

  if (method === 'GET' && path === '/event') {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    response.write(
      `event: server.connected\ndata: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`,
    );
    streams.add(response);
    request.on('close', () => streams.delete(response));

    return;
  }

  const prompt = path.match(/^\/session\/([^/]+)\/prompt_async$/);

  if (method === 'POST' && prompt) {
    const sessionId = decodeURIComponent(prompt[1]);
    const payload = framesFor(sessionId)
      .map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`)
      .join('');

    for (const stream of [...streams]) {
      stream.write(payload);
      stream.end();
      streams.delete(stream);
    }

    return sendJson(response, { ok: true });
  }

  const message = path.match(/^\/session\/([^/]+)\/message$/);

  if (method === 'POST' && message)
    return sendJson(response, {
      id: 'msg-stand',
      parts: [
        {
          type: 'tool',
          tool: 'npm',
          state: {
            status: 'completed',
            input: { command: 'npm test' },
            output: 'stand tests passed',
          },
        },
      ],
      usage: { inputTokens: 7, outputTokens: 11, model: 'stand-model' },
    });

  if (method === 'POST' && /^\/session\/[^/]+\/permissions\/[^/]+$/.test(path))
    return sendJson(response, { ok: true });
  if (method === 'POST' && /^\/session\/[^/]+\/abort$/.test(path))
    return sendJson(response, { ok: true });

  await readBody(request);
  sendJson(response, { error: 'not-found', method, path }, 404);
});

server.listen(port, host, () => {
  console.log(
    JSON.stringify({
      event: 'opencode-stub.listening',
      port: server.address().port,
      pid: process.pid,
    }),
  );
});

for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => server.close(() => process.exit(0)));
