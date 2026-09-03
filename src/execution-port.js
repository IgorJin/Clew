export class ExecutionPort {
  describe() {
    throw new Error('ExecutionPort.describe() is not implemented');
  }

  matchStage(_requirements) {
    throw new Error('ExecutionPort.matchStage() is not implemented');
  }

  executeStage(_request, _hooks = {}) {
    throw new Error('ExecutionPort.executeStage() is not implemented');
  }

  cancelStage(_execution) {
    throw new Error('ExecutionPort.cancelStage() is not implemented');
  }

  recoverStage(_execution) {
    throw new Error('ExecutionPort.recoverStage() is not implemented');
  }
}

export class LocalExecutionPort extends ExecutionPort {
  constructor(adapter) {
    super();
    if (!adapter || typeof adapter.executeStage !== 'function')
      throw new Error('LocalExecutionPort requires an executeStage adapter');
    this.adapter = adapter;
  }

  describe() {
    return { mode: 'local', available: true, ...(this.adapter.describe?.() ?? {}) };
  }

  matchStage(requirements) {
    return this.adapter.matchStage?.(requirements) ?? { matched: true };
  }

  executeStage(request, hooks = {}) {
    return this.adapter.executeStage(request, hooks);
  }

  cancelStage(execution) {
    if (typeof this.adapter.cancelStage !== 'function')
      throw new Error('local execution adapter does not support cancellation');

    return this.adapter.cancelStage(execution);
  }

  recoverStage(execution) {
    if (typeof this.adapter.recoverStage !== 'function')
      return { classification: 'local_restart', execution };

    return this.adapter.recoverStage(execution);
  }
}

export class PairedExecutionPort extends ExecutionPort {
  constructor({ store, transport, runnerId }) {
    super();
    if (!store || typeof store.allocateRunnerLease !== 'function')
      throw new Error('PairedExecutionPort requires a lease Store');
    if (!transport || typeof transport.send !== 'function')
      throw new Error('PairedExecutionPort requires a Runner transport');
    this.store = store;
    this.transport = transport;
    this.runnerId = runnerId;
  }

  describe() {
    const runner = this.store.getRunnerProjection(this.runnerId);

    return {
      mode: 'paired',
      available: runner?.healthStatus === 'healthy',
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

  matchStage(requirements = {}) {
    const runner = this.store.getRunnerProjection(this.runnerId);

    if (!runner || runner.healthStatus !== 'healthy')
      return { matched: false, reason: 'runner_unavailable' };
    const requiredCapabilities = requirements.capabilities ?? [];
    const missingCapabilities = requiredCapabilities.filter(
      (capability) => !runner.capabilities.includes(capability),
    );

    if (missingCapabilities.length)
      return { matched: false, reason: 'missing_capabilities', missingCapabilities };
    const workspace = runner.workspaces.find(
      (candidate) => candidate.id === requirements.workspaceMappingId,
    );

    if (!workspace) return { matched: false, reason: 'workspace_mapping_unavailable' };

    return { matched: true, workspaceMappingId: workspace.id };
  }

  async executeStage(request, hooks = {}) {
    const match = this.matchStage({
      ...request.requirements,
      workspaceMappingId: request.lease.workspaceMappingId,
    });

    if (!match.matched) throw new Error(`Runner cannot execute stage: ${match.reason}`);
    const persisted = this.store.allocateRunnerLease({
      run: request.run,
      lease: request.lease,
      offer: request.offer,
    });

    hooks.onAllocated?.(persisted);
    const sent = await this.transport.send(request.offer);

    if (sent !== false) this.store.markRunnerCommandSent(request.offer.messageId);

    return { mode: 'paired', lease: persisted };
  }

  async cancelStage({ leaseId, reason, command }) {
    const lease = this.store.requestRunnerLeaseCancellation({
      leaseId,
      reason,
      envelope: command,
    });

    const sent = await this.transport.send(command);

    if (sent !== false) this.store.markRunnerCommandSent(command.messageId);

    return lease;
  }

  recoverStage(execution) {
    const lease = this.store.getRunnerLease(execution.leaseId);

    if (!lease) throw new Error(`Runner lease not found: ${execution.leaseId}`);

    return {
      classification: lease.recoveryClassification,
      requiresExplicitRecovery: lease.state === 'recovering',
      lease,
    };
  }
}

export function createExecutionPort({ mode = 'local', local, paired }) {
  if (mode === 'local')
    return local instanceof ExecutionPort ? local : new LocalExecutionPort(local);
  if (mode === 'paired')
    return paired instanceof ExecutionPort ? paired : new PairedExecutionPort(paired);

  throw new Error(`unsupported execution mode: ${mode}`);
}
