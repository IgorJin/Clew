/** Fake AgentRuntime for CLEW-127.
 *
 * The fake runtime is a test-only plugin. It is registered like any other
 * plugin but the resolver only hands it out on an explicit test route
 * (`allowFake: true`). A default production route can never pick it up.
 */

export const FAKE_RUNTIME_PLUGIN_ID = 'clew.runtime.fake';

export function fakeRuntimeManifest() {
  return {
    id: FAKE_RUNTIME_PLUGIN_ID,
    version: '1.0.0',
    apiVersion: '1',
    extensionPoints: [{ point: 'AgentRuntime', version: '1' }],
    configSchema: { type: 'object', properties: {} },
    scope: 'execution-host',
    resources: {
      binaries: [],
      network: [],
      notes: 'Test-only runtime: no external processes, no network, deterministic output.',
    },
  };
}

export class FakeAgentRuntime {
  constructor(connection = {}) {
    this.connectionId =
      typeof connection.id === 'string' && connection.id ? connection.id : 'fake-default';
    this.disposed = false;
  }

  describe() {
    return {
      plugin: FAKE_RUNTIME_PLUGIN_ID,
      apiVersion: '1',
      capabilities: ['execution.headless', 'session.resume', 'output.structured', 'usage.reported'],
    };
  }

  async probe() {
    return {
      status: 'ready',
      connection: this.connectionId,
      capabilities: this.describe().capabilities,
    };
  }

  async run(request = {}, hooks = {}) {
    if (!request || typeof request.runId !== 'string' || !request.runId)
      throw new Error('fake runtime run requires request.runId');

    const session = {
      runtime: 'fake',
      connection: this.connectionId,
      nativeSessionId: `fake-${request.runId}`,
    };

    await hooks.onCheckpoint?.({ runId: request.runId, session });

    return {
      status: 'completed',
      session,
      output: { summary: `Fake runtime completed ${request.runId}` },
      evidence: [],
      usage: { status: 'unknown' },
    };
  }

  async dispose() {
    this.disposed = true;
  }
}

export function createFakeAgentRuntime(connection) {
  return new FakeAgentRuntime(connection);
}
