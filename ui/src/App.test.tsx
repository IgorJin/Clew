import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureProjects, fixtureTasks } from './fixtures';
import type { Task, ThreadItem } from './types';

const api = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  execute: vi.fn(async (_args: string[]): Promise<unknown> => ({ fixture: true })),
  loadTasks: vi.fn(async () => ({
    tasks: structuredClone(fixtureTasks),
    projects: structuredClone(fixtureProjects),
    state: 'fixture',
  })),
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
    localStorage.clear();
    api.execute.mockReset();
    api.execute.mockResolvedValue({ fixture: true });
    api.loadTasks.mockReset();
    api.loadTasks.mockResolvedValue({
      tasks: structuredClone(fixtureTasks),
      projects: structuredClone(fixtureProjects),
      state: 'fixture',
    });
    api.subscribeToEvents.mockClear();
  });

  it('opens the finalization gate and completes the pinned revision', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { container } = render(<App />);
    const finishButton = await screen.findByRole('button', { name: /finish work/i });

    expect(container.querySelector('[aria-label="Finalization gate"]')).toBeNull();

    fireEvent.click(finishButton);
    fireEvent.click(await screen.findByRole('button', { name: /complete task/i }));

    expect(api.execute).toHaveBeenCalledWith(['complete', 'CLEW-071', '--revision', 'a91c4e2']);
    expect(await screen.findByText('Task completed')).toBeTruthy();
  });

  it('uses the finalization gate for Git integration', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const gitTask = structuredClone(fixtureTasks[0]);

    gitTask.state = 'READY_TO_FINISH';
    gitTask.finalization = {
      ...gitTask.finalization!,
      state: 'READY_TO_FINISH',
      ready: true,
      availableActions: ['review_changes', 'integrate'],
      recommendedAction: 'integrate',
      git: {
        enabled: true,
        targetBranch: 'main',
        strategy: 'squash',
        cleanup: true,
        dirty: false,
        conflicts: false,
      },
    };
    api.loadTasks.mockResolvedValue({
      tasks: [gitTask],
      projects: structuredClone(fixtureProjects),
      state: 'fixture',
    });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /finish work/i }));
    expect(await screen.findByRole('dialog', { name: /finish work/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^integrate$/i }));

    expect(api.execute).toHaveBeenCalledWith([
      'task',
      'integrate',
      'CLEW-071',
      '--strategy',
      'squash',
      '--message',
      'Integrate CLEW-071',
    ]);
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
    api.loadTasks.mockResolvedValueOnce({
      tasks,
      projects: structuredClone(fixtureProjects),
      state: 'connected',
    });
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
    api.loadTasks.mockResolvedValueOnce({
      tasks,
      projects: structuredClone(fixtureProjects),
      state: 'connected',
    });
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
      projects: structuredClone(fixtureProjects),
      state: 'connected',
    });
    api.subscribeToEvents.mockImplementationOnce((_after, _onEvent, onState) => {
      reportState = onState;

      return () => undefined;
    });
    render(<App />);
    const complete = await screen.findByRole('button', { name: /finish work/i });

    expect(complete.hasAttribute('disabled')).toBe(false);
    reportState?.('disconnected');
    await waitFor(() => expect(complete.hasAttribute('disabled')).toBe(true));
    expect(screen.getByRole('alert').textContent).toMatch(/last known data/i);
    expect(screen.getByRole('alert').textContent).toMatch(/actions are disabled/i);
  });

  it('creates a task from the minimal form and starts a Quick workflow immediately', async () => {
    const confirm = vi.spyOn(window, 'confirm');

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /new/i }));

    expect(screen.getAllByRole('textbox')).toHaveLength(2);
    expect(screen.queryByText(/complexity/i)).toBeNull();
    expect(screen.queryByRole('textbox', { name: /tags/i })).toBeNull();
    fireEvent.input(screen.getByRole('textbox', { name: /^title$/i }), {
      target: { value: 'Read-only MVP task' },
    });
    fireEvent.input(screen.getByRole('textbox', { name: /^description$/i }), {
      target: { value: 'List files without changing them' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^create task$/i }));

    const createArgs = await waitFor(() => {
      const call = api.execute.mock.calls.find(
        ([args]) => (args as string[])[0] === 'task' && (args as string[])[1] === 'create',
      );

      expect(call).toBeTruthy();
      return call![0] as string[];
    });
    const id = createArgs[createArgs.indexOf('--id') + 1];

    expect(id).toMatch(/^CLEW-[A-F0-9]{12}$/);
    expect(createArgs).toEqual([
      'task',
      'create',
      '--id',
      id,
      '--project',
      'PRJ-CLEW',
      '--title',
      'Read-only MVP task',
      '--description',
      'List files without changing them',
      '--profile',
      'auto',
      '--risk',
      'low',
      '--accept',
      'Deliver the requested outcome: List files without changing them',
    ]);
    await waitFor(() => expect(api.execute).toHaveBeenCalledWith(['task', 'next-step', id]));
    await waitFor(() =>
      expect(api.execute).toHaveBeenCalledWith([
        'task',
        'approve-step',
        id,
        '--action',
        `action-${id}`,
      ]),
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: /start this task/i })).toBeNull();
    expect(window.location.pathname).toBe(`/projects/clew/tasks/${id}`);
  });

  it('requires both title and description before creating a task', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /new/i }));
    fireEvent.input(screen.getByRole('textbox', { name: /^description$/i }), {
      target: { value: 'Investigate terminal startup' },
    });
    const form = screen.getByRole('textbox', { name: /^description$/i }).closest('form')!;

    fireEvent.submit(form);
    expect(
      api.execute.mock.calls.filter(
        ([args]) => (args as string[])[0] === 'task' && (args as string[])[1] === 'create',
      ),
    ).toHaveLength(0);
  });

  it('sends one create command when the form is submitted repeatedly while pending', async () => {
    let resolveCreate!: (value: unknown) => void;
    const pendingCreate = new Promise<unknown>((resolve) => {
      resolveCreate = resolve;
    });

    api.execute.mockImplementation(async (args: string[]) => {
      if (args[0] === 'task' && args[1] === 'create') return pendingCreate;
      return { fixture: true };
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /new/i }));
    fireEvent.input(screen.getByRole('textbox', { name: /^title$/i }), {
      target: { value: 'Single flight creation' },
    });
    fireEvent.input(screen.getByRole('textbox', { name: /^description$/i }), {
      target: { value: 'Create this task exactly once' },
    });
    const form = screen.getByRole('textbox', { name: /^description$/i }).closest('form')!;

    fireEvent.submit(form);
    fireEvent.submit(form);
    fireEvent.click(screen.getByRole('button', { name: /creating/i }));

    expect(
      api.execute.mock.calls.filter(
        ([args]) => (args as string[])[0] === 'task' && (args as string[])[1] === 'create',
      ),
    ).toHaveLength(1);
    expect(screen.getByRole('button', { name: /creating/i }).hasAttribute('disabled')).toBe(true);

    resolveCreate({ fixture: true });
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: /create a task/i })).toBeNull(),
    );
  });

  it.each(['standard', 'deep'] as const)(
    'uses the product approval dialog for a %s task and keeps approval single-flight',
    async (profile) => {
      const confirm = vi.spyOn(window, 'confirm');
      const draft = structuredClone(fixtureTasks[0]);
      const actionId = `action-${profile}`;

      draft.state = 'DRAFT';
      draft.profile = profile;
      draft.runs = [];
      draft.runId = null;
      draft.runStatus = null;
      api.loadTasks.mockResolvedValue({
        tasks: [draft],
        projects: structuredClone(fixtureProjects),
        state: 'connected',
      });
      api.execute.mockImplementation(async (args: string[]) => {
        if (args[0] === 'task' && args[1] === 'next-step')
          return {
            id: actionId,
            taskId: draft.id,
            kind: 'start_worker',
            currentStep: 'DRAFT',
            resultingStep: 'EXECUTING',
            summary: `Start the ${profile} workflow`,
            inputs: { harness: 'codex', profile, permissionMode: 'read-only' },
            sideEffects: ['start one local worker process', 'create one run record'],
            approvalRequired: true,
            status: 'PENDING',
          };
        return { fixture: true };
      });
      render(<App />);

      fireEvent.click(await screen.findByRole('button', { name: /^next step$/i }));
      fireEvent.click(await screen.findByRole('button', { name: /^approve start$/i }));
      expect(await screen.findByRole('dialog', { name: /start this task/i })).toBeTruthy();
      expect(screen.getByText(`${profile} workflow`)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
      expect(screen.queryByRole('dialog', { name: /start this task/i })).toBeNull();
      expect(
        api.execute.mock.calls.filter(
          ([args]) => (args as string[])[0] === 'task' && (args as string[])[1] === 'approve-step',
        ),
      ).toHaveLength(0);

      fireEvent.click(screen.getByRole('button', { name: /^approve start$/i }));
      const start = await screen.findByRole('button', { name: /^start task$/i });

      fireEvent.click(start);
      fireEvent.click(start);
      await waitFor(() =>
        expect(
          api.execute.mock.calls.filter(
            ([args]) =>
              (args as string[])[0] === 'task' && (args as string[])[1] === 'approve-step',
          ),
        ).toHaveLength(1),
      );
      expect(api.execute).toHaveBeenCalledWith([
        'task',
        'approve-step',
        draft.id,
        '--action',
        actionId,
      ]);
      expect(confirm).not.toHaveBeenCalled();
    },
  );

  it('opens the live worker terminal externally before a Codex session id exists', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const runningTasks = structuredClone(fixtureTasks);

    runningTasks[0].state = 'EXECUTING';
    runningTasks[0].runStatus = 'RUNNING';
    runningTasks[0].sessionId = null;
    runningTasks[0].sessionHarness = 'codex';
    runningTasks[0].sessionStageId = 'worker';
    api.loadTasks.mockResolvedValueOnce({
      tasks: runningTasks,
      projects: structuredClone(fixtureProjects),
      state: 'connected',
    });
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
    api.loadTasks.mockResolvedValueOnce({
      tasks: runningTasks,
      projects: structuredClone(fixtureProjects),
      state: 'connected',
    });
    render(<App />);

    const terminal = await screen.findByRole('region', { name: /live codex terminal/i });
    expect(terminal.textContent).toContain('run-live-1');
  });

  it('expands a stored architect session inside its agent card', async () => {
    const tasks = structuredClone(fixtureTasks);
    tasks[0].roles = ['architect', 'worker'];
    api.loadTasks.mockResolvedValueOnce({
      tasks,
      projects: structuredClone(fixtureProjects),
      state: 'connected',
    });
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
    api.loadTasks.mockResolvedValueOnce({
      tasks: waitingTasks,
      projects: structuredClone(fixtureProjects),
      state: 'connected',
    });
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

    expect(screen.queryByRole('region', { name: 'review step details' })).toBeNull();
    fireEvent.click(review);
    const details = screen.getByRole('region', { name: 'review step details' });

    expect(review.getAttribute('aria-pressed')).toBe('true');
    expect(within(details).getByText('Status')).toBeTruthy();
    expect(within(details).getByText('Prerequisites')).toBeTruthy();
    expect(within(details).getByText('Available action')).toBeTruthy();
    expect(within(details).getByText('Approval')).toBeTruthy();
    expect(within(details).getByText('Side effects')).toBeTruthy();

    fireEvent.click(review);
    expect(screen.queryByRole('region', { name: 'review step details' })).toBeNull();
  });

  it('orders sidebar tasks newest first with a stable id tie-breaker', async () => {
    const tasks = structuredClone(fixtureTasks).slice(0, 2);
    tasks[0].createdAt = '2026-09-01T10:00:00.000Z';
    tasks[1].createdAt = '2026-09-01T10:00:00.000Z';
    tasks[0].id = 'CLEW-A';
    tasks[1].id = 'CLEW-Z';
    api.loadTasks.mockResolvedValueOnce({
      tasks,
      projects: structuredClone(fixtureProjects),
      state: 'connected',
    });
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
    api.loadTasks.mockResolvedValueOnce({
      tasks,
      projects: structuredClone(fixtureProjects),
      state: 'connected',
    });
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
    expect(runSelect.closest('label')?.querySelector('.sr-only')?.textContent).toBe(
      'Select change run',
    );
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
    api.loadTasks.mockResolvedValueOnce({
      tasks,
      projects: structuredClone(fixtureProjects),
      state: 'connected',
    });
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
    api.loadTasks.mockResolvedValueOnce({
      tasks,
      projects: structuredClone(fixtureProjects),
      state: 'connected',
    });
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

describe('project shell', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    sessionStorage.clear();
    localStorage.clear();
  });

  it('renders the selected project switcher and scoped task list', async () => {
    render(<App />);

    expect(await screen.findByRole('button', { name: /project: clew/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /replace auth middleware/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /parallel cache migration/i })).toBeTruthy();
    expect(screen.queryByText(/lykar/i)).toBeNull();
  });

  it('switches project scope from the switcher and updates the route', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /project: clew/i }));
    fireEvent.click(await screen.findByRole('button', { name: /lykar/i }));
    expect(window.location.pathname).toBe('/projects/lykar');

    // Lykar has no tasks, so the scoped empty state appears.
    expect(await screen.findByText('No tasks yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /replace auth middleware/i })).toBeNull();
  });

  it('resolves a project-scoped deep link directly', async () => {
    window.history.replaceState({}, '', '/projects/clew/tasks/ACC-DEEP');
    render(<App />);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Parallel cache migration' }),
    ).toBeTruthy();
  });

  it('keeps legacy project-id links working and canonicalizes them to the project name', async () => {
    window.history.replaceState({}, '', '/projects/PRJ-CLEW/tasks/ACC-DEEP');
    render(<App />);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Parallel cache migration' }),
    ).toBeTruthy();
    expect(window.location.pathname).toBe('/projects/clew/tasks/ACC-DEEP');
  });

  it('persists the selected project and last opened task across reloads', async () => {
    const { unmount } = render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /parallel cache migration/i }));
    expect(window.location.pathname).toBe('/projects/clew/tasks/ACC-DEEP');
    unmount();

    window.history.replaceState({}, '', '/');
    render(<App />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Parallel cache migration' }),
    ).toBeTruthy();
  });

  it('shows the welcome state with no projects', async () => {
    api.loadTasks.mockResolvedValueOnce({ tasks: [], projects: [], state: 'fixture' });
    render(<App />);

    expect(await screen.findByText('Welcome to Clew')).toBeTruthy();
    expect(screen.getByRole('button', { name: /add project/i })).toBeTruthy();
  });

  it('shows a scoped empty state when the selected project has no tasks', async () => {
    const tasks = structuredClone(fixtureTasks).map((task) => ({
      ...task,
      projectId: 'PRJ-LYKAR',
    }));
    api.loadTasks.mockResolvedValueOnce({
      tasks,
      projects: structuredClone(fixtureProjects),
      state: 'fixture',
    });
    render(<App />);

    expect(await screen.findByText('No tasks yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: /new task/i })).toBeTruthy();
  });

  it('does not show an unassigned task in every project', async () => {
    const task = structuredClone(fixtureTasks[0]);

    task.projectId = null;
    api.loadTasks.mockResolvedValueOnce({
      tasks: [task],
      projects: structuredClone(fixtureProjects),
      state: 'fixture',
    });
    window.history.replaceState({}, '', '/projects/lykar');
    render(<App />);

    expect(await screen.findByText('No tasks yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /replace auth middleware/i })).toBeNull();
  });

  it('issues no control-plane commands while navigating between projects and tasks', async () => {
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /project: clew/i }));
    fireEvent.click(await screen.findByRole('button', { name: /lykar/i }));
    fireEvent.click(await screen.findByRole('button', { name: /project: lykar/i }));
    fireEvent.click(await screen.findByRole('button', { name: /clew/i }));
    fireEvent.click(await screen.findByRole('button', { name: /parallel cache migration/i }));
    fireEvent.click(await screen.findByRole('button', { name: /overview/i }));

    const controlPlaneCalls = api.execute.mock.calls.filter(([args]) => {
      const command = (args as string[])[0];
      const subcommand = (args as string[])[1];

      return command !== 'task' || subcommand !== 'changes';
    });

    expect(controlPlaneCalls).toHaveLength(0);
  });

  it('returns focus to the switcher trigger on Escape', async () => {
    render(<App />);
    const trigger = await screen.findByRole('button', { name: /project: clew/i });

    fireEvent.click(trigger);
    expect(await screen.findByRole('button', { name: /lykar/i })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('button', { name: /lykar/i })).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it('recovers the add-project dialog when the daemon rejects the folder', async () => {
    api.loadTasks.mockResolvedValueOnce({ tasks: [], projects: [], state: 'fixture' });
    api.execute.mockRejectedValueOnce(new Error('not a git repository: /tmp/nope'));
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /add project/i }));
    const dialog = screen.getByRole('textbox', { name: /folder/i }).closest('form') as HTMLElement;

    fireEvent.input(screen.getByRole('textbox', { name: /folder/i }), {
      target: { value: '/tmp/nope' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: /^add project$/i }));

    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect(within(dialog).getByRole('alert').textContent).toContain('not a git repository');
    const submit = within(dialog).getByRole('button', { name: /^add project$/i });

    expect(submit.hasAttribute('disabled')).toBe(false);
    expect(
      within(dialog)
        .getByRole('button', { name: /^cancel$/i })
        .hasAttribute('disabled'),
    ).toBe(false);
  });

  it('fills the project folder from the native folder picker', async () => {
    api.execute.mockImplementation(async (args: string[]) =>
      args[0] === 'project' && args[1] === 'browse'
        ? { folder: '/Users/me/dev/chosen-repo' }
        : { fixture: true },
    );
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /project: clew/i }));
    fireEvent.click(await screen.findByRole('button', { name: /add project/i }));
    fireEvent.click(screen.getByRole('button', { name: /browse/i }));

    await waitFor(() =>
      expect((screen.getByRole('textbox', { name: /folder/i }) as HTMLInputElement).value).toBe(
        '/Users/me/dev/chosen-repo',
      ),
    );
    expect((screen.getByRole('textbox', { name: /project name/i }) as HTMLInputElement).value).toBe(
      'chosen-repo',
    );
    expect(api.execute).toHaveBeenCalledWith(['project', 'browse']);
  });

  it('keeps the add-project dialog open when folder selection is canceled', async () => {
    api.execute.mockImplementation(async (args: string[]) =>
      args[0] === 'project' && args[1] === 'browse' ? { folder: null } : { fixture: true },
    );
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /project: clew/i }));
    fireEvent.click(await screen.findByRole('button', { name: /add project/i }));
    fireEvent.click(screen.getByRole('button', { name: /browse/i }));

    await waitFor(() => expect(api.execute).toHaveBeenCalledWith(['project', 'browse']));
    expect((screen.getByRole('textbox', { name: /folder/i }) as HTMLInputElement).value).toBe('');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('project overview', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    sessionStorage.clear();
    localStorage.clear();
  });

  it('orders Needs attention before Running and Ready sections', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /^overview$/i }));

    await screen.findByRole('heading', { name: 'Clew' });
    const overview = screen.getByText('Needs attention').closest('.overview') as HTMLElement;
    const sections = within(overview)
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);

    expect(sections).toEqual([
      'Needs attention',
      'Running',
      'Ready',
      'Recently completed',
      'Failed',
    ]);
    expect(within(overview).getByText('Parallel cache migration')).toBeTruthy();
    expect(within(overview).getByText('Session revocation rollout')).toBeTruthy();
    expect(within(overview).getByText('Refresh token cleanup')).toBeTruthy();
    expect(within(overview).getByText('Cache invalidation probe')).toBeTruthy();
  });

  it('omits empty overview sections entirely', async () => {
    const tasks = structuredClone(fixtureTasks).map((task) => ({
      ...task,
      projectId: 'PRJ-LYKAR',
      state: 'EXECUTING' as const,
      attention: null,
      runs: [
        {
          id: 'run-x',
          stageId: 'worker',
          attempt: 1,
          status: 'RUNNING',
          harness: 'codex',
          sessionId: 's-x',
          workspace: '/tmp/x',
          commitSha: null,
          startedAt: new Date().toISOString(),
          finishedAt: null,
        },
      ],
    }));
    api.loadTasks.mockResolvedValueOnce({
      tasks,
      projects: structuredClone(fixtureProjects),
      state: 'fixture',
    });
    window.history.replaceState({}, '', '/projects/lykar/overview');
    render(<App />);

    await screen.findByRole('heading', { name: 'Lykar' });
    const overview = screen.getByText('Running').closest('.overview') as HTMLElement;
    const headings = within(overview)
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);

    expect(headings).toEqual(['Running']);
  });

  it('opens the task when an overview row is selected', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /^overview$/i }));
    const overview = screen.getByText('Needs attention').closest('.overview') as HTMLElement;
    fireEvent.click(within(overview).getByRole('button', { name: /session revocation rollout/i }));

    expect(window.location.pathname).toBe('/projects/clew/tasks/CLW-EXEC');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Session revocation rollout' }),
    ).toBeTruthy();
  });

  it('renders a compact project breadcrumb above the task title', async () => {
    render(<App />);

    expect(await screen.findByRole('button', { name: /^clew$/i })).toBeTruthy();
    expect(
      (await screen.findByRole('heading', { level: 1, name: 'Replace auth middleware' }))
        .textContent,
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /^clew$/i }).nextSibling?.textContent).toBe('/');
  });
});

describe('project awareness', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    sessionStorage.clear();
    localStorage.clear();
  });

  function mixedProjectTasks(): Task[] {
    const base = structuredClone(fixtureTasks);
    const exec = structuredClone(base.find((task) => task.id === 'CLW-EXEC')!);
    const waiting = structuredClone(base.find((task) => task.id === 'ACC-DEEP')!);

    exec.id = 'LYK-RUN';
    exec.projectId = 'PRJ-LYKAR';
    exec.title = 'Lykar rollout';
    waiting.id = 'LYK-WAIT';
    waiting.projectId = 'PRJ-LYKAR';
    waiting.title = 'Lykar review needed';

    return [...base, exec, waiting];
  }

  function idleProjectTasks(): Task[] {
    const base = structuredClone(fixtureTasks).map((task) => ({
      ...task,
      state: 'READY' as const,
      attention: null,
      runStatus: null,
      runs: [],
      stages: [],
      interactionStatus: null,
    }));
    const idle = structuredClone(base[0]);

    idle.id = 'LYK-IDLE';
    idle.projectId = 'PRJ-LYKAR';
    idle.title = 'Idle Lykar task';

    return [...base, idle];
  }

  function projectMenu(): HTMLElement {
    return document.querySelector('.project-menu') as HTMLElement;
  }

  it('shows running and waiting counts per project in the switcher', async () => {
    api.loadTasks.mockResolvedValueOnce({
      tasks: mixedProjectTasks(),
      projects: structuredClone(fixtureProjects),
      state: 'fixture',
    });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /project: clew/i }));
    const lykarItem = await within(projectMenu()).findByRole('button', { name: /lykar/i });

    expect(lykarItem.textContent).toContain('1 running');
    expect(lykarItem.textContent).toContain('1 waiting');

    const clewItem = within(projectMenu()).getByRole('button', { name: /clew/i });

    expect(clewItem.textContent).toContain('1 running');
    expect(clewItem.textContent).toContain('1 waiting');
  });

  it('counts waiting tasks across all projects in the global attention indicator', async () => {
    api.loadTasks.mockResolvedValueOnce({
      tasks: mixedProjectTasks(),
      projects: structuredClone(fixtureProjects),
      state: 'fixture',
    });
    render(<App />);

    expect(await screen.findByRole('button', { name: '2 attention items' })).toBeTruthy();
  });

  it('jumps to a waiting task from another project in one action', async () => {
    api.loadTasks.mockResolvedValueOnce({
      tasks: mixedProjectTasks(),
      projects: structuredClone(fixtureProjects),
      state: 'fixture',
    });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: /attention/i }));
    fireEvent.click(await screen.findByRole('button', { name: /lykar review needed/i }));

    expect(window.location.pathname).toBe('/projects/lykar/tasks/LYK-WAIT');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Lykar review needed' }),
    ).toBeTruthy();
  });

  it('opens the palette with Cmd+K and selects a task with the keyboard', async () => {
    api.loadTasks.mockResolvedValueOnce({
      tasks: mixedProjectTasks(),
      projects: structuredClone(fixtureProjects),
      state: 'fixture',
    });
    render(<App />);
    await screen.findByRole('button', { name: /project: clew/i });

    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    const dialog = await screen.findByRole('dialog', { name: /command palette/i });
    const input = within(dialog).getByRole('textbox');

    fireEvent.input(input, { target: { value: 'lyk-wait' } });
    fireEvent.keyDown(document.body, { key: 'Enter' });

    expect(window.location.pathname).toBe('/projects/lykar/tasks/LYK-WAIT');
  });

  it('selects a palette entry with the pointer', async () => {
    api.loadTasks.mockResolvedValueOnce({
      tasks: mixedProjectTasks(),
      projects: structuredClone(fixtureProjects),
      state: 'fixture',
    });
    render(<App />);
    await screen.findByRole('button', { name: /project: clew/i });

    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    const dialog = await screen.findByRole('dialog', { name: /command palette/i });
    const input = within(dialog).getByRole('textbox');

    fireEvent.input(input, { target: { value: 'lykar review needed' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /lykar review needed/i }));

    expect(window.location.pathname).toBe('/projects/lykar/tasks/LYK-WAIT');
  });

  it('closes the palette with Escape', async () => {
    render(<App />);
    await screen.findByRole('button', { name: /project: clew/i });

    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    expect(await screen.findByRole('dialog', { name: /command palette/i })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /command palette/i })).toBeNull(),
    );
  });

  it('stays muted when no project has running or waiting work', async () => {
    api.loadTasks.mockResolvedValueOnce({
      tasks: idleProjectTasks(),
      projects: structuredClone(fixtureProjects),
      state: 'fixture',
    });
    render(<App />);

    expect(await screen.findByRole('button', { name: /project: clew/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /attention/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /project: clew/i }));
    const lykarItem = await within(projectMenu()).findByRole('button', { name: /lykar/i });
    const clewItem = within(projectMenu()).getByRole('button', { name: /clew/i });

    expect(lykarItem.textContent).not.toContain('running');
    expect(lykarItem.textContent).not.toContain('waiting');
    expect(clewItem.textContent).not.toContain('running');
    expect(clewItem.textContent).not.toContain('waiting');
  });
});
