import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { Store } from './store.js';
import {
  validateApiEnvelope,
  validateWebSocketEvent,
  assertReplayCursor,
} from './control-plane.js';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DAEMON_VERSION = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;

function json(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    let body = '';

    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error('request body is too large'));
    });
    request.on('end', () => {
      try {
        resolveBody(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error(`invalid JSON: ${error.message}`));
      }
    });
    request.on('error', reject);
  });
}

function tokenFrom(request) {
  const value = request.headers.authorization;

  return value?.startsWith('Bearer ') ? value.slice(7) : null;
}

function runCli(args, cwd) {
  const cliArgs =
    args[0] === 'task' && args[1] === 'create' && !args.includes('--json')
      ? [...args, '--json']
      : args;

  return new Promise((resolveRun, reject) => {
    execFile(
      process.execPath,
      [join(PACKAGE_ROOT, 'bin/clew.js'), ...cliArgs],
      {
        cwd,
        env: { ...process.env, CLEW_DAEMON_EXECUTION: '1' },
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error)
          reject(
            Object.assign(new Error(stderr.trim() || error.message), {
              code: error.code,
              stdout,
              stderr,
            }),
          );
        else resolveRun(stdout.trim() ? JSON.parse(stdout) : null);
      },
    );
  });
}

export class LocalDaemon {
  constructor({ cwd = process.cwd(), port = 0 } = {}) {
    this.cwd = resolve(cwd);
    this.stateDir = join(this.cwd, '.clew');
    this.port = port;
    this.lockPath = join(this.stateDir, 'daemon.lock');
    this.metadataPath = join(this.stateDir, 'daemon.json');
    this.tokenPath = join(this.stateDir, 'daemon.token');
    this.clients = new Map();
    this.lockFd = null;
    this.server = null;
    this.store = null;
    this.running = false;
    this.commandQueue = Promise.resolve();
  }

  start() {
    if (this.running) throw new Error('daemon is already running');
    mkdirSync(this.stateDir, { recursive: true });
    try {
      this.lockFd = openSync(this.lockPath, 'wx', 0o600);
    } catch {
      throw new Error(`daemon state directory is already owned: ${this.stateDir}`);
    }
    const token = randomBytes(32).toString('hex');

    writeFileSync(this.tokenPath, `${token}\n`, { mode: 0o600 });
    chmodSync(this.tokenPath, 0o600);
    this.store = new Store(join(this.stateDir, 'clew.sqlite'));
    this.server = createServer((request, response) => this.handle(request, response));
    this.server.on('upgrade', (request, socket) => this.handleUpgrade(request, socket, token));
    this.server.listen(this.port, '127.0.0.1');
    this.server.once('listening', () => {
      const address = this.server.address();
      const metadata = {
        version: DAEMON_VERSION,
        daemonId: randomUUID(),
        stateDirectory: this.stateDir,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        endpoint: `http://127.0.0.1:${address.port}`,
        tokenFile: this.tokenPath,
      };

      writeFileSync(this.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
      chmodSync(this.metadataPath, 0o600);
      this.metadata = metadata;
      this.running = true;
    });

    return new Promise((resolveStart, rejectStart) => {
      this.server.once('listening', () => resolveStart(this.metadata));
      this.server.once('error', rejectStart);
    });
  }

  async stop() {
    if (!this.server) return;
    for (const client of this.clients.keys()) client.end();
    await new Promise((resolveClose) => this.server.close(resolveClose));
    this.store?.close();
    this.store = null;
    this.running = false;
    if (existsSync(this.metadataPath)) unlinkSync(this.metadataPath);
    if (existsSync(this.tokenPath)) unlinkSync(this.tokenPath);
    if (this.lockFd !== null) {
      closeSync(this.lockFd);
      this.lockFd = null;
    }
    if (existsSync(this.lockPath)) unlinkSync(this.lockPath);
    this.server = null;
  }

  authenticate(request) {
    if (tokenFrom(request) !== readFileSync(this.tokenPath, 'utf8').trim())
      throw new Error('unauthorized');
  }

  async handle(request, response) {
    try {
      this.authenticate(request);
      if (request.method === 'GET' && request.url === '/api/v1/health')
        return json(response, 200, {
          version: DAEMON_VERSION,
          endpoint: this.metadata.endpoint,
          stateDirectory: this.stateDir,
          status: 'running',
        });
      if (request.method === 'POST' && request.url === '/api/v1/shutdown') {
        json(response, 202, { version: 1, status: 'stopping' });
        Promise.resolve().then(() => this.stop());

        return;
      }
      if (request.method === 'GET' && request.url.startsWith('/api/v1/events'))
        return this.events(request, response);
      if (request.method === 'GET' && request.url.startsWith('/assets/'))
        return this.asset(request, response);
      if (request.method !== 'POST' || request.url !== '/api/v1/command')
        return json(response, 404, {
          version: 1,
          code: 'NOT_FOUND',
          message: 'route not found',
          retryable: false,
        });
      const envelope = validateApiEnvelope(await readBody(request));

      if (
        envelope.kind !== 'command' ||
        envelope.name !== 'cli.execute' ||
        !Array.isArray(envelope.payload?.args)
      )
        throw new Error('expected cli.execute command');
      const result = await this.enqueue(envelope.payload.args);

      this.broadcastEvents();

      return json(response, 200, {
        version: 1,
        requestId: envelope.requestId,
        kind: 'response',
        name: envelope.name,
        payload: result,
      });
    } catch (error) {
      const unauthorized = error.message === 'unauthorized';

      return json(response, unauthorized ? 401 : 400, {
        version: 1,
        requestId: randomUUID(),
        kind: 'error',
        error: {
          code: unauthorized ? 'UNAUTHORIZED' : 'BAD_REQUEST',
          message: unauthorized ? 'unauthorized' : error.message,
          retryable: false,
        },
      });
    }
  }

  enqueue(args) {
    const next = this.commandQueue.then(() => runCli(args, this.cwd));

    this.commandQueue = next.catch(() => undefined);

    return next;
  }

  events(request, response) {
    const url = new URL(request.url, this.metadata.endpoint);
    const after = Number(url.searchParams.get('after') ?? 0);
    const row = this.store.db
      .prepare('SELECT MIN(seq) AS oldest, MAX(seq) AS newest FROM events')
      .get();

    assertReplayCursor({ requestedAfter: after, oldest: row.oldest ?? 1, newest: row.newest ?? 0 });
    const events = this.store.db
      .prepare('SELECT seq,task_id,type,payload,at FROM events WHERE seq>? ORDER BY seq')
      .all(after)
      .map((item) =>
        validateWebSocketEvent({
          version: 1,
          cursor: item.seq,
          eventId: `event-${item.seq}`,
          type: item.type,
          at: item.at,
          taskId: item.task_id,
          payload: JSON.parse(item.payload),
        }),
      );

    return json(response, 200, { version: 1, events, nextCursor: events.at(-1)?.cursor ?? after });
  }

  asset(request, response) {
    const root = join(this.cwd, '.clew', 'ui');
    const requested = resolve(
      root,
      `.${new URL(request.url, this.metadata.endpoint).pathname.slice('/assets'.length)}`,
    );

    if (relative(root, requested).startsWith('..') || !existsSync(requested))
      return json(response, 404, {
        code: 'ASSET_NOT_FOUND',
        message: 'asset not found',
        retryable: false,
      });
    response.writeHead(200, { 'cache-control': 'no-store' });
    response.end(readFileSync(requested));
  }

  handleUpgrade(request, socket, token) {
    if (tokenFrom(request) !== token || request.headers.upgrade?.toLowerCase() !== 'websocket')
      return socket.destroy();
    const key = request.headers['sec-websocket-key'];

    if (!key) return socket.destroy();
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');

    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const after = Number(
      new URL(request.url, this.metadata.endpoint).searchParams.get('after') ?? 0,
    );

    this.clients.set(socket, after);
    socket.on('close', () => this.clients.delete(socket));
    socket.on('error', () => this.clients.delete(socket));
    this.sendEvents(socket, after);
  }

  sendEvents(socket, after) {
    const rows = this.store.db
      .prepare('SELECT seq,task_id,type,payload,at FROM events WHERE seq>? ORDER BY seq')
      .all(after);

    for (const item of rows) {
      const event = validateWebSocketEvent({
        version: 1,
        cursor: item.seq,
        eventId: `event-${item.seq}`,
        type: item.type,
        at: item.at,
        taskId: item.task_id,
        payload: JSON.parse(item.payload),
      });
      const body = Buffer.from(JSON.stringify(event));
      const header =
        body.length < 126
          ? Buffer.from([0x81, body.length])
          : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);

      socket.write(Buffer.concat([header, body]));
      this.clients.set(socket, item.seq);
    }
  }

  broadcastEvents() {
    for (const [client, cursor] of this.clients) this.sendEvents(client, cursor);
  }
}

export function readDaemonMetadata(cwd = process.cwd()) {
  const path = join(resolve(cwd), '.clew', 'daemon.json');

  if (!existsSync(path)) throw new Error('daemon is not running');

  return JSON.parse(readFileSync(path, 'utf8'));
}

export async function daemonRequest(cwd, args) {
  const metadata = readDaemonMetadata(cwd);
  const token = readFileSync(metadata.tokenFile, 'utf8').trim();
  const response = await fetch(`${metadata.endpoint}/api/v1/command`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      version: 1,
      requestId: randomUUID(),
      kind: 'command',
      name: 'cli.execute',
      payload: { args },
    }),
  });
  const body = await response.json();

  if (!response.ok)
    throw new Error(body.error?.message ?? `daemon request failed: ${response.status}`);

  return body.payload;
}

export async function stopDaemon(cwd = process.cwd()) {
  const metadata = readDaemonMetadata(cwd);
  const token = readFileSync(metadata.tokenFile, 'utf8').trim();
  const response = await fetch(`${metadata.endpoint}/api/v1/shutdown`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });

  if (!response.ok) throw new Error(`daemon shutdown failed: HTTP ${response.status}`);

  return response.json();
}
