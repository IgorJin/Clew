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
vi.mock('./TerminalPane', () => ({
  TerminalPane: ({ runId }: { runId: string }) => (
    <section aria-label="Live Codex terminal">terminal {runId}</section>
  ),
}));

import App, { Thread } from './App';

describe('Preact control plane', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    sessionStorage.clear();
  });

  it('confirms completion and sends the pinned revision', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /complete/i }));

    expect(api.execute).toHaveBeenCalledWith(['complete', 'CLEW-071', '--revision', 'a91c4e2']);
    expect(await screen.findByText('Task completed')).toBeTruthy();
  });

  it('continues READY work with the operator message instead of retrying', async () => {
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
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /parallel cache migration/i }));
    fireEvent.click(screen.getByRole('button', { name: /approve plan/i }));

    expect(api.execute).toHaveBeenCalledWith(['approve', 'ACC-DEEP']);
    expect((await screen.findAllByText('Plan ready')).length).toBeGreaterThan(0);
  });

  it('finishes the interactive worker without exposing duplicate approval controls', async () => {
    const tasks = structuredClone(fixtureTasks);
    tasks[0] = {
      ...tasks[0],
      state: 'EXECUTING',
      attention: null,
      runStatus: 'RUNNING',
      runId: 'run-1',
      terminalActive: true,
      terminalAvailable: true,
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

    expect(screen.queryByRole('button', { name: /approve worker command/i })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: /finish worker/i }));

    expect(api.execute).toHaveBeenCalledWith(['finish-worker', 'CLEW-071', '--run', 'run-1']);
  });

  it('starts a draft task directly without an explain-next-step gate', async () => {
    const tasks = structuredClone(fixtureTasks);
    tasks[0] = {
      ...tasks[0],
      state: 'DRAFT',
      revision: null,
      runStatus: null,
      runId: null,
      terminalActive: false,
      terminalAvailable: false,
    };
    api.loadTasks.mockResolvedValueOnce({ tasks, state: 'connected' });
    render(<App />);

    expect(screen.queryByText(/explain next step/i)).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: /run task/i }));

    expect(api.execute).toHaveBeenCalledWith(['run', 'CLEW-071']);
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

  it('automatically shows the managed Codex terminal after the worker thread is available', async () => {
    const runningTasks = structuredClone(fixtureTasks);

    runningTasks[0].state = 'EXECUTING';
    runningTasks[0].runStatus = 'RUNNING';
    runningTasks[0].runId = 'run-live-1';
    runningTasks[0].sessionId = 'thread-live-1';
    runningTasks[0].sessionHarness = 'codex';
    runningTasks[0].sessionStageId = 'worker';
    runningTasks[0].terminalAvailable = true;
    runningTasks[0].terminalActive = true;
    api.loadTasks.mockResolvedValueOnce({ tasks: runningTasks, state: 'connected' });
    render(<App />);
    const terminal = await screen.findByRole('region', { name: /live codex terminal/i });
    const show = screen.getByRole('button', { name: /show live terminal/i });

    expect(terminal.textContent).toContain('run-live-1');
    expect(show.hasAttribute('disabled')).toBe(false);
    expect(api.execute).not.toHaveBeenCalledWith(expect.arrayContaining(['session', 'open']));
  });

  it('shows when a completed worker turn is waiting for operator input', async () => {
    const waitingTasks = structuredClone(fixtureTasks);

    waitingTasks[0].state = 'EXECUTING';
    waitingTasks[0].runStatus = 'RUNNING';
    waitingTasks[0].runId = 'run-waiting-1';
    waitingTasks[0].sessionId = 'thread-waiting-1';
    waitingTasks[0].sessionHarness = 'codex';
    waitingTasks[0].terminalAvailable = true;
    waitingTasks[0].terminalActive = true;
    waitingTasks[0].interactionStatus = 'waiting_for_operator';
    api.loadTasks.mockResolvedValueOnce({ tasks: waitingTasks, state: 'connected' });

    render(<App />);

    expect(await screen.findByText('Terminal is waiting for you')).toBeTruthy();
    expect(screen.getByText(/worker returned a response/i)).toBeTruthy();
    expect(screen.getByText('Waiting for operator')).toBeTruthy();
    expect(screen.queryByText('Operator actions')).toBeNull();
  });
});
