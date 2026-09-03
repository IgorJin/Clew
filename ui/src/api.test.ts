import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execute, loadTasks, subscribeToEvents } from './api';

const response = (body: unknown, status = 200) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function installApi({ invalidThread = false, plannedOnly = false } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith('/api/v1/bootstrap')) return response(null, 204);
      if (url.endsWith('/api/v1/snapshot'))
        return response({
          version: 1,
          cursor: 1,
          generatedAt: '2026-08-28T09:42:00.000Z',
          tasks: [
            {
              show: {
                id: 'T-1',
                state: 'READY',
                contract: {
                  title: 'Projection',
                  goal: 'Show the real thread',
                  profile: 'standard',
                  tags: ['backend'],
                },
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
                agentSessions: [],
              },
              thread: {
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
              },
              history: { events: [] },
            },
          ],
        });
      throw new Error(`unexpected request: ${url}`);
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
    const urls = vi.mocked(fetch).mock.calls.map(([input]) => String(input));

    expect(urls.filter((url) => url.endsWith('/api/v1/snapshot'))).toHaveLength(1);
    expect(urls.some((url) => url.endsWith('/api/v1/command'))).toBe(false);
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

  it('sends operator commands to the shared service boundary', async () => {
    sessionStorage.setItem('clew-session', '1');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          kind: 'command',
          name: 'service.execute',
          payload: { args: ['run', 'T-1'] },
        });

        return response({ version: 1, kind: 'response', payload: { state: 'READY' } });
      }),
    );

    await expect(execute(['run', 'T-1'])).resolves.toEqual({ state: 'READY' });
  });

  it('stops the stream when a reconnect cursor regresses', async () => {
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
    await vi.waitFor(() => expect(FakeSocket.instance).toBeTruthy());
    FakeSocket.instance.onmessage?.({ data: JSON.stringify({ cursor: 4 }) } as MessageEvent);

    expect(states).toEqual(['reconnecting', 'incompatible']);
  });
});
