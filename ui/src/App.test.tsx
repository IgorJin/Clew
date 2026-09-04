import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureTasks } from './fixtures';
import type { ThreadItem } from './types';

const api = vi.hoisted(() => ({
  execute: vi.fn(async (args: string[]): Promise<unknown> => {
    void args;

    return { fixture: true };
  }),
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
  rolesForProfile: vi.fn((profile: string) => {
    if (profile === 'deep') return ['architect', 'worker', 'reviewer'];
    if (profile === 'standard') return ['worker', 'reviewer'];
    return ['worker'];
  }),
}));

vi.mock('./api', () => api);
vi.mock('./TerminalPane', () => ({
  TerminalPane: ({ terminalId }: { terminalId: string }) => (
    <section aria-label="Live Codex terminal">terminal {terminalId}</section>
  ),
}));

import App, { Thread } from './App';

function availableChanges(runId: string, additions = 4, deletions = 2) {
  return {
    version: 1,
    runId,
    state: 'available',
    summary: { files: 1, additions, deletions },
    files: ['src/change.ts'],
    statuses: [{ path: 'src/change.ts', status: 'M ' }],
    patch: 'diff --git a/src/change.ts b/src/change.ts\n+added line',
    additions,
    deletions,
    binary: false,
    dirty: true,
    revisions: { base: 'base-sha', head: 'head-sha' },
  };
}

describe('Preact control plane', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    sessionStorage.clear();
    api.execute.mockReset();
    api.execute.mockResolvedValue({ fixture: true });
    api.loadTasks.mockReset();
    api.loadTasks.mockResolvedValue({ tasks: structuredClone(fixtureTasks), state: 'fixture' });
    api.subscribeToEvents.mockClear();
  });

  it('confirms completion and sends the pinned revision', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /complete/i }));

    expect(api.execute).toHaveBeenCalledWith(['complete', 'CLEW-071', '--revision', 'a91c4e2']);
    expect(await screen.findByText('Task completed')).toBeTruthy();
  });

  it('continues READY work without a message panel', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /^continue$/i }));

    expect(api.execute).toHaveBeenCalledWith([
      'continue',
      'CLEW-071',
      '--message',
      'Continue task',
    ]);
    expect(screen.queryByText('Add a message')).toBeNull();
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

    fireEvent.click(await screen.findByRole('button', { name: /^approve$/i }));

    expect(api.execute).toHaveBeenCalledWith(['approve-run', 'approval-1']);
  });

  it('finishes an interactive worker', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const tasks = structuredClone(fixtureTasks);
    tasks[0] = {
      ...tasks[0],
      state: 'EXECUTING',
      attention: null,
      runStatus: 'RUNNING',
      runId: 'run-1',
      terminalActive: true,
      terminalAvailable: true,
    };
    api.loadTasks.mockResolvedValueOnce({ tasks, state: 'connected' });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /finish worker/i }));

    expect(api.execute).toHaveBeenCalledWith(['finish-worker', 'CLEW-071', '--run', 'run-1']);
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
    fireEvent.input(screen.getByRole('textbox', { name: /what should be done/i }), {
      target: { value: 'List files without changing them' },
    });
    fireEvent.input(screen.getByRole('textbox', { name: /^title$/i }), {
      target: { value: 'Read-only MVP task' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^deep/i }));
    fireEvent.input(screen.getByRole('textbox', { name: /^tags$/i }), {
      target: { value: 'ui, refactor' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^create task$/i }));

    expect(api.execute).toHaveBeenCalledWith([
      'task',
      'create',
      '--title',
      'Read-only MVP task',
      '--description',
      'List files without changing them',
      '--profile',
      'deep',
      '--tags',
      'ui',
      '--tags',
      'refactor',
    ]);
    expect(await screen.findByText('Task created: Read-only MVP task')).toBeTruthy();
    expect(window.location.pathname).toMatch(/^\/tasks\/LOCAL-/);
  });

  it('derives a title when the title field is left empty', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /new/i }));
    fireEvent.input(screen.getByRole('textbox', { name: /what should be done/i }), {
      target: { value: 'Investigate terminal startup' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^create task$/i }));

    expect(api.execute).toHaveBeenCalledWith([
      'task',
      'create',
      '--title',
      'Investigate terminal startup',
      '--description',
      'Investigate terminal startup',
      '--profile',
      'quick',
    ]);
  });

  it('opens the live worker terminal externally before a Codex session id exists', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const runningTasks = structuredClone(fixtureTasks);

    runningTasks[0].state = 'EXECUTING';
    runningTasks[0].runStatus = 'RUNNING';
    runningTasks[0].sessionId = null;
    runningTasks[0].sessionHarness = 'codex';
    runningTasks[0].sessionStageId = 'worker';
    api.loadTasks.mockResolvedValueOnce({ tasks: runningTasks, state: 'connected' });
    render(<App />);
    const open = await screen.findByRole('button', { name: /open worker externally/i });

    expect(open.hasAttribute('disabled')).toBe(false);
    fireEvent.click(open);
    expect(confirm).not.toHaveBeenCalled();
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

  it('automatically shows the managed Codex terminal after the worker thread is available', async () => {
    const runningTasks = structuredClone(fixtureTasks);

    runningTasks[0].state = 'EXECUTING';
    runningTasks[0].runStatus = 'RUNNING';
    runningTasks[0].runId = 'run-live-1';
    runningTasks[0].sessionId = 'thread-live-1';
    runningTasks[0].terminalAvailable = true;
    runningTasks[0].terminalActive = true;
    api.loadTasks.mockResolvedValueOnce({ tasks: runningTasks, state: 'connected' });
    render(<App />);

    const terminal = await screen.findByRole('region', { name: /live codex terminal/i });
    expect(terminal.textContent).toContain('run-live-1');
  });

  it('expands a stored architect session inside its agent card', async () => {
    const tasks = structuredClone(fixtureTasks);
    tasks[0].roles = ['architect', 'worker'];
    api.loadTasks.mockResolvedValueOnce({ tasks, state: 'connected' });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /expand architect terminal/i }));

    const terminal = await screen.findByRole('region', { name: /live codex terminal/i });
    expect(terminal.textContent).toContain('CLEW-071:architect:arch-session-1');
  });

  it('shows when a completed worker turn is waiting for operator input', async () => {
    const waitingTasks = structuredClone(fixtureTasks);

    waitingTasks[0].state = 'EXECUTING';
    waitingTasks[0].runStatus = 'RUNNING';
    waitingTasks[0].runId = 'run-waiting-1';
    waitingTasks[0].terminalAvailable = true;
    waitingTasks[0].terminalActive = true;
    waitingTasks[0].interactionStatus = 'waiting_for_operator';
    api.loadTasks.mockResolvedValueOnce({ tasks: waitingTasks, state: 'connected' });
    const { container } = render(<App />);

    expect(await screen.findByText('Terminal is waiting for you')).toBeTruthy();
    expect(screen.getByText(/worker returned a response/i)).toBeTruthy();
    expect(screen.getByText('Waiting for operator')).toBeTruthy();
    expect(container.querySelectorAll('.status-notice')).toHaveLength(1);
    expect(container.querySelector('.terminal-waiting-banner')).toBeNull();
  });

  it('keeps Changes only in the task header', async () => {
    api.execute.mockImplementation(async (args: string[]) =>
      args[0] === 'task' && args[1] === 'changes' ? availableChanges(args[2]) : { fixture: true },
    );
    const { container } = render(<App />);

    await screen.findByRole('button', { name: 'Changes +4 −2' });
    expect(container.querySelectorAll('.changes-control')).toHaveLength(1);
    expect(container.querySelector('.agent-card .changes-control')).toBeNull();
  });

  it('selects workflow steps and exposes contextual state, prerequisites, action and effects', async () => {
    render(<App />);
    const review = await screen.findByRole('button', { name: 'Review' });

    fireEvent.click(review);
    const details = screen.getByRole('region', { name: 'review step details' });

    expect(review.getAttribute('aria-pressed')).toBe('true');
    expect(within(details).getByText('Status')).toBeTruthy();
    expect(within(details).getByText('Prerequisites')).toBeTruthy();
    expect(within(details).getByText('Available action')).toBeTruthy();
    expect(within(details).getByText('Approval')).toBeTruthy();
    expect(within(details).getByText('Side effects')).toBeTruthy();
  });

  it('orders sidebar tasks newest first with a stable id tie-breaker', async () => {
    const tasks = structuredClone(fixtureTasks);
    tasks[0].createdAt = '2026-09-01T10:00:00.000Z';
    tasks[1].createdAt = '2026-09-01T10:00:00.000Z';
    tasks[0].id = 'CLEW-A';
    tasks[1].id = 'CLEW-Z';
    api.loadTasks.mockResolvedValueOnce({ tasks, state: 'connected' });
    const { container } = render(<App />);

    await screen.findByText('CLEW-Z');
    expect(
      [...container.querySelectorAll('.task-row .task-id')].map((node) => node.textContent),
    ).toEqual(['CLEW-Z', 'CLEW-A']);
  });

  it('shows run-scoped counts and opens the selected run in the editor', async () => {
    api.execute.mockImplementation(async (args: string[]) => {
      if (args[0] === 'task' && args[1] === 'changes')
        return availableChanges(args[2], args[2] === 'run-2' ? 7 : 1, 2);
      if (args[0] === 'task' && args[1] === 'open-changes') return { state: 'opened' };
      return { fixture: true };
    });
    render(<App />);

    const changes = await screen.findByRole('button', { name: 'Changes +7 −2' });

    fireEvent.click(changes);
    expect(api.execute).toHaveBeenCalledWith([
      'task',
      'open-changes',
      'CLEW-071',
      '--run',
      'run-2',
    ]);
  });

  it('shows files, unified patch, binary and empty states in the built-in viewer', async () => {
    api.execute.mockImplementation(async (args: string[]) => {
      if (args[0] === 'task' && args[1] === 'changes')
        return { ...availableChanges(args[2]), binary: true };
      return { fixture: true };
    });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /change actions for worker/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /view diff/i }));
    const dialog = await screen.findByRole('dialog', { name: /changes for worker/i });

    expect(within(dialog).getByText('src/change.ts')).toBeTruthy();
    expect(within(dialog).getByText('Includes binary changes')).toBeTruthy();
    expect(within(dialog).getByText(/diff --git/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: /close diff/i }));
    api.execute.mockImplementation(async (args: string[]) => {
      if (args[0] === 'task' && args[1] === 'changes')
        return {
          ...availableChanges(args[2], 0, 0),
          summary: { files: 0, additions: 0, deletions: 0 },
          files: [],
          statuses: [],
          patch: '',
          binary: false,
          dirty: false,
        };
      return { fixture: true };
    });
    fireEvent.click(screen.getByRole('button', { name: /change actions for worker/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /view diff/i }));

    expect(await screen.findByText(/no changes relative to the run baseline/i)).toBeTruthy();
  });

  it('navigates files and switches the readable diff to split layout', async () => {
    api.execute.mockImplementation(async (args: string[]) => {
      if (args[0] !== 'task' || args[1] !== 'changes') return { fixture: true };
      return {
        ...availableChanges(args[2]),
        summary: { files: 2, additions: 2, deletions: 1 },
        files: ['src/first.ts', 'src/second.ts'],
        statuses: [
          { path: 'src/first.ts', status: 'M ' },
          { path: 'src/second.ts', status: 'M ' },
        ],
        patch:
          'diff --git a/src/first.ts b/src/first.ts\n-old first\n+new first\n' +
          'diff --git a/src/second.ts b/src/second.ts\n+new second',
      };
    });
    const { container } = render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /change actions for worker/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /view diff/i }));
    const dialog = await screen.findByRole('dialog', { name: /changes for worker/i });
    fireEvent.click(within(dialog).getByRole('button', { name: /src\/second\.ts/ }));

    expect(within(dialog).getByRole('region', { name: 'Unified diff' }).textContent).toContain(
      'new second',
    );
    expect(within(dialog).getByRole('region', { name: 'Unified diff' }).textContent).not.toContain(
      'new first',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Split' }));
    expect(container.querySelectorAll('.diff-split-line').length).toBeGreaterThan(0);
  });

  it('uses the latest retry for each Deep stage and exposes unavailable Runner state', async () => {
    const tasks = structuredClone(fixtureTasks);

    tasks[0].profile = 'deep';
    tasks[0].roles = ['worker'];
    tasks[0].stages = [
      { id: 'backend', status: 'COMPLETED', kind: 'worker' },
      { id: 'frontend', status: 'RUNNING', kind: 'worker' },
    ];
    tasks[0].runs = [
      { ...tasks[0].runs[0], id: 'backend-1', stageId: 'backend', attempt: 1 },
      { ...tasks[0].runs[1], id: 'backend-2', stageId: 'backend', attempt: 2 },
      {
        ...tasks[0].runs[1],
        id: 'frontend-1',
        stageId: 'frontend',
        attempt: 1,
        status: 'RUNNING',
        workspace: null,
        terminalAccess: 'runner_local',
      },
    ];
    api.loadTasks.mockResolvedValueOnce({ tasks, state: 'connected' });
    api.execute.mockImplementation(async (args: string[]) => {
      if (args[0] === 'task' && args[1] === 'changes') {
        if (args[2] === 'frontend-1')
          return {
            ...availableChanges(args[2], 0, 0),
            state: 'unavailable',
            reason: 'runner-local-unavailable',
          };
        return availableChanges(args[2], args[2] === 'backend-2' ? 9 : 1, 0);
      }
      if (args[0] === 'task' && args[1] === 'open-changes') return { state: 'opened' };
      return { fixture: true };
    });
    render(<App />);

    const runSelect = await screen.findByRole('combobox', { name: 'Select change run' });
    fireEvent.change(runSelect, { target: { value: 'backend-2' } });
    await waitFor(() => expect((runSelect as HTMLSelectElement).value).toBe('backend-2'));
    fireEvent.click(await screen.findByRole('button', { name: /^Changes/ }));
    expect(api.execute).toHaveBeenCalledWith([
      'task',
      'open-changes',
      'CLEW-071',
      '--run',
      'backend-2',
    ]);
    fireEvent.change(runSelect, { target: { value: 'frontend-1' } });
    expect(await screen.findByRole('button', { name: 'Changes unavailable' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /change actions for frontend/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /view diff/i }));
    expect(await screen.findByText(/available only on the runner host/i)).toBeTruthy();
  });

  it('polls running runs every two seconds and copies paths only on explicit action', async () => {
    const tasks = structuredClone(fixtureTasks);
    let poll: (() => void) | undefined;

    tasks[0].runs[1].status = 'RUNNING';
    api.loadTasks.mockResolvedValueOnce({ tasks, state: 'connected' });
    api.execute.mockImplementation(async (args: string[]) => {
      if (args[0] === 'task' && args[1] === 'changes') return availableChanges(args[2]);
      if (args[0] === 'task' && args[1] === 'open-changes') return { state: 'opened' };
      return { fixture: true };
    });
    vi.spyOn(window, 'setInterval').mockImplementation((callback, delay) => {
      if (delay === 2_000) poll = callback as () => void;
      return 42;
    });
    render(<App />);
    await screen.findByRole('button', { name: 'Changes +4 −2' });

    const before = api.execute.mock.calls.filter(
      ([args]) => args[0] === 'task' && args[1] === 'changes' && args[2] === 'run-2',
    ).length;
    poll?.();
    await waitFor(() =>
      expect(
        api.execute.mock.calls.filter(
          ([args]) => args[0] === 'task' && args[1] === 'changes' && args[2] === 'run-2',
        ).length,
      ).toBeGreaterThan(before),
    );

    fireEvent.click(screen.getByRole('button', { name: /change actions for worker/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /copy worktree path/i }));
    expect(api.execute).toHaveBeenCalledWith([
      'task',
      'open-changes',
      'CLEW-071',
      '--run',
      'run-2',
      '--viewer',
      'worktree-path',
    ]);
  });

  it('ignores stale polling responses and clears the active-run timer', async () => {
    const tasks = structuredClone(fixtureTasks);
    const resolvers: ((value: ReturnType<typeof availableChanges>) => void)[] = [];
    let poll: (() => void) | undefined;

    tasks[0].runs = [{ ...tasks[0].runs[1], id: 'active-run', status: 'RUNNING' }];
    tasks[0].stages = [{ id: 'worker', status: 'RUNNING', kind: 'worker' }];
    api.loadTasks.mockResolvedValueOnce({ tasks, state: 'connected' });
    api.execute.mockImplementation((args: string[]) =>
      args[0] === 'task' && args[1] === 'changes'
        ? new Promise((resolve) => resolvers.push(resolve))
        : Promise.resolve({ fixture: true }),
    );
    vi.spyOn(window, 'setInterval').mockImplementation((callback, delay) => {
      if (delay === 2_000) poll = callback as () => void;
      return 73;
    });
    const clearInterval = vi.spyOn(window, 'clearInterval');
    const view = render(<App />);

    await waitFor(() => expect(resolvers).toHaveLength(1));
    poll?.();
    await waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[1](availableChanges('active-run', 9, 1));
    await screen.findByRole('button', { name: 'Changes +9 −1' });
    resolvers[0](availableChanges('active-run', 1, 0));
    await Promise.resolve();

    expect(screen.getByRole('button', { name: 'Changes +9 −1' })).toBeTruthy();
    view.unmount();
    expect(clearInterval).toHaveBeenCalledWith(73);
  });
});
