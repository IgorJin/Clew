import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { LEASE_STATE, RUNNER_MESSAGE_KIND, createRunnerEnvelope } from './runner-protocol.js';

const TERMINAL_STATES = new Set([LEASE_STATE.COMPLETED, LEASE_STATE.FAILED, LEASE_STATE.CANCELLED]);

async function settleWithDeadline(promise, deadlineMs) {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    await promise;

    return true;
  }
  let timer;
  const settled = await Promise.race([
    promise.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), deadlineMs);
      timer.unref?.();
    }),
  ]);

  if (timer) clearTimeout(timer);

  return settled;
}

export class RunnerService extends EventEmitter {
  constructor({ store, transport, executionPort, logger, closeStore = true }) {
    super();
    if (!store || !transport || !executionPort)
      throw new Error('RunnerService requires store, transport and executionPort');
    this.store = store;
    this.transport = transport;
    this.executionPort = executionPort;
    this.logger = logger;
    this.closeStore = closeStore;
    this.identity = null;
    this.started = false;
    this.stopping = false;
    this.storeClosed = false;
    this.lastPersistenceStatus = null;
    this.controllers = new Map();
    this.activeOperations = new Set();
    this.onEnvelope = (envelope) => this.#receive(envelope);
    this.onTransportError = (error) => this.emit('transportError', error);
  }

  start({ signal } = {}) {
    if (this.started) return this.status();
    if (this.storeClosed) throw new Error('RunnerService cannot restart after its store is closed');
    if (this.stopping) throw new Error('RunnerService is stopping');
    this.identity = this.store.getOrCreateIdentity();
    this.store.markActiveExecutionsRecovering();
    this.started = true;
    this.transport.on('envelope', this.onEnvelope);
    this.transport.on('transportError', this.onTransportError);
    this.transport.start({ signal });

    return this.status();
  }

  #envelope(kind, inbound, payload) {
    return createRunnerEnvelope({
      kind,
      messageId: randomUUID(),
      idempotencyKey: `response:${inbound.idempotencyKey}`,
      correlationId: inbound.messageId,
      payload: { runnerId: this.identity.runnerId, ...payload },
    });
  }

  #eventEnvelope(kind, execution, payload) {
    return createRunnerEnvelope({
      kind,
      messageId: randomUUID(),
      idempotencyKey: `${kind}:${execution.leaseId}:${execution.epoch}:${randomUUID()}`,
      correlationId: execution.leaseId,
      payload: {
        runnerId: this.identity.runnerId,
        leaseId: execution.leaseId,
        epoch: execution.epoch,
        ...payload,
      },
    });
  }

  #receive(envelope) {
    if (!this.started || this.stopping) return;
    try {
      if (envelope.kind === RUNNER_MESSAGE_KIND.LEASE_OFFER) this.#acceptOffer(envelope);
      else if (envelope.kind === RUNNER_MESSAGE_KIND.CANCEL) this.#acceptCancel(envelope);
      else throw new Error(`unsupported Controller message: ${envelope.kind}`);
    } catch (error) {
      this.logger?.warn?.({ code: error.code ?? 'RUNNER_MESSAGE_FAILED' }, 'Runner message failed');
      this.emit('operationError', error);
    }
  }

  #acceptOffer(envelope) {
    const offer = envelope.payload;
    const outcome = this.store.recordInbound(envelope, () => {
      if (offer.runnerId !== this.identity.runnerId) {
        return {
          response: this.#envelope(RUNNER_MESSAGE_KIND.LEASE_REJECTED, envelope, {
            leaseId: offer.leaseId,
            epoch: offer.epoch,
            reason: 'RUNNER_IDENTITY_MISMATCH',
          }),
        };
      }
      const existing = this.store.getExecution(offer.leaseId, offer.epoch);
      const latest = this.store.getLatestExecution(offer.leaseId);

      if (existing) {
        return {
          response: this.#envelope(RUNNER_MESSAGE_KIND.LEASE_REJECTED, envelope, {
            leaseId: offer.leaseId,
            epoch: offer.epoch,
            reason: 'LEASE_ALREADY_EXISTS',
          }),
        };
      }
      if (latest && latest.epoch >= offer.epoch) {
        return {
          response: this.#envelope(RUNNER_MESSAGE_KIND.LEASE_REJECTED, envelope, {
            leaseId: offer.leaseId,
            epoch: offer.epoch,
            reason: 'STALE_LEASE_EPOCH',
          }),
        };
      }
      this.store.createExecution({
        leaseId: offer.leaseId,
        epoch: offer.epoch,
        runId: offer.runId,
        state: LEASE_STATE.ACCEPTED,
        workspaceId: offer.workspaceId,
        harness: offer.harness ?? null,
      });

      return {
        response: this.#envelope(RUNNER_MESSAGE_KIND.LEASE_ACCEPTED, envelope, {
          leaseId: offer.leaseId,
          epoch: offer.epoch,
        }),
        value: { execute: true },
      };
    });

    this.transport.send(outcome.response);
    if (!outcome.duplicate && outcome.value?.execute) this.#runExecution(offer);
  }

  #runExecution(offer) {
    const key = `${offer.leaseId}:${offer.epoch}`;
    const controller = new AbortController();

    this.controllers.set(key, controller);
    const operation = (async () => {
      try {
        const execution = this.store.transitionExecution(
          offer.leaseId,
          offer.epoch,
          LEASE_STATE.ACCEPTED,
          LEASE_STATE.RUNNING,
        );
        const started = this.#eventEnvelope(RUNNER_MESSAGE_KIND.LEASE_STARTED, execution, {});

        this.store.enqueue(started, { reserveClass: 'terminal' });
        this.transport.send(started);
        const result = await this.executionPort.accept(offer, {
          signal: controller.signal,
          onEvent: (event) => this.#recordProgress(execution, event),
        });
        const current = this.store.getExecution(offer.leaseId, offer.epoch);

        if (!current || TERMINAL_STATES.has(current.state)) return;
        const status =
          result?.status === 'cancelled' ? LEASE_STATE.CANCELLED : LEASE_STATE.COMPLETED;

        this.store.transitionExecution(offer.leaseId, offer.epoch, current.state, status);
        this.#recordResult(current, status, result);
      } catch (error) {
        const current = this.store.getExecution(offer.leaseId, offer.epoch);

        if (current && !TERMINAL_STATES.has(current.state)) {
          const status = controller.signal.aborted ? LEASE_STATE.CANCELLED : LEASE_STATE.FAILED;

          this.store.transitionExecution(offer.leaseId, offer.epoch, current.state, status);
          this.#recordResult(current, status);
        }
        this.logger?.warn?.(
          { code: error.code ?? 'EXECUTION_FAILED', leaseId: offer.leaseId },
          'Runner execution ended unsuccessfully',
        );
      } finally {
        this.controllers.delete(key);
      }
    })();

    this.activeOperations.add(operation);
    operation.finally(() => this.activeOperations.delete(operation));
  }

  #recordProgress(execution, event = {}) {
    if (this.stopping) return;
    try {
      const progress = this.#eventEnvelope(RUNNER_MESSAGE_KIND.EVENT, execution, {
        eventId: randomUUID(),
        type: typeof event.type === 'string' ? event.type : 'progress',
        at: new Date().toISOString(),
        ...(Number.isFinite(event.progress)
          ? { progress: Math.max(0, Math.min(1, event.progress)) }
          : {}),
      });

      this.store.enqueue(progress, { reserveClass: 'normal' });
      this.transport.send(progress);
    } catch (error) {
      if (error.code !== 'OUTBOX_CAPACITY') throw error;
      this.emit('degraded', { code: error.code });
    }
  }

  #recordResult(execution, status, result = {}) {
    const message = this.#eventEnvelope(RUNNER_MESSAGE_KIND.RESULT, execution, {
      resultId: randomUUID(),
      status,
      ...(typeof result.revision === 'string' ? { revision: result.revision } : {}),
      ...(typeof result.sessionId === 'string' ? { sessionId: result.sessionId } : {}),
      ...(typeof result.turnId === 'string' ? { turnId: result.turnId } : {}),
      ...(typeof result.summary === 'string' ? { summary: result.summary.slice(0, 4_000) } : {}),
      ...(Array.isArray(result.evidence) ? { evidence: result.evidence } : {}),
      ...(result.usage && typeof result.usage === 'object' ? { usage: result.usage } : {}),
      ...(result.review && typeof result.review === 'object' ? { review: result.review } : {}),
      ...(result.plan && typeof result.plan === 'object' ? { plan: result.plan } : {}),
    });

    this.store.enqueue(message, { reserveClass: 'terminal' });
    this.transport.send(message);
  }

  #acceptCancel(envelope) {
    const request = envelope.payload;
    const outcome = this.store.recordInbound(envelope, () => {
      const execution = this.store.getExecution(request.leaseId, request.epoch);
      let status = 'not_found';
      let shouldCancel = false;

      if (execution && TERMINAL_STATES.has(execution.state)) status = 'already_terminal';
      else if (execution) {
        status = 'accepted';
        shouldCancel = true;
        this.store.transitionExecution(
          request.leaseId,
          request.epoch,
          execution.state,
          LEASE_STATE.CANCELLED,
          { cancelState: 'requested' },
        );
      }

      return {
        response: this.#envelope(RUNNER_MESSAGE_KIND.CANCEL_ACK, envelope, {
          leaseId: request.leaseId,
          epoch: request.epoch,
          status,
        }),
        value: { cancel: shouldCancel },
      };
    });

    this.transport.send(outcome.response);
    if (!outcome.duplicate && outcome.value?.cancel) {
      const key = `${request.leaseId}:${request.epoch}`;

      this.controllers.get(key)?.abort();
      const operation = Promise.resolve(
        this.executionPort.cancel({ leaseId: request.leaseId, epoch: request.epoch }),
      ).catch((error) => this.emit('operationError', error));

      this.activeOperations.add(operation);
      operation.finally(() => this.activeOperations.delete(operation));
    }
  }

  status() {
    const transport = this.transport.status();
    const persistence = this.storeClosed ? this.lastPersistenceStatus : this.store.status();

    return Object.freeze({
      started: this.started,
      stopping: this.stopping,
      runnerId: this.identity?.runnerId ?? null,
      transport,
      persistence,
      activeOperations: this.activeOperations.size,
      degraded:
        persistence.outbox.entries >= persistence.outbox.capacityEntries ||
        transport.lastErrorCode !== null,
    });
  }

  async stop({ reason = 'shutdown', deadlineMs = 5_000 } = {}) {
    if (this.stopping) return;
    this.stopping = true;
    this.started = false;
    this.transport.off('envelope', this.onEnvelope);
    this.transport.off('transportError', this.onTransportError);
    this.transport.close();
    for (const controller of this.controllers.values()) controller.abort(reason);
    const settling = Promise.allSettled([
      ...this.activeOperations,
      Promise.resolve(this.executionPort.shutdown?.({ reason })),
    ]);
    const settled = await settleWithDeadline(settling, deadlineMs);

    this.controllers.clear();
    if (this.closeStore) {
      const close = () => {
        if (this.storeClosed) return;
        this.lastPersistenceStatus = this.store.status();
        this.store.close();
        this.storeClosed = true;
      };

      if (settled) close();
      else settling.then(close);
    }
    this.stopping = false;
  }
}
