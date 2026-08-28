import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadTasks, subscribeToEvents } from './api';

const response = (body: unknown, status = 200) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function envelope(payload: unknown) {
  return { version: 1, requestId: 'request-1', kind: 'response', name: 'cli.execute', payload };
}

function installApi({ invalidThread = false, plannedOnly = false } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.body) return response(null, 204);
      const body = JSON.parse(String(init.body)) as { payload: { args: string[] } };
      const args = body.payload.args;
      if (args[0] === 'task' && args[1] === 'list') return response(envelope([{ id: 'T-1' }]));
      if (args[0] === 'task' && args[1] === 'show')
        return response(
          envelope({
            id: 'T-1',
            state: 'READY',
            contract: { title: 'Projection', goal: 'Show the real thread', profile: 'standard' },
            plan: plannedOnly
              ? {
                  status: 'PENDING_APPROVAL',
                  plan: {
                    stages: [
                      { id: 'backend', kind: 'worker' },
                      { id: 'frontend', kind: 'worker' },
                      { id: 'integration', kind: 'integration' },
                    ],
                  },
                }
              : null,
            stages: plannedOnly ? [] : [{ id: 'worker', status: 'COMPLETED' }],
            runs: [{ status: 'COMPLETED', commit_sha: 'abc123' }],
            review: {
              findings: [
                { severity: 'advisory', criterion: 'AC-1', reason: 'Keep the copy concise' },
              ],
            },
            completion: null,
          }),
        );
      if (args[0] === 'task' && args[1] === 'thread')
        return response(
          envelope({
            version: 1,
            items: [
              {
                version: 1,
                id: 'thread-1',
                cursor: invalidThread ? 0 : 1,
                kind: 'task_created',
                at: '2026-08-28T09:42:00.000Z',
                summary: 'Task created: Projection',
                source: { kind: 'event', id: 'event-1' },
              },
            ],
            nextCursor: null,
            hasMore: false,
            redaction: 'public-safe',
          }),
        );
      if (args[0] === 'task' && args[1] === 'history') return response(envelope({ events: [] }));
      throw new Error(`unexpected command: ${args.join(' ')}`);
    }),
  );
}

describe('control-plane client', () => {
  beforeEach(() => installApi());

  it('loads task detail and the CLEW-070 thread projection', async () => {
    const result = await loadTasks();

    expect(result.state).toBe('connected');
    expect(result.tasks[0]).toMatchObject({
      id: 'T-1',
      title: 'Projection',
      revision: 'abc123',
      findings: 1,
    });
    expect(result.tasks[0].thread.items[0].summary).toBe('Task created: Projection');
  });

  it('does not mistake a Vite HTML fallback for daemon bootstrap', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html></html>', { status: 200 })),
    );

    const result = await loadTasks();

    expect(result.state).toBe('fixture');
    expect(result.tasks.length).toBeGreaterThan(0);
  });

  it('rejects an invalid thread cursor as an incompatible daemon', async () => {
    installApi({ invalidThread: true });

    await expect(loadTasks()).resolves.toEqual({ tasks: [], state: 'incompatible' });
  });

  it('shows pending Deep plan stages before they are materialized', async () => {
    installApi({ plannedOnly: true });

    const result = await loadTasks();

    expect(result.tasks[0].stages).toEqual([
      { id: 'backend', kind: 'worker', status: 'PENDING' },
      { id: 'frontend', kind: 'worker', status: 'PENDING' },
      { id: 'integration', kind: 'integration', status: 'PENDING' },
    ]);
  });

  it('stops the stream when a reconnect cursor regresses', () => {
    sessionStorage.setItem('clew-session', '1');
    const states: string[] = [];
    class FakeSocket {
      static instance: FakeSocket;
      onopen: (() => void) | null = null;
      onmessage: ((message: MessageEvent) => void) | null = null;
      onclose: (() => void) | null = null;
      constructor() {
        FakeSocket.instance = this;
      }
      close() {}
    }
    vi.stubGlobal('WebSocket', FakeSocket);

    subscribeToEvents(5, vi.fn(), (state) => states.push(state));
    FakeSocket.instance.onmessage?.({ data: JSON.stringify({ cursor: 4 }) } as MessageEvent);

    expect(states).toEqual(['reconnecting', 'incompatible']);
  });
});
