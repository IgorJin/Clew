import { fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { useState } from 'preact/hooks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureProjects, fixtureTasks } from './fixtures';
import {
  listShortcuts,
  optionModifierLabel,
  primaryModifierLabel,
  resolveShortcut,
  useShortcuts,
} from './shortcuts';
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

async function confirmAction() {
  const dialog = await screen.findByRole('dialog', { name: /confirm action/i });
  const buttons = within(dialog).getAllByRole('button');

  fireEvent.click(buttons[buttons.length - 1]);
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

  it('keeps the next action primary and cancels an unfinished task with confirmation', async () => {
    const nativeConfirm = vi.spyOn(window, 'confirm');
    const { container } = render(<App />);
    const cancelButton = await screen.findByRole('button', { name: /cancel task/i });
    const nextAction = await screen.findByRole('button', { name: /^continue$/i });

    expect(container.querySelector('[aria-label="Finalization gate"]')).toBeNull();
    expect(cancelButton.className).toContain('danger-outline');
    expect(nextAction.className).toContain('primary');

    fireEvent.click(cancelButton);
    await confirmAction();

    await waitFor(() => expect(api.execute).toHaveBeenCalledWith(['interrupt', 'CLEW-071']));
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(await screen.findByText('Task cancellation requested')).toBeTruthy();
  });

  it('keeps cancellation outlined for a task that is ready to finish', async () => {
    const nativeConfirm = vi.spyOn(window, 'confirm');
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

    const cancelButton = await screen.findByRole('button', { name: /cancel task/i });
    expect(cancelButton.className).toContain('danger-outline');
    fireEvent.click(cancelButton);
    await confirmAction();

    await waitFor(() => expect(api.execute).toHaveBeenCalledWith(['interrupt', 'CLEW-071']));
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  it('restarts READY work without a message panel', async () => {
    const nativeConfirm = vi.spyOn(window, 'confirm');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /^continue$/i }));
    await confirmAction();

    await waitFor(() =>
      expect(api.execute).toHaveBeenCalledWith([
        'continue',
        'CLEW-071',
        '--message',
        'Restart the worker and re-check the task',
      ]),
    );
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(screen.queryByText('Add a message')).toBeNull();
    expect(await screen.findByText('Worker restart requested')).toBeTruthy();
  });

  it('approves a plan and exposes the durable fixture state', async () => {
    const nativeConfirm = vi.spyOn(window, 'confirm');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /parallel cache migration/i }));
    fireEvent.click(screen.getByRole('button', { name: /approve plan/i }));
    await confirmAction();

    await waitFor(() => expect(api.execute).toHaveBeenCalledWith(['approve', 'ACC-DEEP']));
    expect(nativeConfirm).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /confirm action/i })).toBeNull(),
    );
  });

  it('explains worker approval without exposing protocol details', async () => {
    const nativeConfirm = vi.spyOn(window, 'confirm');
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
    const dialog = await screen.findByRole('dialog', { name: /allow worker action/i });
    expect(dialog.textContent).not.toContain('npm test');
    expect(dialog.textContent).not.toContain('item/commandExecution/requestApproval');
    await confirmAction();

    await waitFor(() => expect(api.execute).toHaveBeenCalledWith(['approve-run', 'approval-1']));
    expect(nativeConfirm).not.toHaveBeenCalled();
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

  it('formats thread status transitions and keeps worker output behind a tooltip', () => {
    const items: ThreadItem[] = [
      {
        version: 1,
        id: 'created',
        cursor: 1,
        kind: 'task_created',
        at: '2026-08-28T09:42:00.000Z',
        source: { kind: 'event', id: 'event-1' },
        summary: 'Task created: Fixture',
      },
      {
        version: 1,
        id: 'started',
        cursor: 2,
        kind: 'run_started',
        at: '2026-08-28T09:43:00.000Z',
        source: { kind: 'run', id: 'event-2' },
        summary: 'Stage worker run started',
      },
      {
        version: 1,
        id: 'output',
        cursor: 3,
        kind: 'worker_output',
        at: '2026-08-28T09:44:00.000Z',
        source: { kind: 'worker', id: 'event-3' },
        summary: 'Worker output:\nfull worker response\nwith multiple lines',
      },
    ];

    render(<Thread items={items} />);

    expect(screen.getAllByText('Task status changed')).toHaveLength(2);
    expect(screen.getByText('EXECUTION')).toBeTruthy();
    expect(screen.queryByRole('tooltip')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /expand worker response/i }));
    expect(screen.getByRole('tooltip').textContent).toContain('full worker response');

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('tooltip')).toBeNull();
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
    const cancel = await screen.findByRole('button', { name: /cancel task/i });

    expect(cancel.hasAttribute('disabled')).toBe(false);
    reportState?.('disconnected');
    await waitFor(() => expect(cancel.hasAttribute('disabled')).toBe(true));
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
      fireEvent.click(await screen.findByRole('button', { name: /^next step$/i }));
      expect(await screen.findByRole('dialog', { name: /start this task/i })).toBeTruthy();
      expect(screen.getByText(`${profile} workflow`)).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
      expect(screen.queryByRole('dialog', { name: /start this task/i })).toBeNull();
      expect(
        api.execute.mock.calls.filter(
          ([args]) => (args as string[])[0] === 'task' && (args as string[])[1] === 'approve-step',
        ),
      ).toHaveLength(0);

      fireEvent.click(screen.getByRole('button', { name: /^next step$/i }));
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
    expect(screen.queryByRole('button', { name: /close terminal/i })).toBeNull();
    expect(terminal.textContent).not.toContain('attached');
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

  it('shows recorded reviewer findings even when no terminal session was persisted', async () => {
    const tasks = structuredClone(fixtureTasks);

    tasks[0].state = 'EXECUTING';
    tasks[0].reviewed = true;
    tasks[0].findings = 2;
    tasks[0].agentSessions = tasks[0].agentSessions.filter(
      (session) => session.role !== 'reviewer',
    );
    api.loadTasks.mockResolvedValueOnce({
      tasks,
      projects: structuredClone(fixtureProjects),
      state: 'connected',
    });
    render(<App />);

    expect(await screen.findByText('2 open')).toBeTruthy();
    expect(screen.getByText('Review requested corrections · 2 open findings')).toBeTruthy();
    expect(screen.queryByText('Plan not created yet')).toBeNull();
  });

  it('shows paired reviewer sessions without offering a controller-local terminal', async () => {
    const tasks = structuredClone(fixtureTasks);

    tasks[0].agentSessions.push({
      id: 'CLEW-071:reviewer:runner-review-session',
      taskId: 'CLEW-071',
      role: 'reviewer',
      harness: 'codex',
      sessionId: 'runner-review-session',
      workspace: 'runner-workspace:clew',
      terminalAccess: 'runner_local',
      createdAt: '2026-08-28T10:05:00.000Z',
    });
    api.loadTasks.mockResolvedValueOnce({
      tasks,
      projects: structuredClone(fixtureProjects),
      state: 'connected',
    });
    render(<App />);

    expect(await screen.findByText(/session recorded on Runner/i)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: /open reviewer externally/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
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
    expect(screen.getByText(/waiting for your answer/i)).toBeTruthy();
    expect(screen.getByText('Waiting for operator')).toBeTruthy();
    expect(container.querySelectorAll('.status-notice')).toHaveLength(1);
    expect(container.querySelector('.terminal-waiting-banner')).toBeNull();
  });

  it('keeps the change summary only in the task header', async () => {
    api.execute.mockImplementation(async (args: string[]) =>
      args[0] === 'task' && args[1] === 'changes' ? availableChanges(args[2]) : { fixture: true },
    );
    const { container } = render(<App />);

    await screen.findByRole('button', { name: '+4, -2' });
    expect(container.querySelectorAll('.changes-control')).toHaveLength(1);
    expect(container.querySelector('.agent-card .changes-control')).toBeNull();
  });

  it('selects workflow steps and exposes contextual state, prerequisites, action and effects', async () => {
    render(<App />);
    const review = await screen.findByRole('button', { name: 'Review' });

    expect(screen.queryByRole('tooltip', { name: 'review step details' })).toBeNull();
    fireEvent.click(review);
    const details = screen.getByRole('tooltip', { name: 'review step details' });

    expect(review.getAttribute('aria-pressed')).toBe('true');
    expect(within(details).getByText('Status')).toBeTruthy();
    expect(within(details).getByText('Prerequisites')).toBeTruthy();
    expect(within(details).getByText('Available action')).toBeTruthy();
    expect(within(details).getByText('Approval')).toBeTruthy();
    expect(within(details).getByText('Side effects')).toBeTruthy();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('tooltip', { name: 'review step details' })).toBeNull();

    fireEvent.click(review);
    expect(screen.queryByRole('tooltip', { name: 'review step details' })).toBeTruthy();
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

    const changes = await screen.findByRole('button', { name: '+7, -2' });

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
    fireEvent.click(await screen.findByRole('button', { name: /^\+9, -0$/ }));
    expect(api.execute).toHaveBeenCalledWith([
      'task',
      'open-changes',
      'CLEW-071',
      '--run',
      'backend-2',
    ]);
    fireEvent.change(runSelect, { target: { value: 'frontend-1' } });
    expect(await screen.findByRole('button', { name: 'Unavailable' })).toBeTruthy();
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
    await screen.findByRole('button', { name: '+4, -2' });

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
    await screen.findByRole('button', { name: '+9, -1' });
    resolvers[0](availableChanges('active-run', 1, 0));
    await Promise.resolve();

    expect(screen.getByRole('button', { name: '+9, -1' })).toBeTruthy();
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

  it('renders the project skeleton while the initial data is loading', () => {
    api.loadTasks.mockReturnValueOnce(new Promise<never>(() => undefined));
    render(<App />);

    expect(screen.getByRole('status', { name: 'Loading project' })).toBeTruthy();
    expect(screen.queryByText('Connecting…')).toBeNull();
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
    expect(screen.getAllByRole('button', { name: /new task/i })).toHaveLength(2);
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

  function board(): HTMLElement {
    return document.querySelector('.kanban') as HTMLElement;
  }

  function columnHeadings(element: HTMLElement) {
    return within(element)
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
  }

  it('renders the kanban board grouped by status from the sidebar toggle', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /^overview$/i }));

    await screen.findByRole('heading', { name: 'Clew' });
    const kanban = board();
    const columns = columnHeadings(kanban);

    expect(columns).toEqual(['Active', 'Waiting', 'Ready', 'Done', 'Failed']);
    expect(within(kanban).getByText('Parallel cache migration')).toBeTruthy();
    expect(within(kanban).getByText('Session revocation rollout')).toBeTruthy();
    expect(within(kanban).getByText('Refresh token cleanup')).toBeTruthy();
    expect(within(kanban).getByText('Cache invalidation probe')).toBeTruthy();
    expect(within(kanban).getByText('Replace auth middleware')).toBeTruthy();
  });

  it('omits empty columns entirely', async () => {
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
    expect(columnHeadings(board())).toEqual(['Active']);
  });

  it('opens the task when a kanban card is selected', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /^overview$/i }));
    fireEvent.click(within(board()).getByRole('button', { name: /session revocation rollout/i }));

    expect(window.location.pathname).toBe('/projects/clew/tasks/CLW-EXEC');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Session revocation rollout' }),
    ).toBeTruthy();
  });

  it('filters the board to tasks requiring attention', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /^overview$/i }));
    const toggle = screen.getByRole('button', { name: /^needs attention$/i });

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(columnHeadings(board())).toEqual(['Waiting']);
    expect(within(board()).getByText('Parallel cache migration')).toBeTruthy();
    expect(within(board()).queryByText('Session revocation rollout')).toBeNull();
  });

  it('filters the board by status and type', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /^overview$/i }));

    fireEvent.change(screen.getByRole('combobox', { name: /filter by status/i }), {
      target: { value: 'EXECUTING' },
    });
    expect(columnHeadings(board())).toEqual(['Active']);
    expect(within(board()).getByText('Session revocation rollout')).toBeTruthy();
    expect(within(board()).queryByText('Replace auth middleware')).toBeNull();

    fireEvent.change(screen.getByRole('combobox', { name: /filter by type/i }), {
      target: { value: 'deep' },
    });
    expect(within(board()).queryByText('Session revocation rollout')).toBeNull();
    expect(board().textContent).toContain('No tasks match the current filters.');

    fireEvent.change(screen.getByRole('combobox', { name: /filter by status/i }), {
      target: { value: 'all' },
    });
    expect(within(board()).getByText('Parallel cache migration')).toBeTruthy();
    expect(within(board()).queryByText('Replace auth middleware')).toBeNull();
  });

  it('renders the project switcher in the topbar without a project breadcrumb', async () => {
    render(<App />);

    expect(await screen.findByRole('button', { name: /project: clew/i })).toBeTruthy();
    expect(
      (await screen.findByRole('heading', { level: 1, name: 'Replace auth middleware' }))
        .textContent,
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^clew$/i })).toBeNull();
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

describe('settings modal (CLEW-099)', () => {
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

  function connectionLabels(dialog: HTMLElement) {
    const group = within(dialog).getByRole('group', { name: /agent connections/i });

    return within(group)
      .getAllByRole('button')
      .map((entry) => entry.querySelector('.agent-connection-label')?.textContent);
  }

  function backendCalls() {
    return api.execute.mock.calls.filter(([args]) => {
      const command = (args as string[])[0];
      const subcommand = (args as string[])[1];

      return command !== 'task' || subcommand !== 'changes';
    });
  }

  it('opens the Agent chapter from the gear icon and returns focus on Escape', async () => {
    render(<App />);
    const gear = await screen.findByRole('button', { name: /^settings$/i });

    fireEvent.click(gear);
    const dialog = await screen.findByRole('dialog', { name: /settings/i });

    expect(within(dialog).getByRole('button', { name: /^agent$/i })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /settings/i })).toBeNull());
    expect(document.activeElement).toBe(gear);
  });

  it('lists exactly the three agent connections', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /^settings$/i }));
    const dialog = await screen.findByRole('dialog', { name: /settings/i });

    expect(connectionLabels(dialog)).toEqual(['Codex CLI', 'Claude CLI', 'OpenCode CLI']);
  });

  it('persists the selected connection across reload without backend calls', async () => {
    const first = render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /^settings$/i }));
    const dialog = await screen.findByRole('dialog', { name: /settings/i });
    const loadCallsBefore = api.loadTasks.mock.calls.length;

    for (const name of [/^codex cli/i, /^claude cli/i, /^opencode cli/i]) {
      const option = within(dialog).getByRole('button', { name });
      fireEvent.click(option);
      expect(option.getAttribute('aria-pressed')).toBe('true');
    }
    expect(backendCalls()).toHaveLength(0);
    expect(api.loadTasks.mock.calls.length).toBe(loadCallsBefore);
    expect(localStorage.getItem('clew.v1.agent-connection')).toBe('opencode');
    first.unmount();

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /^settings$/i }));
    const reopened = await screen.findByRole('dialog', { name: /settings/i });

    expect(
      within(reopened)
        .getByRole('button', { name: /^opencode cli/i })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(connectionLabels(reopened)).toEqual(['Codex CLI', 'Claude CLI', 'OpenCode CLI']);
  });

  it('states the choice is not verified without check wording', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /^settings$/i }));
    const dialog = await screen.findByRole('dialog', { name: /settings/i });

    expect(within(dialog).getByText(/does not change how tasks run yet/i)).toBeTruthy();
    expect(
      within(dialog).queryByText(
        /\b(check|checked|checking|verify|verified|status|available|online|connected)\b/i,
      ),
    ).toBeNull();
  });

  it('renders identically when the daemon is disconnected', async () => {
    api.loadTasks.mockResolvedValue({ tasks: [], projects: [], state: 'disconnected' });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /^settings$/i }));
    const dialog = await screen.findByRole('dialog', { name: /settings/i });

    expect(connectionLabels(dialog)).toEqual(['Codex CLI', 'Claude CLI', 'OpenCode CLI']);
    expect(within(dialog).getByText(/does not change how tasks run yet/i)).toBeTruthy();
    const option = within(dialog).getByRole('button', { name: /^claude cli/i });

    fireEvent.click(option);
    expect(option.getAttribute('aria-pressed')).toBe('true');
    expect(option.hasAttribute('disabled')).toBe(false);
    expect(localStorage.getItem('clew.v1.agent-connection')).toBe('claude');
  });

  it('traps Tab focus within the settings dialog', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /^settings$/i }));
    const dialog = await screen.findByRole('dialog', { name: /settings/i });
    const focusable = within(dialog).getAllByRole('button');
    const last = focusable[focusable.length - 1];

    last.focus();
    fireEvent.keyDown(document.body, { key: 'Tab' });
    await waitFor(() => expect(document.activeElement).toBe(focusable[0]));

    focusable[0].focus();
    fireEvent.keyDown(document.body, { key: 'Tab', shiftKey: true });
    await waitFor(() => expect(document.activeElement).toBe(last));
  });

  it('contains no secret-like strings', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /^settings$/i }));
    const dialog = await screen.findByRole('dialog', { name: /settings/i });

    expect(dialog.innerHTML).not.toMatch(/token|secret|password|api[-_ ]?key|bearer|credential/i);
  });
});

describe('keyboard shortcuts (CLEW-101)', () => {
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

  function orderedTasks(
    count: number,
    stateFor: (index: number) => Task['state'] = () => 'READY',
  ): Task[] {
    const base = fixtureTasks[0];

    return Array.from({ length: count }, (_, index) => ({
      ...structuredClone(base),
      id: `CLEW-${String(index + 1).padStart(3, '0')}`,
      title: `Ordered task ${index + 1}`,
      createdAt: `2026-09-01T00:00:${String(index).padStart(2, '0')}.000Z`,
      state: stateFor(index),
      attention: null,
      finalization: null,
      runs: [],
      stages: [],
      attempts: 0,
      agentSessions: [],
    }));
  }

  function renderedIds(container: Element): string[] {
    return [...container.querySelectorAll('.task-row .task-id')].map(
      (node) => node.textContent ?? '',
    );
  }

  async function renderWithTasks(container: Element, count: number) {
    await waitFor(() => expect(container.querySelectorAll('.task-row').length).toBe(count));
  }

  it('opens the rendered task at each numbered position (AC-1)', async () => {
    api.loadTasks.mockResolvedValueOnce({
      tasks: orderedTasks(12),
      projects: structuredClone(fixtureProjects),
      state: 'fixture',
    });
    const { container } = render(<App />);

    await renderWithTasks(container, 12);
    const ids = renderedIds(container);

    expect(ids).toHaveLength(12);

    for (let position = 1; position <= 10; position += 1) {
      const key = position === 10 ? '0' : String(position);

      fireEvent.keyDown(document.body, { key, metaKey: true });
      await waitFor(() => expect(window.location.pathname).toContain(ids[position - 1]));
    }
  });

  it('derives positions from the filtered list (AC-1)', async () => {
    api.loadTasks.mockResolvedValueOnce({
      tasks: orderedTasks(6, (index) => (index % 2 === 0 ? 'EXECUTING' : 'READY')),
      projects: structuredClone(fixtureProjects),
      state: 'fixture',
    });
    const { container } = render(<App />);

    await renderWithTasks(container, 6);
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), {
      target: { value: 'active' },
    });
    await renderWithTasks(container, 3);
    const ids = renderedIds(container);

    fireEvent.keyDown(document.body, { key: '1', metaKey: true });
    await waitFor(() => expect(window.location.pathname).toContain(ids[0]));
  });

  it('treats positions past the visible list as a no-op (AC-2)', async () => {
    api.loadTasks.mockResolvedValueOnce({
      tasks: orderedTasks(3),
      projects: structuredClone(fixtureProjects),
      state: 'fixture',
    });
    const { container } = render(<App />);

    await renderWithTasks(container, 3);
    const before = window.location.pathname;

    fireEvent.keyDown(document.body, { key: '7', metaKey: true });
    expect(window.location.pathname).toBe(before);
  });

  it('does nothing when the visible list is empty (AC-2)', async () => {
    api.loadTasks.mockResolvedValueOnce({
      tasks: [],
      projects: structuredClone(fixtureProjects),
      state: 'fixture',
    });
    render(<App />);
    await screen.findByText('No tasks yet');
    const before = window.location.pathname;

    fireEvent.keyDown(document.body, { key: '1', metaKey: true });
    expect(window.location.pathname).toBe(before);
  });

  it('ignores numbered navigation in inputs, editors, modals, and the terminal (AC-3)', async () => {
    api.loadTasks.mockResolvedValueOnce({
      tasks: orderedTasks(5),
      projects: structuredClone(fixtureProjects),
      state: 'fixture',
    });
    const { container } = render(<App />);

    await renderWithTasks(container, 5);
    const before = window.location.pathname;
    const created: Element[] = [];
    const attach = (element: Element) => {
      created.push(element);
      document.body.appendChild(element);

      return element;
    };

    try {
      const input = attach(document.createElement('input')) as HTMLInputElement;

      input.focus();
      fireEvent.keyDown(input, { key: '2', metaKey: true });

      const textarea = attach(document.createElement('textarea')) as HTMLTextAreaElement;

      textarea.focus();
      fireEvent.keyDown(textarea, { key: '2', metaKey: true });

      const editable = attach(document.createElement('div')) as HTMLDivElement;

      editable.setAttribute('contenteditable', 'true');
      editable.focus();
      fireEvent.keyDown(editable, { key: '2', metaKey: true });

      const xterm = attach(document.createElement('div')) as HTMLDivElement;

      xterm.className = 'xterm';
      const helper = document.createElement('textarea');

      xterm.appendChild(helper);
      helper.focus();
      fireEvent.keyDown(helper, { key: '2', metaKey: true });

      expect(window.location.pathname).toBe(before);

      fireEvent.click(screen.getByRole('button', { name: /^settings$/i }));
      await screen.findByRole('dialog', { name: /settings/i });
      fireEvent.keyDown(document.body, { key: '2', metaKey: true });
      expect(window.location.pathname).toBe(before);
    } finally {
      for (const element of created) element.remove();
    }
  });

  it('does not dispatch during IME composition or key repeat (AC-3)', async () => {
    api.loadTasks.mockResolvedValueOnce({
      tasks: orderedTasks(4),
      projects: structuredClone(fixtureProjects),
      state: 'fixture',
    });
    const { container } = render(<App />);

    await renderWithTasks(container, 4);
    const before = window.location.pathname;

    fireEvent.keyDown(document.body, { key: '2', metaKey: true, repeat: true });
    fireEvent.keyDown(document.body, { key: '2', metaKey: true, isComposing: true });
    expect(window.location.pathname).toBe(before);
  });

  it('keeps command-palette open, close, and selection behavior (AC-4)', async () => {
    const { container } = render(<App />);

    await renderWithTasks(container, fixtureTasks.length);
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    const dialog = await screen.findByRole('dialog', { name: /command palette/i });

    expect((dialog.querySelector('.palette-input') as HTMLInputElement).value).toBe('');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /command palette/i })).toBeNull(),
    );

    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    const reopened = await screen.findByRole('dialog', { name: /command palette/i });
    const input = within(reopened).getByRole('textbox');

    fireEvent.input(input, { target: { value: 'clew-071' } });
    fireEvent.keyDown(document.body, { key: 'Enter' });
    await waitFor(() => expect(window.location.pathname).toContain('CLEW-071'));
  });

  it('supports the Option fallback alongside the Command chord (AC-5)', async () => {
    api.loadTasks.mockResolvedValueOnce({
      tasks: orderedTasks(3),
      projects: structuredClone(fixtureProjects),
      state: 'fixture',
    });
    const { container } = render(<App />);

    await renderWithTasks(container, 3);
    const ids = renderedIds(container);

    fireEvent.keyDown(document.body, { key: '2', altKey: true });
    await waitFor(() => expect(window.location.pathname).toContain(ids[1]));

    fireEvent.keyDown(document.body, { key: '1', metaKey: true });
    await waitFor(() => expect(window.location.pathname).toContain(ids[0]));
  });

  it('prefers an enabled action when chords collide', () => {
    const event = new KeyboardEvent('keydown', { key: 'x', metaKey: true });
    const resolution = resolveShortcut(
      event,
      [
        {
          id: 'disabled.action',
          label: 'Disabled action',
          chord: '⌘X',
          combos: [{ key: 'x', primary: true }],
          scopes: ['global'],
          enabled: () => false,
          run: () => {},
        },
        {
          id: 'enabled.action',
          label: 'Enabled action',
          chord: '⌘X',
          combos: [{ key: 'x', primary: true }],
          scopes: ['global'],
          run: () => {},
        },
      ],
      'global',
    );

    expect(resolution.shortcut?.id).toBe('enabled.action');
  });

  it('dispatches one handler per keystroke across rerenders and unmount (AC-6)', async () => {
    const calls: number[] = [];

    function Harness() {
      const [count, setCount] = useState(0);

      useShortcuts(
        [
          {
            id: 'test.run',
            label: 'Test run',
            chord: '⌘J',
            combos: [{ key: 'j', primary: true }],
            scopes: ['global'],
            run: () => {
              calls.push(count);
              setCount((value) => value + 1);
            },
          },
        ],
        () => 'global',
      );

      return <div>{count}</div>;
    }

    const view = render(<Harness />);

    fireEvent.keyDown(document.body, { key: 'j', metaKey: true });
    expect(calls).toHaveLength(1);

    view.rerender(<Harness />);
    fireEvent.keyDown(document.body, { key: 'j', metaKey: true });
    expect(calls).toHaveLength(2);

    view.unmount();
    fireEvent.keyDown(document.body, { key: 'j', metaKey: true });
    expect(calls).toHaveLength(2);
  });

  it('exposes registry metadata for key hints and help (AC-6)', async () => {
    render(<App />);
    await waitFor(() => expect(listShortcuts().length).toBeGreaterThanOrEqual(11));

    const byId = new Map(listShortcuts().map((entry) => [entry.id, entry]));

    expect(byId.get('task.open.1')?.chord).toBe(`${primaryModifierLabel()}1`);
    expect(byId.get('task.open.10')?.chord).toBe(`${primaryModifierLabel()}0`);
    expect(byId.get('task.open.10')?.fallbackChords).toEqual([`${optionModifierLabel()}0`]);
    expect(byId.get('palette.open')?.scopes).toContain('input');
  });
});

describe('task shortcuts (CLEW-102)', () => {
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

  function runningWorkerRun() {
    return {
      id: 'run-1',
      stageId: 'worker',
      attempt: 1,
      status: 'RUNNING',
      harness: 'codex',
      sessionId: 'sess-1',
      workspace: '/tmp/clew-workspace',
      commitSha: null,
      startedAt: '2026-08-28T09:43:00.000Z',
      finishedAt: null,
      terminalAvailable: true,
      terminalAccess: 'controller_local' as const,
    };
  }

  function loadSingleTask(overrides: Partial<Task>) {
    const task = { ...structuredClone(fixtureTasks[0]), ...overrides };

    api.loadTasks.mockResolvedValueOnce({
      tasks: [task],
      projects: structuredClone(fixtureProjects),
      state: 'fixture',
    });

    return task;
  }

  function commands() {
    return api.execute.mock.calls.map(([args]) => args as string[]);
  }

  it('continues a ready task with Cmd+Enter and never finishes the worker (AC-1, AC-2)', async () => {
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Replace auth middleware' });

    fireEvent.keyDown(document.body, { key: 'Enter', metaKey: true });
    await confirmAction();

    await waitFor(() =>
      expect(api.execute).toHaveBeenCalledWith([
        'continue',
        'CLEW-071',
        '--message',
        'Restart the worker and re-check the task',
      ]),
    );
    expect(commands().some((args) => args[0] === 'finish-worker')).toBe(false);
    expect(commands().some((args) => args[0] === 'complete')).toBe(false);
    expect(
      commands().some(
        (args) =>
          args[0] === 'task' && ['integrate', 'mark-merged', 'mark-released'].includes(args[1]),
      ),
    ).toBe(false);
  });

  it('focuses the waiting embedded terminal with Cmd+Enter (AC-1, AC-4)', async () => {
    loadSingleTask({
      state: 'EXECUTING',
      attention: null,
      runId: 'run-1',
      runStatus: 'RUNNING',
      terminalActive: true,
      terminalAvailable: true,
      terminalAccess: 'controller_local',
      interactionStatus: 'waiting_for_operator',
      roles: ['worker'],
      stages: [{ id: 'worker', status: 'RUNNING', kind: 'worker' }],
      runs: [runningWorkerRun()],
    });
    render(<App />);
    await screen.findByRole('button', { name: /focus terminal/i });

    expect(screen.queryByLabelText('Live Codex terminal')).toBeNull();
    fireEvent.keyDown(document.body, { key: 'Enter', metaKey: true });
    expect(await screen.findByLabelText('Live Codex terminal')).toBeTruthy();
    expect(commands().some((args) => args[0] === 'finish-worker')).toBe(false);
  });

  it('explains when Cmd+Enter has no safe action while the worker runs (AC-1)', async () => {
    loadSingleTask({
      state: 'EXECUTING',
      attention: null,
      runId: 'run-1',
      runStatus: 'RUNNING',
      terminalActive: true,
      terminalAvailable: true,
      terminalAccess: 'controller_local',
      interactionStatus: null,
      roles: ['worker'],
      stages: [{ id: 'worker', status: 'RUNNING', kind: 'worker' }],
      runs: [runningWorkerRun()],
    });
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Replace auth middleware' });

    fireEvent.keyDown(document.body, { key: 'Enter', metaKey: true });
    expect(await screen.findByText('The worker is running without waiting for input')).toBeTruthy();
    expect(commands().some((args) => args[0] === 'continue')).toBe(false);
  });

  it('inspects the selected change run with Cmd+E and Cmd+Shift+E (AC-3)', async () => {
    api.execute.mockImplementation(async (args: string[]) => {
      if (args[0] === 'task' && args[1] === 'changes') return availableChanges(args[2]);
      if (args[0] === 'task' && args[1] === 'open-changes') return { state: 'opened' };

      return { fixture: true };
    });
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Replace auth middleware' });
    await waitFor(() => expect(api.execute).toHaveBeenCalledWith(['task', 'changes', 'run-2']));

    fireEvent.keyDown(document.body, { key: 'e', metaKey: true });
    const dialog = await screen.findByRole('dialog', { name: /changes for worker/i });

    expect(dialog).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: /close diff/i }));

    fireEvent.keyDown(document.body, { key: 'e', metaKey: true, shiftKey: true });
    await waitFor(() =>
      expect(api.execute).toHaveBeenCalledWith([
        'task',
        'open-changes',
        'CLEW-071',
        '--run',
        'run-2',
      ]),
    );
  });

  it('opens the active session externally with Cmd+Shift+` (AC-4)', async () => {
    loadSingleTask({
      state: 'EXECUTING',
      attention: null,
      runId: 'run-1',
      runStatus: 'RUNNING',
      terminalActive: true,
      terminalAvailable: true,
      terminalAccess: 'controller_local',
      interactionStatus: 'waiting_for_operator',
      roles: ['worker'],
      stages: [{ id: 'worker', status: 'RUNNING', kind: 'worker' }],
      runs: [runningWorkerRun()],
    });
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Replace auth middleware' });

    fireEvent.keyDown(document.body, { key: "'", metaKey: true, shiftKey: true });
    await waitFor(() =>
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
      ]),
    );
  });

  it('uses deliverable terminal chords and accepts the Ctrl variant', async () => {
    loadSingleTask({
      state: 'EXECUTING',
      attention: null,
      runId: 'run-1',
      runStatus: 'RUNNING',
      terminalActive: true,
      terminalAvailable: true,
      terminalAccess: 'controller_local',
      interactionStatus: 'waiting_for_operator',
      roles: ['worker'],
      stages: [{ id: 'worker', status: 'RUNNING', kind: 'worker' }],
      runs: [runningWorkerRun()],
    });
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Replace auth middleware' });

    const byId = new Map(listShortcuts().map((entry) => [entry.id, entry]));

    expect(byId.get('task.terminal.focus')?.chord).toBe(`${primaryModifierLabel()}'`);
    expect(byId.get('task.terminal.external')?.chord).toBe(`${primaryModifierLabel()}⇧'`);

    expect(screen.queryByLabelText('Live Codex terminal')).toBeNull();
    fireEvent.keyDown(document.body, { key: "'", ctrlKey: true });
    expect(await screen.findByLabelText('Live Codex terminal')).toBeTruthy();
  });

  it('allows Cmd, Shift, and the key to be pressed in sequence (AC-1)', async () => {
    loadSingleTask({
      state: 'EXECUTING',
      attention: null,
      runId: 'run-1',
      runStatus: 'RUNNING',
      terminalActive: true,
      terminalAvailable: true,
      terminalAccess: 'controller_local',
      interactionStatus: 'waiting_for_operator',
      roles: ['worker'],
      stages: [{ id: 'worker', status: 'RUNNING', kind: 'worker' }],
      runs: [runningWorkerRun()],
    });
    const { container } = render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Replace auth middleware' });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      fireEvent.keyDown(document.body, { key: 'Meta', metaKey: true });
      try {
        await waitFor(
          () => expect(container.querySelectorAll('.key-hint').length).toBeGreaterThan(0),
          { timeout: 400 },
        );
        break;
      } catch {
        fireEvent.keyUp(document.body, { key: 'Meta' });
      }
      if (attempt === 4) throw new Error('key hints did not appear');
    }

    fireEvent.keyDown(document.body, { key: 'Shift', metaKey: true, shiftKey: true });
    expect(container.querySelectorAll('.key-hint').length).toBeGreaterThan(0);

    fireEvent.keyDown(document.body, { key: "'", metaKey: true, shiftKey: true });
    await waitFor(() =>
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
      ]),
    );
    expect(container.querySelectorAll('.key-hint')).toHaveLength(0);
  });

  it('uses a chooser for multiple terminals and remembers the choice (AC-4)', async () => {
    const base = structuredClone(fixtureTasks[0]);
    const backend = {
      ...structuredClone(base.runs[1]),
      id: 'run-backend',
      stageId: 'backend',
      status: 'RUNNING',
      sessionId: 'sess-backend',
      terminalAvailable: true,
      terminalAccess: 'controller_local' as const,
    };
    const frontend = {
      ...structuredClone(base.runs[1]),
      id: 'run-frontend',
      stageId: 'frontend',
      status: 'RUNNING',
      sessionId: 'sess-frontend',
      terminalAvailable: true,
      terminalAccess: 'controller_local' as const,
    };

    loadSingleTask({
      state: 'EXECUTING',
      attention: null,
      runId: 'run-backend',
      runStatus: 'RUNNING',
      terminalActive: true,
      terminalAvailable: true,
      terminalAccess: 'controller_local',
      interactionStatus: 'waiting_for_operator',
      roles: ['worker'],
      stages: [
        { id: 'backend', status: 'RUNNING', kind: 'worker' },
        { id: 'frontend', status: 'RUNNING', kind: 'worker' },
      ],
      runs: [backend, frontend],
    });
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Replace auth middleware' });

    fireEvent.keyDown(document.body, { key: "'", metaKey: true });
    const chooser = await screen.findByRole('dialog', { name: /choose terminal/i });

    fireEvent.click(within(chooser).getByRole('button', { name: /frontend/i }));
    expect(await screen.findByLabelText('Live Codex terminal')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /collapse worker · frontend terminal/i }));
    await waitFor(() => expect(screen.queryByLabelText('Live Codex terminal')).toBeNull());

    fireEvent.keyDown(document.body, { key: "'", metaKey: true });
    expect(screen.queryByRole('dialog', { name: /choose terminal/i })).toBeNull();
    expect(await screen.findByLabelText('Live Codex terminal')).toBeTruthy();
  });

  it('keeps change and terminal shortcuts inert while the control plane is disconnected', async () => {
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
    await screen.findByRole('heading', { level: 1, name: 'Replace auth middleware' });

    reportState?.('disconnected');
    await screen.findByRole('alert');

    await waitFor(() => {
      const changes = listShortcuts().find((entry) => entry.id === 'task.changes.internal');

      expect(changes?.enabled).toBe(false);
      expect(changes?.disabledReason).toBe(
        'Actions are disabled while the control plane is disconnected',
      );
    });

    const sessionOpens = () =>
      commands().filter(
        (args) => args[0] === 'session' && args[1] === 'open' && args[2] === 'CLEW-071',
      ).length;
    const externalChanges = () =>
      commands().filter(
        (args) => args[0] === 'task' && args[1] === 'open-changes' && args[3] === 'CLEW-071',
      ).length;
    const opensBefore = sessionOpens();
    const externalBefore = externalChanges();

    fireEvent.keyDown(document.body, { key: 'e', metaKey: true });
    fireEvent.keyDown(document.body, { key: "'", metaKey: true });
    fireEvent.keyDown(document.body, { key: "'", metaKey: true, shiftKey: true });

    expect(screen.queryByRole('dialog', { name: /changes for worker/i })).toBeNull();
    expect(screen.queryByLabelText('Live Codex terminal')).toBeNull();
    expect(sessionOpens()).toBe(opensBefore);
    expect(externalChanges()).toBe(externalBefore);
  });

  it('supports Escape and starts on the chooser close control', async () => {
    const base = structuredClone(fixtureTasks[0]);
    const backend = {
      ...structuredClone(base.runs[1]),
      id: 'run-backend',
      stageId: 'backend',
      status: 'RUNNING',
      sessionId: 'sess-backend',
      terminalAvailable: true,
      terminalAccess: 'controller_local' as const,
    };
    const frontend = {
      ...structuredClone(base.runs[1]),
      id: 'run-frontend',
      stageId: 'frontend',
      status: 'RUNNING',
      sessionId: 'sess-frontend',
      terminalAvailable: true,
      terminalAccess: 'controller_local' as const,
    };

    loadSingleTask({
      state: 'EXECUTING',
      attention: null,
      runId: 'run-backend',
      runStatus: 'RUNNING',
      terminalActive: true,
      terminalAvailable: true,
      terminalAccess: 'controller_local',
      interactionStatus: 'waiting_for_operator',
      roles: ['worker'],
      stages: [
        { id: 'backend', status: 'RUNNING', kind: 'worker' },
        { id: 'frontend', status: 'RUNNING', kind: 'worker' },
      ],
      runs: [backend, frontend],
    });
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Replace auth middleware' });

    fireEvent.keyDown(document.body, { key: "'", metaKey: true });
    const chooser = await screen.findByRole('dialog', { name: /choose terminal/i });
    const closeButton = within(chooser).getByRole('button', { name: /close terminal chooser/i });

    await waitFor(() => expect(document.activeElement).toBe(closeButton));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /choose terminal/i })).toBeNull(),
    );
  });

  it('keeps task shortcuts out of input, palette, and modal scope (AC-6)', async () => {
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Replace auth middleware' });

    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    const palette = await screen.findByRole('dialog', { name: /command palette/i });
    const input = within(palette).getByRole('textbox');

    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    expect(commands().some((args) => args[0] === 'continue')).toBe(false);

    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /command palette/i })).toBeNull(),
    );

    fireEvent.click(screen.getByRole('button', { name: /^settings$/i }));
    await screen.findByRole('dialog', { name: /settings/i });
    fireEvent.keyDown(document.body, { key: 'e', metaKey: true });
    expect(screen.queryByRole('dialog', { name: /changes for worker/i })).toBeNull();
  });
});

describe('command key hints (CLEW-103)', () => {
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

  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  function hintNodes(container: Element) {
    return [...container.querySelectorAll('.key-hint')];
  }

  async function holdCommand(container: Element) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      fireEvent.keyDown(document.body, { key: 'Meta', metaKey: true });
      try {
        await waitFor(() => expect(hintNodes(container).length).toBeGreaterThan(0), {
          timeout: 400,
        });
        return;
      } catch {
        fireEvent.keyUp(document.body, { key: 'Meta' });
      }
    }
    throw new Error('key hints did not appear');
  }

  it('reveals hints after a deliberate hold and not on a fast chord (AC-1)', async () => {
    const { container } = render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Replace auth middleware' });

    fireEvent.keyDown(document.body, { key: 'Meta', metaKey: true });
    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    await delay(240);
    expect(hintNodes(container)).toHaveLength(0);

    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /command palette/i })).toBeNull(),
    );

    await holdCommand(container);
    expect(hintNodes(container).length).toBeGreaterThan(0);
  });

  it('numbers sidebar rows in rendered order up to the visible list (AC-2)', async () => {
    const { container } = render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Replace auth middleware' });

    await holdCommand(container);
    const numbers = [...container.querySelectorAll('.task-row .key-hint')].map(
      (node) => node.textContent,
    );
    const modifier = primaryModifierLabel();

    expect(numbers).toEqual(['1', '2', '3', '4', '5'].map((digit) => `${modifier}${digit}`));
  });

  it('matches sidebar numbers after a status filter (AC-2)', async () => {
    const { container } = render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Replace auth middleware' });

    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), {
      target: { value: 'active' },
    });
    await holdCommand(container);
    const rows = [...container.querySelectorAll('.task-row')];
    const numbers = rows.map((row) => row.querySelector('.key-hint')?.textContent);

    expect(numbers).toEqual([`${primaryModifierLabel()}1`]);
  });

  it('only shows badges backed by a registered action (AC-3)', async () => {
    const { container } = render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Replace auth middleware' });

    await holdCommand(container);
    const known = new Set(listShortcuts().map((entry) => entry.chord));

    for (const node of hintNodes(container)) expect(known.has(node.textContent ?? '')).toBe(true);

    const first = listShortcuts().find((entry) => entry.id === 'task.open.1');

    expect(first?.chord).toBe(`${primaryModifierLabel()}1`);
    expect(first?.enabled).toBe(true);
  });

  it('keeps hint badges decorative and anchored to a control (AC-4)', async () => {
    const { container } = render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Replace auth middleware' });

    await holdCommand(container);
    const badge = hintNodes(container)[0];

    expect(badge.getAttribute('aria-hidden')).toBe('true');
    expect(badge.closest('.key-hint-anchor, .task-row')).toBeTruthy();
  });

  it('clears hints on keyup, Escape, blur, and a hidden tab (AC-5)', async () => {
    const { container } = render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Replace auth middleware' });

    await holdCommand(container);
    fireEvent.keyUp(document.body, { key: 'Meta' });
    await waitFor(() => expect(hintNodes(container)).toHaveLength(0));

    await holdCommand(container);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(hintNodes(container)).toHaveLength(0));

    await holdCommand(container);
    fireEvent(window, new Event('blur'));
    await waitFor(() => expect(hintNodes(container)).toHaveLength(0));

    await holdCommand(container);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      fireEvent(document, new Event('visibilitychange'));
      await waitFor(() => expect(hintNodes(container)).toHaveLength(0));
    } finally {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
    }
  });

  it('clears hints on navigation and modal transitions (AC-5)', async () => {
    const { container } = render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Replace auth middleware' });

    await holdCommand(container);
    fireEvent.click(screen.getByRole('button', { name: /parallel cache migration/i }));
    await waitFor(() => expect(hintNodes(container)).toHaveLength(0));

    await holdCommand(container);
    fireEvent.click(screen.getByRole('button', { name: /^settings$/i }));
    await waitFor(() => expect(hintNodes(container)).toHaveLength(0));
  });

  it('opens the keyboard help from the command palette (AC-6)', async () => {
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Replace auth middleware' });

    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    const palette = await screen.findByRole('dialog', { name: /command palette/i });

    fireEvent.click(within(palette).getByRole('button', { name: /keyboard shortcuts/i }));
    const help = await screen.findByRole('dialog', { name: /keyboard shortcuts/i });
    const closeButton = within(help).getByRole('button', { name: /close keyboard shortcuts/i });

    expect(within(help).getByText(`${primaryModifierLabel()}K`)).toBeTruthy();
    expect(within(help).getByText(`${optionModifierLabel()}1`)).toBeTruthy();
    expect(within(help).getByText(/continue task/i)).toBeTruthy();
    expect(within(help).getByText(/focus terminal/i)).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(closeButton));

    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /keyboard shortcuts/i })).toBeNull(),
    );
  });

  it('marks task actions as unavailable in overview help when no task is active', async () => {
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: 'Replace auth middleware' });

    fireEvent.click(screen.getByRole('button', { name: /^overview$/i }));
    await waitFor(() => expect(window.location.pathname).toContain('/overview'));

    fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
    const palette = await screen.findByRole('dialog', { name: /command palette/i });

    fireEvent.click(within(palette).getByRole('button', { name: /keyboard shortcuts/i }));
    const help = await screen.findByRole('dialog', { name: /keyboard shortcuts/i });

    expect(within(help).getAllByText('Open a task to use this action.')).toHaveLength(5);
  });
});
