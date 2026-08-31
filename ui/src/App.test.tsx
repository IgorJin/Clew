import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureTasks } from './fixtures';
import type { ThreadItem } from './types';

const api = vi.hoisted(() => ({
  execute: vi.fn(async () => ({ fixture: true })),
  loadTasks: vi.fn(async () => ({ tasks: structuredClone(fixtureTasks), state: 'fixture' })),
  subscribeToEvents: vi.fn(
    (
      after: number,
      onEvent: (event: { cursor: number }) => void,
      onState: (state: string) => void,
    ) => {
      void after;
      void onEvent;
      void onState;

      return () => undefined;
    },
  ),
}));

vi.mock('./api', () => api);

import App, { Thread } from './App';

describe('Preact control plane', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    sessionStorage.clear();
  });

  it('confirms completion and sends the pinned revision', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /complete/i }));

    expect(api.execute).toHaveBeenCalledWith(['complete', 'CLEW-071', '--revision', 'a91c4e2']);
    expect(await screen.findByText('Task completed')).toBeTruthy();
  });

  it('continues READY work with the operator message instead of retrying', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<App />);
    const message = await screen.findByRole('textbox', { name: /add a message/i });

    fireEvent.input(message, { target: { value: 'Please address the remaining edge case' } });
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));

    expect(api.execute).toHaveBeenCalledWith([
      'continue',
      'CLEW-071',
      '--message',
      'Please address the remaining edge case',
    ]);
    expect(await screen.findByText('Continuation requested')).toBeTruthy();
  });

  it('approves a plan and exposes the durable fixture state', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /parallel cache migration/i }));
    fireEvent.click(screen.getByRole('button', { name: /approve plan/i }));

    expect(api.execute).toHaveBeenCalledWith(['approve', 'ACC-DEEP']);
    expect((await screen.findAllByText('Plan ready')).length).toBeGreaterThan(0);
  });

  it('exposes a native worker approval while the run is active', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const tasks = structuredClone(fixtureTasks);
    tasks[0] = {
      ...tasks[0],
      state: 'WAITING_FOR_HUMAN',
      attention: 'HUMAN_ACTION_REQUIRED',
      runStatus: 'RUNNING',
      harnessApprovals: [
        {
          id: 'approval-1',
          run_id: 'run-1',
          method: 'item/commandExecution/requestApproval',
          params: { command: 'npm test' },
          decision: null,
          requested_at: '2026-08-31T17:50:00.000Z',
          decided_at: null,
        },
      ],
    };
    api.loadTasks.mockResolvedValueOnce({ tasks, state: 'connected' });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /approve worker command/i }));

    expect(api.execute).toHaveBeenCalledWith(['approve-run', 'approval-1']);
  });

  it('renders summaries as text instead of arbitrary HTML', () => {
    const item: ThreadItem = {
      version: 1,
      id: 'hostile',
      cursor: 1,
      kind: 'operator_message',
      at: '2026-08-28T09:42:00.000Z',
      source: { kind: 'operator', id: 'local-user' },
      summary: '<img src=x onerror="window.compromised=true">',
    };

    const { container } = render(<Thread items={[item]} />);

    expect(screen.getByText(item.summary)).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
  });

  it('keeps last known data but disables operator actions after disconnect', async () => {
    let reportState: ((state: string) => void) | undefined;

    api.loadTasks.mockResolvedValueOnce({
      tasks: structuredClone(fixtureTasks),
      state: 'connected',
    });
    api.subscribeToEvents.mockImplementationOnce((_after, _onEvent, onState) => {
      reportState = onState;

      return () => undefined;
    });
    render(<App />);
    const complete = await screen.findByRole('button', { name: /complete/i });

    expect(complete.hasAttribute('disabled')).toBe(false);
    reportState?.('disconnected');
    await waitFor(() => expect(complete.hasAttribute('disabled')).toBe(true));
    expect(screen.getByRole('alert').textContent).toMatch(/last known data/i);
    expect(screen.getByRole('alert').textContent).toMatch(/actions are disabled/i);
  });

  it('creates a task from the UI without starting it', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /new/i }));
    fireEvent.input(screen.getByRole('textbox', { name: /^title$/i }), {
      target: { value: 'Read-only MVP task' },
    });
    fireEvent.input(screen.getByRole('textbox', { name: /^description$/i }), {
      target: { value: 'List files without changing them' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^create task$/i }));

    expect(api.execute).toHaveBeenCalledWith([
      'task',
      'create',
      '--title',
      'Read-only MVP task',
      '--description',
      'List files without changing them',
    ]);
    expect(await screen.findByText('Task created: Read-only MVP task')).toBeTruthy();
    expect(window.location.pathname).toMatch(/^\/tasks\/LOCAL-/);
  });

  it('opens the live worker terminal before a Codex session id exists', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const runningTasks = structuredClone(fixtureTasks);

    runningTasks[0].state = 'EXECUTING';
    runningTasks[0].runStatus = 'RUNNING';
    runningTasks[0].sessionId = null;
    runningTasks[0].sessionHarness = 'codex';
    runningTasks[0].sessionStageId = 'worker';
    api.loadTasks.mockResolvedValueOnce({ tasks: runningTasks, state: 'connected' });
    render(<App />);
    const open = await screen.findByRole('button', { name: /open live terminal/i });

    expect(open.hasAttribute('disabled')).toBe(false);
    fireEvent.click(open);
    expect(api.execute).toHaveBeenCalledWith([
      'session',
      'open',
      'CLEW-071',
      '--stage',
      'worker',
      '--role',
      'worker',
      '--harness',
      'codex',
      '--surface',
      'live',
      '--mode',
      'live',
    ]);
  });
});
