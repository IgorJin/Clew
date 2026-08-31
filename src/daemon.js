import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, relative } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import pino from 'pino';
import WebSocket, { WebSocketServer } from 'ws';
import { Store } from './store.js';
import { ClewService } from './control-service.js';
import { loadConfig } from './config.js';
import { Observability } from './observability.js';
import { isPublicThreadEvent } from './thread.js';
import {
  validateApiEnvelope,
  validateWebSocketEvent,
  assertReplayCursor,
} from './control-plane.js';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const UI_ROOT = join(PACKAGE_ROOT, 'ui', 'dist');
const DAEMON_VERSION = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;

export const DEFAULT_DAEMON_PORT = 43176;
const DAEMON_FILES = ['daemon.json', 'daemon.lock', 'daemon.token', 'daemon.stderr.log'];
const ASSET_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

function daemonPaths(cwd) {
  const stateDirectory = join(resolve(cwd), '.clew');

  return {
    stateDirectory,
    metadata: join(stateDirectory, 'daemon.json'),
    lock: join(stateDirectory, 'daemon.lock'),
    token: join(stateDirectory, 'daemon.token'),
    log: join(stateDirectory, 'daemon.log'),
    stderrLog: join(stateDirectory, 'daemon.stderr.log'),
  };
}

function removeDaemonState(cwd) {
  const { stateDirectory } = daemonPaths(cwd);

  for (const file of DAEMON_FILES) rmSync(join(stateDirectory, file), { force: true });
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;

  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 1_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function json(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function commandLogFields(args) {
  const [command, subcommand, ...rest] = args;
  const taskId =
    command === 'task'
      ? subcommand === 'create'
        ? undefined
        : rest[0]
      : [
            'approve',
            'complete',
            'continue',
            'events',
            'interrupt',
            'plan',
            'retry',
            'run',
            'status',
            'verify',
          ].includes(command)
        ? subcommand
        : undefined;

  return {
    command: [command, subcommand].filter(Boolean).join('.'),
    ...(taskId && !taskId.startsWith('--') ? { taskId } : {}),
  };
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

  if (value?.startsWith('Bearer ')) return value.slice(7);
  const cookie = request.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('clew_token='));

  return cookie?.slice('clew_token='.length) ?? null;
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
    this.webSocketServer = null;
    this.heartbeat = null;
    this.store = null;
    this.control = null;
    this.observability = null;
    this.logger = null;
    this.running = false;
    this.commandQueue = Promise.resolve();
  }

  async start() {
    if (this.running) throw new Error('daemon is already running');
    mkdirSync(this.stateDir, { recursive: true });
    try {
      this.lockFd = openSync(this.lockPath, 'wx', 0o600);
    } catch {
      const status = await daemonStatus(this.cwd);

      if (status.status === 'running' || status.status === 'unreachable')
        throw new Error(`daemon state directory is already owned: ${this.stateDir}`);
      removeDaemonState(this.cwd);
      this.lockFd = openSync(this.lockPath, 'wx', 0o600);
    }
    const token = randomBytes(32).toString('hex');

    writeFileSync(this.tokenPath, `${token}\n`, { mode: 0o600 });
    chmodSync(this.tokenPath, 0o600);
    this.logger = pino(
      {
        level: process.env.CLEW_LOG_LEVEL ?? 'info',
        base: { service: 'clew-daemon', version: DAEMON_VERSION },
      },
      pino.destination({ dest: daemonPaths(this.cwd).log, mkdir: true, sync: true }),
    );
    this.store = new Store(join(this.stateDir, 'clew.sqlite'));
    const config = loadConfig(this.cwd);

    this.observability = new Observability({
      cwd: this.cwd,
      config: config.observability,
      store: this.store,
    });
    this.store.setEventObserver((event) => {
      this.observability.onEvent(event);
      this.broadcastEvents();
    });
    this.control = new ClewService({ cwd: this.cwd, store: this.store, config });
    this.server = createServer((request, response) => this.handle(request, response));
    this.webSocketServer = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: 1_000_000,
    });
    this.server.on('upgrade', (request, socket, head) =>
      this.handleUpgrade(request, socket, head, token),
    );
    this.heartbeat = setInterval(() => {
      for (const client of this.clients.keys()) {
        if (client.isAlive === false) {
          client.terminate();
          continue;
        }
        client.isAlive = false;
        client.ping();
      }
    }, 30_000);
    this.heartbeat.unref();
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
        logFile: daemonPaths(this.cwd).log,
        stderrLogFile: daemonPaths(this.cwd).stderrLog,
      };

      writeFileSync(this.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
      chmodSync(this.metadataPath, 0o600);
      this.metadata = metadata;
      this.running = true;
      this.logger.info(
        { event: 'daemon.started', daemonId: metadata.daemonId, endpoint: metadata.endpoint },
        'daemon started',
      );
    });

    return await new Promise((resolveStart, rejectStart) => {
      this.server.once('listening', () => resolveStart(this.metadata));
      this.server.once('error', rejectStart);
    });
  }

  async stop() {
    if (!this.server) return;
    this.logger?.info({ event: 'daemon.stopping', clients: this.clients.size }, 'daemon stopping');
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const client of this.clients.keys()) client.terminate();
    this.clients.clear();
    await new Promise((resolveClose) => this.webSocketServer.close(resolveClose));
    await new Promise((resolveClose) => this.server.close(resolveClose));
    await this.observability?.shutdown();
    this.observability = null;
    this.store?.close();
    this.store = null;
    this.control = null;
    this.running = false;
    this.logger?.info({ event: 'daemon.stopped' }, 'daemon stopped');
    this.logger?.flush();
    this.logger = null;
    if (existsSync(this.metadataPath)) unlinkSync(this.metadataPath);
    if (existsSync(this.tokenPath)) unlinkSync(this.tokenPath);
    if (this.lockFd !== null) {
      closeSync(this.lockFd);
      this.lockFd = null;
    }
    if (existsSync(this.lockPath)) unlinkSync(this.lockPath);
    this.server = null;
    this.webSocketServer = null;
  }

  authenticate(request) {
    if (tokenFrom(request) !== readFileSync(this.tokenPath, 'utf8').trim())
      throw new Error('unauthorized');
  }

  async handle(request, response) {
    const startedAt = process.hrtime.bigint();
    const pathname = new URL(request.url, this.metadata.endpoint).pathname;

    response.once('finish', () => {
      this.logger?.info(
        {
          event: 'http.request',
          method: request.method,
          path: pathname,
          statusCode: response.statusCode,
          durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
        },
        'HTTP request completed',
      );
    });
    try {
      if (
        request.method === 'GET' &&
        (pathname === '/' || pathname === '/index.html' || pathname.startsWith('/tasks/'))
      )
        return this.uiIndex(response);
      if (request.method === 'GET' && pathname.startsWith('/assets/'))
        return this.asset(pathname, response);
      if (request.method === 'GET' && pathname === '/api/v1/bootstrap') {
        const origin = request.headers.origin;
        const referer = request.headers.referer;
        let refererOrigin = null;

        try {
          refererOrigin = referer ? new URL(referer).origin : null;
        } catch {
          refererOrigin = null;
        }

        if (origin !== this.metadata.endpoint && refererOrigin !== this.metadata.endpoint)
          return json(response, 403, {
            version: 1,
            code: 'ORIGIN_REJECTED',
            message: 'bootstrap origin rejected',
            retryable: false,
          });
        response.writeHead(204, {
          'cache-control': 'no-store',
          ...(origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {}),
          'set-cookie': [
            `clew_token=${readFileSync(this.tokenPath, 'utf8').trim()}; Path=/; SameSite=Strict; HttpOnly`,
          ],
        });
        response.end();

        return;
      }
      this.authenticate(request);
      if (request.method === 'GET' && request.url === '/api/v1/health')
        return json(response, 200, {
          version: DAEMON_VERSION,
          daemonId: this.metadata.daemonId,
          endpoint: this.metadata.endpoint,
          stateDirectory: this.stateDir,
          status: 'running',
        });
      if (request.method === 'GET' && request.url === '/api/v1/snapshot')
        return json(response, 200, this.control.snapshot());
      if (request.method === 'POST' && request.url === '/api/v1/shutdown') {
        json(response, 202, { version: 1, status: 'stopping' });
        Promise.resolve().then(() => this.stop());

        return;
      }
      if (request.method === 'GET' && request.url.startsWith('/api/v1/events'))
        return this.events(request, response);
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
        !['service.execute', 'cli.execute'].includes(envelope.name) ||
        !Array.isArray(envelope.payload?.args)
      )
        throw new Error('expected service.execute command');
      const result = await this.dispatch(envelope.payload.args);

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

      this.logger?.warn(
        {
          event: 'http.request.failed',
          method: request.method,
          path: pathname,
          error: error.message,
        },
        'HTTP request failed',
      );

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

  dispatch(args) {
    const isLiveInspection =
      args[0] === 'session' &&
      args[1] === 'open' &&
      args.includes('--surface') &&
      args[args.indexOf('--surface') + 1] === 'live' &&
      args.includes('--mode') &&
      args[args.indexOf('--mode') + 1] === 'live';

    return isLiveInspection ? this.executeCommand(args) : this.enqueue(args);
  }

  executeCommand(args) {
    const fields = commandLogFields(args);
    const startedAt = process.hrtime.bigint();

    this.logger?.info({ event: 'command.started', ...fields }, 'command started');

    return this.control.execute(args).then(
      (result) => {
        this.logger?.info(
          {
            event: 'command.completed',
            ...fields,
            durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
          },
          'command completed',
        );

        return result;
      },
      (error) => {
        this.logger?.warn(
          {
            event: 'command.failed',
            ...fields,
            durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
            error: error.message,
          },
          'command failed',
        );
        throw error;
      },
    );
  }

  enqueue(args) {
    const next = this.commandQueue.then(() => this.executeCommand(args));

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

  asset(pathname, response) {
    const requested = resolve(UI_ROOT, `.${pathname}`);

    if (relative(UI_ROOT, requested).startsWith('..') || !existsSync(requested))
      return json(response, 404, {
        code: 'ASSET_NOT_FOUND',
        message: 'asset not found',
        retryable: false,
      });
    response.writeHead(200, {
      'content-type': ASSET_TYPES[extname(requested)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(readFileSync(requested));
  }

  uiIndex(response) {
    const path = join(UI_ROOT, 'index.html');

    if (!existsSync(path))
      return json(response, 404, {
        code: 'UI_NOT_BUILT',
        message: 'UI assets are not built',
        retryable: false,
      });
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(readFileSync(path));
  }

  handleUpgrade(request, socket, head, token) {
    const authenticated = tokenFrom(request) === token;
    const sameOrigin = request.headers.origin === this.metadata.endpoint;
    const upgrading = request.headers.upgrade?.toLowerCase() === 'websocket';

    if (!authenticated || !sameOrigin || !upgrading) {
      this.logger?.warn(
        { event: 'websocket.rejected', authenticated, sameOrigin, upgrading },
        'WebSocket rejected',
      );

      return socket.destroy();
    }
    this.webSocketServer.handleUpgrade(request, socket, head, (client) => {
      this.webSocketServer.emit('connection', client, request);
      this.attachWebSocket(client, request);
    });
  }

  attachWebSocket(client, request) {
    const after = Number(
      new URL(request.url, this.metadata.endpoint).searchParams.get('after') ?? 0,
    );

    client.isAlive = true;
    this.clients.set(client, after);
    this.logger?.info(
      { event: 'websocket.connected', after, clients: this.clients.size },
      'WebSocket connected',
    );
    client.on('pong', () => {
      client.isAlive = true;
    });
    client.on('close', (code) => {
      this.clients.delete(client);
      this.logger?.info(
        { event: 'websocket.closed', code, clients: this.clients.size },
        'WebSocket closed',
      );
    });
    client.on('error', (error) => {
      this.clients.delete(client);
      this.logger?.warn(
        { event: 'websocket.error', code: error.code, error: error.message },
        'WebSocket error',
      );
    });
    this.sendEvents(client, after);
  }

  sendEvents(socket, after) {
    const rows = this.store.db
      .prepare('SELECT seq,task_id,type,payload,at FROM events WHERE seq>? ORDER BY seq')
      .all(after);

    for (const item of rows) {
      this.clients.set(socket, item.seq);
      if (!isPublicThreadEvent({ type: item.type })) continue;
      if (socket.readyState !== WebSocket.OPEN) break;
      const event = validateWebSocketEvent({
        version: 1,
        cursor: item.seq,
        eventId: `event-${item.seq}`,
        type: item.type,
        at: item.at,
        taskId: item.task_id,
        payload: JSON.parse(item.payload),
      });

      socket.send(JSON.stringify(event));
    }
    if (rows.length)
      this.logger?.debug(
        { event: 'websocket.replayed', count: rows.length, after, nextCursor: rows.at(-1).seq },
        'WebSocket events replayed',
      );
  }

  broadcastEvents() {
    for (const [client, cursor] of this.clients) this.sendEvents(client, cursor);
  }
}

export function readDaemonMetadata(cwd = process.cwd()) {
  const path = daemonPaths(cwd).metadata;

  if (!existsSync(path)) throw new Error('daemon is not running');

  return JSON.parse(readFileSync(path, 'utf8'));
}

export function daemonLogFile(cwd = process.cwd()) {
  return daemonPaths(cwd).log;
}

export async function daemonStatus(cwd = process.cwd()) {
  let metadata;

  try {
    metadata = readDaemonMetadata(cwd);
  } catch {
    return { status: 'stopped', healthy: false };
  }

  try {
    const token = readFileSync(metadata.tokenFile, 'utf8').trim();
    const response = await fetchWithTimeout(`${metadata.endpoint}/api/v1/health`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const health = await response.json();

    if (!response.ok || health.daemonId !== metadata.daemonId)
      throw new Error('daemon health identity mismatch');

    return { ...metadata, status: 'running', healthy: true };
  } catch {
    return {
      ...metadata,
      status: isProcessAlive(metadata.pid) ? 'unreachable' : 'stale',
      healthy: false,
    };
  }
}

export async function startDaemonProcess(
  cwd = process.cwd(),
  { port = DEFAULT_DAEMON_PORT, timeoutMs = 8_000 } = {},
) {
  const existing = await daemonStatus(cwd);

  if (existing.status === 'running') return { ...existing, alreadyRunning: true };
  if (existing.status === 'unreachable')
    throw new Error(
      `daemon process ${existing.pid} is alive but its health endpoint is unreachable`,
    );
  if (existing.status === 'stale') removeDaemonState(cwd);
  const paths = daemonPaths(cwd);

  mkdirSync(paths.stateDirectory, { recursive: true });
  const stderrFd = openSync(paths.stderrLog, 'a', 0o600);
  const child = spawn(
    process.execPath,
    [join(PACKAGE_ROOT, 'bin', 'clew.js'), 'daemon', 'serve', '--port', String(port)],
    {
      cwd: resolve(cwd),
      detached: true,
      stdio: ['ignore', stderrFd, stderrFd],
    },
  );

  closeSync(stderrFd);
  child.unref();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const status = await daemonStatus(cwd);

    if (status.status === 'running')
      return { ...status, logFile: paths.log, stderrLogFile: paths.stderrLog };
    if (child.exitCode !== null)
      throw new Error(`daemon exited during startup; inspect ${paths.log}`);
    await delay(50);
  }

  throw new Error(`daemon startup timed out; inspect ${paths.log}`);
}

export async function daemonRequest(cwd, args) {
  const metadata = readDaemonMetadata(cwd);
  const token = readFileSync(metadata.tokenFile, 'utf8').trim();
  let response;

  try {
    response = await fetchWithTimeout(
      `${metadata.endpoint}/api/v1/command`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          requestId: randomUUID(),
          kind: 'command',
          name: 'service.execute',
          payload: { args },
        }),
      },
      30_000,
    );
  } catch (error) {
    throw new Error('daemon is unavailable; run `clew daemon start`', { cause: error });
  }
  const body = await response.json();

  if (!response.ok)
    throw new Error(body.error?.message ?? `daemon request failed: ${response.status}`);

  return body.payload;
}

export async function stopDaemon(cwd = process.cwd()) {
  const status = await daemonStatus(cwd);

  if (status.status !== 'running') {
    if (status.status === 'stale') removeDaemonState(cwd);
    if (status.status === 'unreachable')
      throw new Error(
        `daemon process ${status.pid} is alive but its health endpoint is unreachable`,
      );

    return { version: 1, status: status.status === 'stale' ? 'stale-cleaned' : 'stopped' };
  }
  const metadata = status;
  const token = readFileSync(metadata.tokenFile, 'utf8').trim();
  const response = await fetchWithTimeout(`${metadata.endpoint}/api/v1/shutdown`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });

  if (!response.ok) throw new Error(`daemon shutdown failed: HTTP ${response.status}`);

  return response.json();
}
