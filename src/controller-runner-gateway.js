import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { URL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import {
  RUNNER_MESSAGE_KIND,
  RUNNER_PROTOCOL_MAX_BYTES,
  RUNNER_PROTOCOL_VERSION,
  createRunnerEnvelope,
  negotiateRunnerCompatibility,
  validateRunnerEnvelope,
} from './runner-protocol.js';

export class ControllerRunnerGateway {
  constructor({
    store,
    credential,
    runnerId,
    controllerId = 'controller',
    productVersion = null,
    requiredCapabilities = [],
    path = '/runner/v1',
    heartbeatIntervalMs = 10_000,
    heartbeatTimeoutMs = heartbeatIntervalMs * 3,
    registrationTimeoutMs = 5_000,
    maxPayload = RUNNER_PROTOCOL_MAX_BYTES,
  }) {
    if (!store || typeof store.processRunnerEnvelope !== 'function')
      throw new Error('ControllerRunnerGateway requires a Runner-aware Store');
    if (typeof credential !== 'string' || credential.length === 0)
      throw new Error('ControllerRunnerGateway requires a credential');
    if (typeof runnerId !== 'string' || runnerId.length === 0)
      throw new Error('ControllerRunnerGateway requires a configured Runner identity');
    this.store = store;
    this.credentialDigest = digestCredential(credential);
    this.runnerId = runnerId;
    this.controllerId = controllerId;
    this.productVersion = productVersion;
    this.requiredCapabilities = requiredCapabilities;
    this.path = path;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.registrationTimeoutMs = registrationTimeoutMs;
    this.wss = new WebSocketServer({ noServer: true, maxPayload });
    this.active = null;
    this.server = null;
    this.closing = false;
    this.upgradeHandler = this.handleUpgrade.bind(this);
  }

  attach(server) {
    if (this.server) throw new Error('ControllerRunnerGateway is already attached');
    this.closing = false;
    this.server = server;
    server.on('upgrade', this.upgradeHandler);
    this.healthTimer = setInterval(
      () => this.checkHeartbeatHealth(),
      Math.max(250, Math.min(this.heartbeatIntervalMs, this.heartbeatTimeoutMs)),
    );
    this.healthTimer.unref?.();

    return this;
  }

  handleUpgrade(request, socket, head) {
    let pathname;

    try {
      pathname = new URL(request.url, 'http://localhost').pathname;
    } catch {
      socket.destroy();

      return;
    }
    if (pathname !== this.path) return;
    if (!this.isAuthorized(request.headers.authorization)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();

      return;
    }
    this.wss.handleUpgrade(request, socket, head, (webSocket) => {
      this.handleConnection(webSocket, request);
    });
  }

  isAuthorized(authorization) {
    const value = Array.isArray(authorization) ? authorization[0] : authorization;
    const supplied = typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : '';
    const suppliedDigest = digestCredential(supplied);

    return timingSafeEqual(this.credentialDigest, suppliedDigest);
  }

  handleConnection(webSocket, _request = null) {
    const connection = {
      webSocket,
      connectionId: randomUUID(),
      generation: null,
      registered: false,
      queue: Promise.resolve(),
      closed: false,
    };
    const registrationTimer = setTimeout(() => {
      if (!connection.registered) webSocket.close(1008, 'registration required');
    }, this.registrationTimeoutMs);

    registrationTimer.unref?.();
    webSocket.on('message', (data, isBinary) => {
      connection.queue = connection.queue
        .then(() => this.handleMessage(connection, data, isBinary))
        .catch(() => webSocket.close(1008, 'invalid Runner frame'));
    });
    webSocket.on('close', () => {
      clearTimeout(registrationTimer);
      connection.closed = true;
      if (connection.registered && !this.closing)
        this.store.markRunnerDisconnected({
          runnerId: this.runnerId,
          connectionGeneration: connection.generation,
        });
      if (this.active === connection) this.active = null;
    });
    webSocket.on('error', () => {});

    return connection;
  }

  async handleMessage(connection, data, isBinary) {
    if (isBinary) throw new Error('binary Runner frames are not supported');
    let input;

    try {
      input = JSON.parse(data.toString('utf8'));
    } catch {
      throw new Error('Runner frame must be JSON');
    }
    const envelope = validateRunnerEnvelope(input);

    if (!connection.registered) {
      if (envelope.kind !== RUNNER_MESSAGE_KIND.REGISTER)
        throw new Error('Runner must register before sending frames');
      await this.register(connection, envelope);

      return;
    }
    if (this.active !== connection) throw new Error('superseded Runner connection');
    if (envelope.kind === RUNNER_MESSAGE_KIND.REGISTER)
      throw new Error('Runner is already registered');
    if (envelope.payload.runnerId !== this.runnerId)
      throw new Error('configured Runner identity mismatch');
    if (
      envelope.kind === RUNNER_MESSAGE_KIND.HEARTBEAT &&
      envelope.payload.connectionId !== connection.connectionId
    )
      throw new Error('stale Runner connection identity');
    const response = this.store.processRunnerEnvelope(envelope);

    await sendJson(connection.webSocket, response);
  }

  async register(connection, envelope) {
    if (envelope.payload.runnerId !== this.runnerId)
      throw new Error('configured Runner identity mismatch');
    const compatibility = negotiateRunnerCompatibility({
      controller: {
        protocolVersions: [RUNNER_PROTOCOL_VERSION],
        requiredCapabilities: this.requiredCapabilities,
        productVersion: this.productVersion,
      },
      runner: envelope.payload,
    });
    const projection = this.store.registerRunner({
      runnerId: envelope.payload.runnerId,
      protocolVersion: compatibility.protocolVersion,
      productVersion: compatibility.productVersion,
      capabilities: compatibility.capabilities,
      workspaces: envelope.payload.workspaces,
    });
    const previous = this.active;

    connection.registered = true;
    connection.generation = projection.connectionGeneration;
    this.active = connection;
    const registered = createRunnerEnvelope({
      kind: RUNNER_MESSAGE_KIND.REGISTERED,
      messageId: randomUUID(),
      idempotencyKey: `registration-${connection.connectionId}`,
      correlationId: envelope.correlationId,
      payload: {
        runnerId: this.runnerId,
        protocolVersion: compatibility.protocolVersion,
        controllerId: this.controllerId,
        connectionId: connection.connectionId,
        heartbeatIntervalMs: this.heartbeatIntervalMs,
      },
    });

    await sendJson(connection.webSocket, registered);
    if (previous && previous !== connection && previous.webSocket.readyState === WebSocket.OPEN)
      previous.webSocket.close(4001, 'superseded by a newer registration');
    await this.flushOutbox(connection);
  }

  async flushOutbox(connection = this.active) {
    if (!connection || connection !== this.active || connection.closed) return;
    const commands = this.store.listPendingRunnerCommands(this.runnerId);

    for (const command of commands) {
      if (connection !== this.active || connection.closed) return;
      await sendJson(connection.webSocket, command.envelope);
      this.store.markRunnerCommandSent(command.messageId);
    }
  }

  async send(envelope) {
    const connection = this.active;

    if (!connection || connection.closed || connection.webSocket.readyState !== WebSocket.OPEN)
      return false;
    await sendJson(connection.webSocket, envelope);

    return true;
  }

  status() {
    const runner = this.store.getRunnerProjection(this.runnerId);

    return {
      configured: true,
      connected: Boolean(this.active && !this.active.closed),
      runner: runner
        ? {
            runnerId: runner.runnerId,
            protocolVersion: runner.protocolVersion,
            productVersion: runner.productVersion,
            capabilities: runner.capabilities,
            workspaces: runner.workspaces,
            healthStatus: runner.healthStatus,
            lastSeenAt: runner.lastSeenAt,
          }
        : null,
    };
  }

  checkHeartbeatHealth(now = Date.now()) {
    const connection = this.active;

    if (!connection?.registered || connection.closed) return false;
    const runner = this.store.getRunnerProjection(this.runnerId);
    const lastSeen = Date.parse(runner?.lastSeenAt ?? '');

    if (!Number.isFinite(lastSeen) || now - lastSeen <= this.heartbeatTimeoutMs) return false;
    this.store.markRunnerDisconnected({
      runnerId: this.runnerId,
      connectionGeneration: connection.generation,
      reason: 'heartbeat_timeout',
    });
    connection.webSocket.close(4002, 'heartbeat timeout');

    return true;
  }

  close() {
    this.closing = true;
    if (this.server) this.server.off('upgrade', this.upgradeHandler);
    this.server = null;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    if (this.active?.webSocket.readyState === WebSocket.OPEN)
      this.active.webSocket.close(1001, 'Controller shutting down');
    this.active = null;
    this.wss.close();
  }
}

function digestCredential(value) {
  return createHash('sha256').update(value).digest();
}

function sendJson(webSocket, value) {
  return new Promise((resolve, reject) => {
    if (webSocket.readyState !== WebSocket.OPEN) {
      reject(new Error('Runner connection is not open'));

      return;
    }
    webSocket.send(JSON.stringify(value), (error) => (error ? reject(error) : resolve()));
  });
}
