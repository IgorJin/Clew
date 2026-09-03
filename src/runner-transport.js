import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import {
  RUNNER_MESSAGE_KIND,
  RUNNER_PROTOCOL_VERSION,
  assertSecureRunnerEndpoint,
  createRunnerEnvelope,
  validateRunnerEnvelope,
} from './runner-protocol.js';

const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_RECONNECT = Object.freeze({ initialMs: 250, maximumMs: 30_000, factor: 2 });

function safeLog(logger, level, message, fields = {}) {
  logger?.[level]?.(fields, message);
}

function socketIsOpen(socket) {
  return socket?.readyState === WebSocket.OPEN || socket?.readyState === 1;
}

export class RunnerTransport extends EventEmitter {
  constructor({
    endpoint,
    credential,
    runnerId,
    productVersion,
    capabilities = [],
    workspaces = [],
    store,
    logger,
    webSocketFactory = (url, options) => new WebSocket(url, options),
    reconnect = DEFAULT_RECONNECT,
    random = Math.random,
  }) {
    super();
    this.endpoint = assertSecureRunnerEndpoint(endpoint);
    if (typeof credential !== 'string' || credential.length === 0)
      throw new Error('Runner credential is required');
    if (!store) throw new Error('Runner store is required');
    this.credential = credential;
    this.runnerId = runnerId;
    this.productVersion = productVersion;
    this.capabilities = [...new Set(capabilities)].sort();
    this.workspaces = [...new Set(workspaces)].sort();
    this.store = store;
    this.logger = logger;
    this.webSocketFactory = webSocketFactory;
    this.random = random;
    this.reconnect = {
      initialMs: reconnect.initialMs ?? DEFAULT_RECONNECT.initialMs,
      maximumMs: reconnect.maximumMs ?? DEFAULT_RECONNECT.maximumMs,
      factor: reconnect.factor ?? DEFAULT_RECONNECT.factor,
    };
    for (const [name, value] of Object.entries(this.reconnect)) {
      if (!Number.isFinite(value) || value <= 0)
        throw new Error(`reconnect.${name} must be positive`);
    }
    if (this.reconnect.factor < 1) throw new Error('reconnect.factor must be >= 1');
    this.socket = null;
    this.started = false;
    this.registered = false;
    this.connectionId = null;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.generation = 0;
    this.lastErrorCode = null;
    this.connecting = false;
    this.sentThisConnection = new Set();
  }

  start({ signal } = {}) {
    if (this.started) return;
    this.started = true;
    this.abortSignal = signal;
    if (signal) {
      if (signal.aborted) return this.close();
      signal.addEventListener('abort', () => this.close(), { once: true });
    }
    this.#connect();
  }

  #connect() {
    if (!this.started || this.connecting || this.socket) return;
    this.connecting = true;
    this.registered = false;
    this.connectionId = null;
    const generation = ++this.generation;
    let socket;

    try {
      socket = this.webSocketFactory(this.endpoint.href, {
        headers: { Authorization: `Bearer ${this.credential}` },
      });
    } catch (error) {
      this.connecting = false;
      this.#handleFailure(error, generation);

      return;
    }
    this.socket = socket;
    socket.on('open', () => this.#onOpen(generation));
    socket.on('message', (data) => this.#onMessage(data, generation));
    socket.on('error', (error) => this.#onError(error, generation));
    socket.on('close', () => this.#onClose(generation));
  }

  #onOpen(generation) {
    if (!this.started || generation !== this.generation) return;
    this.connecting = false;
    safeLog(this.logger, 'info', 'Runner transport connected');
    const registration = createRunnerEnvelope({
      kind: RUNNER_MESSAGE_KIND.REGISTER,
      messageId: randomUUID(),
      idempotencyKey: `register:${this.runnerId}:${generation}`,
      correlationId: randomUUID(),
      payload: {
        runnerId: this.runnerId,
        productVersion: this.productVersion,
        protocolVersions: [RUNNER_PROTOCOL_VERSION],
        capabilities: this.capabilities,
        workspaces: this.workspaces,
        startedAt: new Date().toISOString(),
      },
    });

    this.socket.send(JSON.stringify(registration));
  }

  #onMessage(data, generation) {
    if (!this.started || generation !== this.generation) return;
    try {
      const envelope = validateRunnerEnvelope(JSON.parse(String(data)));

      if (envelope.kind === RUNNER_MESSAGE_KIND.REGISTERED) {
        if (envelope.payload.runnerId !== this.runnerId)
          throw new Error('Controller registered a different Runner identity');
        this.registered = true;
        this.connectionId = envelope.payload.connectionId ?? envelope.correlationId;
        this.reconnectAttempt = 0;
        this.lastErrorCode = null;
        this.sentThisConnection.clear();
        this.#startHeartbeat(envelope.payload.heartbeatIntervalMs);
        this.#flush();
        this.emit('registered', {
          connectionId: this.connectionId,
          protocolVersion: envelope.payload.protocolVersion,
        });

        return;
      }
      if (!this.registered) throw new Error('Controller message received before registration');
      if (envelope.payload.runnerId !== this.runnerId)
        throw new Error('Controller message targets a different Runner');
      if (envelope.kind === RUNNER_MESSAGE_KIND.ACK) {
        this.store.acknowledge({ messageId: envelope.payload.ackedMessageId });
        this.sentThisConnection.delete(envelope.payload.ackedMessageId);
        this.#flush();

        return;
      }
      this.emit('envelope', envelope);
    } catch (error) {
      this.lastErrorCode = 'INVALID_MESSAGE';
      safeLog(this.logger, 'warn', 'Runner transport rejected Controller message', {
        code: this.lastErrorCode,
      });
      this.emit('protocolError', error);
      this.socket?.close(1008, 'invalid protocol message');
    }
  }

  #onError(error, generation) {
    if (generation !== this.generation) return;
    this.lastErrorCode = error?.code ?? 'SOCKET_ERROR';
    safeLog(this.logger, 'warn', 'Runner transport socket error', { code: this.lastErrorCode });
    this.emit('transportError', error);
  }

  #onClose(generation) {
    if (generation !== this.generation) return;
    this.#clearHeartbeat();
    this.socket = null;
    this.connecting = false;
    this.registered = false;
    this.connectionId = null;
    this.sentThisConnection.clear();
    this.emit('disconnected');
    if (this.started) this.#scheduleReconnect();
  }

  #handleFailure(error, generation) {
    if (generation !== this.generation) return;
    this.lastErrorCode = error?.code ?? 'CONNECT_ERROR';
    safeLog(this.logger, 'warn', 'Runner transport connection failed', {
      code: this.lastErrorCode,
    });
    this.emit('transportError', error);
    this.#scheduleReconnect();
  }

  #scheduleReconnect() {
    if (!this.started || this.reconnectTimer) return;
    const base = Math.min(
      this.reconnect.maximumMs,
      this.reconnect.initialMs * this.reconnect.factor ** this.reconnectAttempt,
    );
    const delay = Math.max(1, Math.round(base * (0.5 + this.random() * 0.5)));

    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.#connect();
    }, delay);
    this.reconnectTimer.unref?.();
    this.emit('reconnecting', { attempt: this.reconnectAttempt, delayMs: delay });
  }

  #startHeartbeat(requestedInterval) {
    this.#clearHeartbeat();
    const interval =
      Number.isSafeInteger(requestedInterval) && requestedInterval >= 1_000
        ? requestedInterval
        : DEFAULT_HEARTBEAT_MS;

    this.heartbeatTimer = setInterval(() => {
      if (!this.registered || !socketIsOpen(this.socket)) return;
      const heartbeat = createRunnerEnvelope({
        kind: RUNNER_MESSAGE_KIND.HEARTBEAT,
        messageId: randomUUID(),
        idempotencyKey: `heartbeat:${randomUUID()}`,
        correlationId: this.connectionId,
        payload: {
          runnerId: this.runnerId,
          connectionId: this.connectionId,
          activeLeaseIds: this.store.listActiveExecutions().map(({ leaseId }) => leaseId),
          status: 'ready',
        },
      });

      this.socket.send(JSON.stringify(heartbeat));
    }, interval);
    this.heartbeatTimer.unref?.();
  }

  #clearHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  #flush() {
    if (!this.registered || !socketIsOpen(this.socket)) return;
    for (const item of this.store.pendingOutbox()) {
      if (!socketIsOpen(this.socket)) break;
      if (this.sentThisConnection.has(item.envelope.messageId)) continue;
      this.socket.send(JSON.stringify(item.envelope));
      this.store.markAttempt(item.envelope.messageId);
      this.sentThisConnection.add(item.envelope.messageId);
    }
  }

  send(envelope) {
    const validated = validateRunnerEnvelope(envelope);

    if (!this.store.hasPending(validated.messageId))
      throw new Error('Runner transport can only send a persisted outbox message');
    this.#flush();
  }

  reconnectNow() {
    if (!this.started) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;

    this.socket = null;
    this.connecting = false;
    this.registered = false;
    this.connectionId = null;
    this.sentThisConnection.clear();
    this.generation += 1;
    socket?.close();
    this.#connect();
  }

  close() {
    if (!this.started && !this.socket) return;
    this.started = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.#clearHeartbeat();
    const socket = this.socket;

    this.socket = null;
    this.connecting = false;
    this.registered = false;
    this.connectionId = null;
    this.sentThisConnection.clear();
    this.generation += 1;
    socket?.close(1000, 'Runner stopping');
  }

  status() {
    return Object.freeze({
      started: this.started,
      connected: socketIsOpen(this.socket),
      registered: this.registered,
      reconnectAttempt: this.reconnectAttempt,
      lastErrorCode: this.lastErrorCode,
    });
  }
}
