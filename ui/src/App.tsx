import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleHelp,
  GitBranch,
  Inbox,
  RefreshCw,
  Send,
  ShieldCheck,
  SquareTerminal,
  WifiOff,
  X,
} from 'lucide-preact';
import { execute, loadTasks, subscribeToEvents, type ConnectionState } from './api';
import type { Task, TaskState, ThreadItem } from './types';
import { TerminalPane } from './TerminalPane';

const stateLabel: Record<TaskState, string> = {
  DRAFT: 'Draft',
  PLAN_READY: 'Plan ready',
  QUEUED: 'Queued',
  RECOVERING: 'Recovering',
  EXECUTING: 'Executing',
  VERIFYING: 'Verifying',
  REVIEWING: 'In review',
  WAITING_FOR_HUMAN: 'Needs you',
  READY: 'Ready',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  BLOCKED: 'Blocked',
};
const kindLabel: Record<string, string> = {
  task_created: 'Task created',
  run_started: 'Run started',
  review_findings: 'Review finding',
  retry_scheduled: 'Retry scheduled',
  review_recorded: 'Review',
  task_ready: 'Ready',
  plan_approval_required: 'Approval required',
  next_step_proposed: 'Next step',
  step_approved: 'Step approved',
  codex_session_started: 'Codex session',
  codex_turn_started: 'Codex turn',
  worker_tool_started: 'Tool started',
  worker_tool_completed: 'Tool completed',
  worker_waiting: 'Worker response',
  worker_turn_failed: 'Worker turn failed',
  worker_turn_interrupted: 'Worker turn interrupted',
  worker_output: 'Worker output',
};

function Status({ state }: { state: TaskState }) {
  return (
    <span className={`status status-${state.toLowerCase()}`}>
      <span className="status-dot" />
      {stateLabel[state]}
    </span>
  );
}
function Connection({ state }: { state: ConnectionState }) {
  const labels = {
    fixture: 'Fixture mode',
    connected: 'Connected',
    disconnected: 'Disconnected',
    reconnecting: 'Reconnecting',
    incompatible: 'Incompatible daemon',
  };
  return (
    <span className={`connection connection-${state}`}>
      <span className="connection-dot" />
      {labels[state]}
    </span>
  );
}
function formatTime(value: string) {
  return new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit' }).format(
    new Date(value),
  );
}
function iconFor(kind: string) {
  if (kind.includes('review')) return <ShieldCheck size={16} />;
  if (kind.includes('run')) return <SquareTerminal size={16} />;
  if (kind.includes('retry')) return <RefreshCw size={16} />;
  if (kind.includes('approval')) return <AlertTriangle size={16} />;
  if (kind.includes('ready')) return <Check size={16} />;
  return <Activity size={16} />;
}

function taskIdFromLocation() {
  const match = window.location.pathname.match(/^\/tasks\/([^/]+)\/?$/);

  return match ? decodeURIComponent(match[1]) : null;
}

function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState(
    () => taskIdFromLocation() ?? sessionStorage.getItem('clew-selected-task') ?? 'CLEW-071',
  );
  const [connection, setConnection] = useState<ConnectionState>('reconnecting');
  const [diagnostic, setDiagnostic] = useState(false);
  const [message, setMessage] = useState('');
  const [notice, setNotice] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [runRequested, setRunRequested] = useState(false);
  const autoOpenedTerminal = useRef<string | null>(null);
  const lastCursor = useRef(Number(sessionStorage.getItem('clew-event-cursor') ?? 0));
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const refreshTimer = useRef<number | undefined>(undefined);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const selectTask = useCallback((taskId: string) => {
    setSelected(taskId);
    sessionStorage.setItem('clew-selected-task', taskId);
    if (window.location.pathname !== `/tasks/${encodeURIComponent(taskId)}`)
      window.history.pushState({}, '', `/tasks/${encodeURIComponent(taskId)}`);
  }, []);
  useEffect(() => {
    const onPopState = () => {
      const taskId = taskIdFromLocation();

      if (taskId) {
        setSelected(taskId);
        sessionStorage.setItem('clew-selected-task', taskId);
      }
    };

    window.addEventListener('popstate', onPopState);

    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  const refresh = useCallback(() => {
    if (refreshInFlight.current) return refreshInFlight.current;
    const operation = loadTasks().then(({ tasks: next, state }) => {
      setConnection(state);
      if (state === 'connected' || state === 'fixture') {
        setTasks(next);
        setLastUpdatedAt(new Date());
        if (next[0] && !next.some((task) => task.id === selectedRef.current)) {
          selectTask(next[0].id);
        }
      }
    });

    refreshInFlight.current = operation.finally(() => {
      refreshInFlight.current = null;
    });

    return refreshInFlight.current;
  }, [selectTask]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const scheduleRefresh = () => {
      if (refreshTimer.current !== undefined) return;
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = undefined;
        void refresh();
      }, 100);
    };
    const unsubscribe = subscribeToEvents(
      lastCursor.current,
      (event) => {
        lastCursor.current = event.cursor;
        scheduleRefresh();
      },
      (state) => {
        setConnection(state);
        if (state === 'connected') scheduleRefresh();
      },
    );

    return () => {
      if (refreshTimer.current !== undefined) window.clearTimeout(refreshTimer.current);
      unsubscribe();
    };
  }, [refresh]);
  const task = useMemo(
    () => tasks.find((entry) => entry.id === selected) ?? tasks[0],
    [selected, tasks],
  );
  useEffect(() => {
    if (task?.terminalActive && task.runId && autoOpenedTerminal.current !== task.runId) {
      autoOpenedTerminal.current = task.runId;
      setTerminalVisible(true);
    }
  }, [task?.runId, task?.terminalActive]);
  useEffect(() => {
    const waitingForTerminal =
      runRequested || (task?.state === 'EXECUTING' && task.runStatus === 'RUNNING');

    if (!waitingForTerminal) return undefined;
    if (task?.terminalActive) {
      setRunRequested(false);

      return undefined;
    }
    const timer = window.setInterval(() => void refresh(), 500);

    return () => window.clearInterval(timer);
  }, [refresh, runRequested, task?.state, task?.runStatus, task?.terminalActive]);
  const createTask = async (title: string, description: string) => {
    if (!canMutateFor(connection)) {
      setNotice('Actions are disabled while the control plane is disconnected');
      return;
    }
    try {
      const result = await execute([
        'task',
        'create',
        '--title',
        title,
        '--description',
        description,
      ]);
      if ((result as { fixture?: boolean } | null)?.fixture) {
        const id = `LOCAL-${Date.now()}`;
        setTasks((current) => [
          {
            id,
            title,
            goal: description,
            profile: 'quick',
            state: 'DRAFT',
            attention: null,
            revision: null,
            attempts: 0,
            stages: [],
            reviewed: false,
            findings: 0,
            thread: {
              version: 1,
              items: [],
              nextCursor: null,
              hasMore: false,
              redaction: 'public-safe',
            },
            events: [],
          },
          ...current,
        ]);
        selectTask(id);
      } else {
        await refresh();
        const createdId = (result as { id?: string }).id;

        if (createdId) selectTask(createdId);
      }
      setCreateOpen(false);
      setNotice(`Task created: ${title}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Task creation failed');
    }
  };
  if (!task) {
    const unavailable = connection === 'disconnected' || connection === 'incompatible';
    return (
      <div className="app">
        <header className="topbar">
          <Logo />
          <Connection state={connection} />
        </header>
        <main className="empty">
          {unavailable ? <WifiOff size={28} /> : <Inbox size={28} />}
          <h1>{unavailable ? 'Control plane unavailable' : 'No tasks yet'}</h1>
          <p>
            {connection === 'incompatible'
              ? 'This UI cannot safely read the daemon response. Update Clew and reload.'
              : connection === 'disconnected'
                ? 'Start the local daemon, then retry the connection.'
                : 'Create a task with the Clew CLI, then refresh this view.'}
          </p>
          <div className="empty-actions">
            <button className="button primary" onClick={() => setCreateOpen(true)}>
              <Check size={15} /> Create task
            </button>
            <button className="button secondary" onClick={() => void refresh()}>
              <RefreshCw size={15} /> Retry
            </button>
          </div>
        </main>
        {createOpen && <CreateTask onClose={() => setCreateOpen(false)} onCreate={createTask} />}
      </div>
    );
  }
  const canMutate = connection === 'connected' || connection === 'fixture';
  const act = async (args: string[], success: string) => {
    if (!canMutate) {
      setNotice('Actions are disabled while the control plane is disconnected');

      return;
    }
    if (args[0] === 'run') setRunRequested(true);
    try {
      const result = await execute(args);
      if ((result as { fixture?: boolean } | null)?.fixture) {
        if (args[0] === 'run') setRunRequested(false);
        setTasks((current) =>
          current.map((entry) => {
            if (entry.id !== task.id) return entry;
            if (args[0] === 'complete') return { ...entry, state: 'COMPLETED' };
            if (args[0] === 'approve') return { ...entry, state: 'PLAN_READY', attention: null };
            if (args[0] === 'run') return { ...entry, state: 'EXECUTING' };
            if (args[0] === 'finish-worker') return { ...entry, state: 'VERIFYING' };
            if (args[0] === 'retry') return { ...entry, state: 'RECOVERING' };
            if (args[0] === 'continue') return { ...entry, state: 'RECOVERING', attention: null };
            if (args[0] === 'task' && args[1] === 'message') {
              const item: ThreadItem = {
                version: 1,
                id: `fixture-message-${Date.now()}`,
                cursor: (entry.thread.items.at(-1)?.cursor ?? 0) + 1,
                kind: 'operator_message',
                at: new Date().toISOString(),
                source: { kind: 'operator', id: 'local-user' },
                summary: message.trim(),
              };
              return {
                ...entry,
                thread: { ...entry.thread, items: [...entry.thread.items, item] },
              };
            }
            return entry;
          }),
        );
      } else {
        await refresh();
      }
      if (args[0] === 'continue' || (args[0] === 'task' && args[1] === 'message')) setMessage('');
      setNotice(success);
    } catch (error) {
      if (args[0] === 'run') setRunRequested(false);
      setNotice(error instanceof Error ? error.message : 'Action failed');
    }
  };
  const canStart = ['DRAFT', 'PLAN_READY', 'QUEUED'].includes(task.state);
  const canContinue =
    task.state === 'READY' ||
    (task.state === 'WAITING_FOR_HUMAN' && task.attention !== 'PLAN_APPROVAL_REQUIRED');
  const interactiveWorker =
    task.runStatus === 'RUNNING' && task.terminalActive === true && Boolean(task.runId);
  return (
    <div className="app">
      <header className="topbar">
        <Logo />
        <div className="topbar-right">
          <Connection state={connection} />
          <button className="icon-button" aria-label="Refresh tasks" onClick={() => void refresh()}>
            <RefreshCw size={16} />
          </button>
          <span className="avatar">LC</span>
        </div>
      </header>
      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-heading">
            <span>Tasks</span>
            <button className="text-button" onClick={() => setCreateOpen(true)}>
              + New
            </button>
            <span className="count">{tasks.length}</span>
          </div>
          <div className="task-list">
            {tasks.map((entry) => (
              <button
                className={`task-row ${entry.id === task.id ? 'selected' : ''}${entry.interactionStatus === 'waiting_for_operator' ? ' task-row-waiting' : ''}`}
                key={entry.id}
                onClick={() => {
                  selectTask(entry.id);
                }}
              >
                <div className="task-row-top">
                  <span className="task-id">{entry.id}</span>
                  <Status state={entry.state} />
                </div>
                <strong>{entry.title}</strong>
                {entry.interactionStatus === 'waiting_for_operator' && (
                  <span className="task-interaction-status">
                    <SquareTerminal size={12} /> Waiting for operator
                  </span>
                )}
                {entry.attention && (
                  <span className="attention">
                    <AlertTriangle size={13} />
                    {entry.attention.replaceAll('_', ' ')}
                  </span>
                )}
                <span className="task-meta">
                  {entry.profile} · {entry.attempts ? `${entry.attempts} attempts` : 'not started'}
                </span>
              </button>
            ))}
          </div>
          <div className="sidebar-footer">
            <div className="legend">
              <span className="legend-mark" /> Local control plane
            </div>
            <span className="version">v0.4 · protocol 1</span>
          </div>
        </aside>
        <main className="content">
          <div className="content-inner">
            <section className="hero">
              <div>
                <div className="eyebrow">
                  Task overview <span>/</span> {task.id}
                </div>
                <h1>{task.title}</h1>
                <p>{task.goal}</p>
              </div>
              <div className="hero-actions">
                <button
                  className="button secondary"
                  disabled={
                    !canMutate ||
                    (!interactiveWorker && !canStart && !canContinue) ||
                    (!interactiveWorker && canContinue && !message.trim())
                  }
                  title={
                    canContinue && !message.trim()
                      ? 'Add an operator message before continuing'
                      : undefined
                  }
                  onClick={() => {
                    if (interactiveWorker)
                      return void act(
                        ['finish-worker', task.id, '--run', task.runId!],
                        'Worker is finishing',
                      );
                    if (canContinue)
                      return void act(
                        ['continue', task.id, '--message', message],
                        'Continuation requested',
                      );
                    return void act(['run', task.id], 'Task started');
                  }}
                >
                  {interactiveWorker ? <Check size={15} /> : <RefreshCw size={15} />}
                  {interactiveWorker ? 'Finish worker' : canContinue ? 'Continue' : 'Run task'}
                </button>
                <button
                  className="button primary"
                  disabled={!canMutate || task.state !== 'READY' || !task.revision}
                  title={!task.revision ? 'A verified result revision is required' : undefined}
                  onClick={() =>
                    act(['complete', task.id, '--revision', task.revision!], 'Task completed')
                  }
                >
                  <Check size={15} /> Complete
                </button>
              </div>
            </section>
            {notice && (
              <div className="notice">
                <CircleHelp size={15} />
                {notice}
                <button onClick={() => setNotice('')} aria-label="Dismiss">
                  <X size={14} />
                </button>
              </div>
            )}
            {(connection === 'disconnected' || connection === 'incompatible') && (
              <div className="connection-banner" role="alert">
                <WifiOff size={16} />
                {connection === 'incompatible'
                  ? 'Daemon contract is incompatible. Last known data remains visible, but actions are disabled.'
                  : `Daemon connection is unavailable. Showing last known data${
                      lastUpdatedAt ? ` from ${lastUpdatedAt.toLocaleTimeString()}` : ''
                    }; actions are disabled.`}
              </div>
            )}
            {task.interactionStatus === 'waiting_for_operator' && (
              <div className="terminal-waiting-banner" role="status">
                <SquareTerminal size={18} />
                <div>
                  <strong>Terminal is waiting for you</strong>
                  <p>The worker returned a response. Continue in the terminal or finish the worker.</p>
                </div>
                {task.terminalAvailable && task.runId && (
                  <button className="text-button" onClick={() => setTerminalVisible(true)}>
                    Open terminal <ChevronRight size={14} />
                  </button>
                )}
              </div>
            )}
            <section className="summary-grid">
              <div className="summary-card">
                <span className="card-label">Current state</span>
                <Status state={task.state} />
                <span className="card-sub">
                  {task.attention ? task.attention.replaceAll('_', ' ') : 'No action needed'}
                </span>
              </div>
              <div className="summary-card">
                <span className="card-label">Result revision</span>
                <strong className="mono">{task.revision ?? '—'}</strong>
                <span className="card-sub">
                  {task.revision ? 'Latest verified revision' : 'No result yet'}
                </span>
              </div>
              <div className="summary-card">
                <span className="card-label">Review</span>
                <strong>
                  {!task.reviewed
                    ? 'Not reviewed'
                    : task.findings
                      ? `${task.findings} finding${task.findings === 1 ? '' : 's'}`
                      : 'Passed'}
                </strong>
                <span className="card-sub">Reviewer decision</span>
              </div>
              <div className="summary-card">
                <span className="card-label">Attempts</span>
                <strong>{task.attempts}</strong>
                <span className="card-sub">Automatic corrections</span>
              </div>
            </section>
            {terminalVisible && task.terminalAvailable && task.runId && (
              <TerminalPane
                runId={task.runId}
                sessionId={task.sessionId ?? null}
                onClose={() => setTerminalVisible(false)}
              />
            )}
            <div className="main-grid">
              <section className="panel thread-panel">
                <div className="panel-head">
                  <div>
                    <span className="eyebrow">Causal history</span>
                    <h2>Task Thread</h2>
                  </div>
                  <button
                    className={`toggle ${diagnostic ? 'active' : ''}`}
                    onClick={() => setDiagnostic(!diagnostic)}
                  >
                    {diagnostic ? 'Thread view' : 'Diagnostic events'} <ArrowUpRight size={14} />
                  </button>
                </div>
                {diagnostic ? <Diagnostic task={task} /> : <Thread items={task.thread.items} />}
                {task.workerOutput && (
                  <section className="worker-output" aria-label="Worker output">
                    <div className="panel-head compact">
                      <h3>Worker output</h3>
                      <span className="mono">{task.workerOutputRunId ?? 'latest run'}</span>
                    </div>
                    <pre>{task.workerOutput}</pre>
                  </section>
                )}
              </section>
              <aside className="right-rail">
                <Stages task={task} />
                <Findings task={task} />
                <section className="panel task-message-panel">
                  {task.attention === 'PLAN_APPROVAL_REQUIRED' && (
                    <div className="attention-box">
                      <AlertTriangle size={17} />
                      <div>
                        <strong>Plan approval required</strong>
                        <p>Review the proposed stages before execution starts.</p>
                        <button
                          className="text-button"
                          disabled={!canMutate}
                          onClick={() => act(['approve', task.id], 'Plan approved')}
                        >
                          Approve plan <ChevronRight size={14} />
                        </button>
                      </div>
                    </div>
                  )}
                  {task.state === 'WAITING_FOR_HUMAN' &&
                    task.attention !== 'PLAN_APPROVAL_REQUIRED' && (
                      <div className="attention-box">
                        <AlertTriangle size={17} />
                        <div>
                          <strong>Operator input required</strong>
                          <p>Add feedback below, then continue the task.</p>
                        </div>
                      </div>
                    )}
                  <div className="message-box">
                    <label htmlFor="operator-message">Add a message</label>
                    <textarea
                      id="operator-message"
                      disabled={!canMutate}
                      value={message}
                      onInput={(event) => setMessage(event.currentTarget.value)}
                      placeholder="Leave context for the next attempt…"
                    />
                    <button
                      className="button secondary full"
                      disabled={!canMutate || !message.trim()}
                      onClick={() =>
                        act(
                          ['task', 'message', task.id, '--message', message],
                          'Message added to Thread',
                        )
                      }
                    >
                      <Send size={14} /> Add to Thread
                    </button>
                  </div>
                  <button
                    className="text-button"
                    disabled={!canMutate || !task.terminalAvailable || !task.runId}
                    title={
                      task.terminalAvailable
                        ? 'Show the embedded terminal attached to the active Codex thread.'
                        : 'The managed Codex terminal is not available for this run'
                    }
                    onClick={() => setTerminalVisible(true)}
                  >
                    <SquareTerminal size={14} />
                    {task.terminalAvailable ? ' Show live terminal' : ' Terminal unavailable'}
                  </button>
                </section>
              </aside>
            </div>
          </div>
        </main>
      </div>
      {createOpen && <CreateTask onClose={() => setCreateOpen(false)} onCreate={createTask} />}
    </div>
  );
}

function canMutateFor(connection: ConnectionState) {
  return connection === 'connected' || connection === 'fixture';
}

function CreateTask({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (title: string, description: string) => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const submit = (event: Event) => {
    event.preventDefault();
    if (title.trim() && description.trim()) void onCreate(title.trim(), description.trim());
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="create-task" onSubmit={submit}>
        <div className="panel-head compact">
          <div>
            <span className="eyebrow">New task</span>
            <h2>Create a task</h2>
          </div>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <label htmlFor="task-title">Title</label>
        <input
          id="task-title"
          value={title}
          onInput={(event) => setTitle(event.currentTarget.value)}
          required
        />
        <label htmlFor="task-description">Description</label>
        <textarea
          id="task-description"
          value={description}
          onInput={(event) => setDescription(event.currentTarget.value)}
          required
        />
        <p className="small-muted">
          The task is created as Draft. Use Run task when you are ready to start its interactive
          worker.
        </p>
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary">
            Create task
          </button>
        </div>
      </form>
    </div>
  );
}
function Logo() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <GitBranch size={17} />
      </span>
      <span>clew</span>
      <span className="brand-slash">/</span>
      <span className="brand-context">control plane</span>
    </div>
  );
}
export function Thread({ items }: { items: ThreadItem[] }) {
  const newestCursor = Math.max(0, ...items.map((entry) => entry.cursor));

  return (
    <div className="thread">
      {[...items].reverse().map((entry) => (
        <div
          className={`thread-item${entry.cursor === newestCursor ? ' thread-item-new' : ''}`}
          key={entry.id}
        >
          <div className="thread-marker">{iconFor(entry.kind)}</div>
          <div className="thread-line" />{' '}
          <div className="thread-content">
            <div className="thread-meta">
              <span className="thread-kind">
                {kindLabel[entry.kind] ?? entry.kind.replaceAll('_', ' ')}
              </span>
              <time>{formatTime(entry.at)}</time>
            </div>
            <p>{entry.summary}</p>
            <div className="source">
              <span>{entry.stageId ?? 'task'}</span>
              {entry.runId && (
                <>
                  <span>·</span>
                  <span>{entry.runId}</span>
                </>
              )}
              <span>·</span>
              <span>source {entry.source.id}</span>
              {entry.redacted && <span className="redacted">redacted</span>}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
function Diagnostic({ task }: { task: Task }) {
  return (
    <div className="diagnostic">
      {task.events.length ? (
        task.events.map((event) => (
          <div className="diagnostic-row" key={event.seq}>
            <span className="mono">{event.seq}</span>
            <strong>{event.type}</strong>
            <time>{formatTime(event.at)}</time>
          </div>
        ))
      ) : (
        <div className="empty-inline">
          <WifiOff size={17} />
          Diagnostic events are available when connected to a daemon.
        </div>
      )}
    </div>
  );
}
function Stages({ task }: { task: Task }) {
  return (
    <section className="panel stages-panel">
      <div className="panel-head compact">
        <h3>Stages</h3>
        <span className="small-muted">{task.stages.length} total</span>
      </div>
      {task.stages.length ? (
        <div className="stages">
          {task.stages.map((stage) => (
            <div className="stage" key={stage.id}>
              <span className={`stage-icon stage-${stage.status.toLowerCase()}`}>
                {stage.status === 'COMPLETED' ? (
                  <Check size={14} />
                ) : stage.status === 'BLOCKED' ? (
                  <AlertTriangle size={14} />
                ) : (
                  <Activity size={14} />
                )}
              </span>
              <div>
                <strong>{stage.id}</strong>
                <span>
                  {stage.kind} · {stage.status.toLowerCase()}
                </span>
              </div>
              <ChevronRight size={15} className="stage-arrow" />
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-inline">No stages created yet.</div>
      )}
    </section>
  );
}

function Findings({ task }: { task: Task }) {
  if (!task.findingDetails?.length) return null;
  return (
    <section className="panel findings-panel">
      <div className="panel-head compact">
        <h3>Reviewer findings</h3>
        <span className="small-muted">{task.findingDetails.length} open</span>
      </div>
      <div className="findings">
        {task.findingDetails.map((finding, index) => (
          <div className="finding" key={`${finding.criterion ?? 'finding'}-${index}`}>
            <span>{finding.severity ?? 'review'}</span>
            <strong>{finding.criterion ?? 'Reviewer feedback'}</strong>
            <p>{finding.reason}</p>
            {finding.target && <code>{finding.target}</code>}
          </div>
        ))}
      </div>
    </section>
  );
}

export default App;
