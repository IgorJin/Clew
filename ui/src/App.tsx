import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Copy,
  FileDiff,
  GitBranch,
  Inbox,
  Laptop,
  LayoutDashboard,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  SquareTerminal,
  Terminal,
  WifiOff,
  X,
} from 'lucide-preact';
import { execute, loadTasks, subscribeToEvents, type ConnectionState } from './api';
import { rolesForProfile } from './api';
import type {
  AgentRole,
  AgentSession,
  NextStep,
  Project,
  Run,
  Task,
  TaskState,
  ThreadItem,
} from './types';
import { TerminalPane } from './TerminalPane';

const stateLabel: Record<TaskState, string> = {
  DRAFT: 'Draft',
  PLAN_READY: 'Plan ready',
  QUEUED: 'Queued',
  RECOVERING: 'Recovering',
  EXECUTING: 'Executing',
  VERIFYING: 'Verifying',
  REVIEWING: 'Review',
  WAITING_FOR_HUMAN: 'Waiting',
  READY: 'Ready',
  READY_TO_FINISH: 'Ready to finish',
  MERGED: 'Merged',
  RELEASED: 'Released',
  COMPLETED: 'Done',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  BLOCKED: 'Blocked',
};

type StatusGroup = 'waiting' | 'error' | 'active' | 'other';
const statusGroup: Record<TaskState, StatusGroup> = {
  WAITING_FOR_HUMAN: 'waiting',
  BLOCKED: 'waiting',
  FAILED: 'error',
  CANCELLED: 'error',
  EXECUTING: 'active',
  VERIFYING: 'active',
  REVIEWING: 'active',
  RECOVERING: 'active',
  QUEUED: 'active',
  DRAFT: 'other',
  PLAN_READY: 'other',
  READY: 'other',
  READY_TO_FINISH: 'other',
  MERGED: 'other',
  RELEASED: 'other',
  COMPLETED: 'other',
};

const kindLabel: Record<string, string> = {
  task_created: 'Created',
  run_started: 'Run started',
  review_findings: 'Review finding',
  retry_scheduled: 'Retry',
  review_recorded: 'Review',
  task_ready: 'Ready',
  plan_approval_required: 'Approval required',
  next_step_proposed: 'Next step',
  step_approved: 'Approved',
  codex_session_started: 'Session',
  codex_turn_started: 'Turn',
  worker_tool_started: 'Tool started',
  worker_tool_completed: 'Tool done',
  worker_waiting: 'Worker response',
  worker_turn_failed: 'Worker turn failed',
  worker_turn_interrupted: 'Worker turn interrupted',
  worker_output: 'Output',
};

type ProjectAwareness = { running: number; waiting: number };

function projectAwareness(all: Task[], projectId: string): ProjectAwareness {
  let running = 0;
  let waiting = 0;

  for (const task of all) {
    if (task.projectId !== projectId) continue;
    const group = statusGroup[task.state];

    if (group === 'active') running += 1;
    if (group === 'waiting') waiting += 1;
  }

  return { running, waiting };
}

type AttentionItem = {
  task: Task;
  project: Project;
};

function globalAttention(all: Task[], projects: Project[]): AttentionItem[] {
  const items: AttentionItem[] = [];

  for (const task of all) {
    const group = statusGroup[task.state];

    if (group !== 'waiting') continue;
    const project = projects.find((entry) => entry.id === task.projectId) ?? null;

    if (!project) continue;
    items.push({ task, project });
  }

  return items;
}

function taskProgress(state: TaskState): number {
  switch (state) {
    case 'DRAFT':
      return 5;
    case 'PLAN_READY':
      return 15;
    case 'QUEUED':
      return 25;
    case 'RECOVERING':
      return 35;
    case 'EXECUTING':
      return 45;
    case 'VERIFYING':
      return 60;
    case 'REVIEWING':
      return 75;
    case 'WAITING_FOR_HUMAN':
      return 70;
    case 'READY':
      return 90;
    case 'COMPLETED':
      return 100;
    case 'FAILED':
      return 20;
    case 'CANCELLED':
      return 0;
    case 'BLOCKED':
      return 30;
    default:
      return 0;
  }
}

function waveTone(state: TaskState): string {
  if (state === 'COMPLETED' || state === 'READY') return 'green';
  const group = statusGroup[state];
  if (group === 'error') return 'red';
  if (group === 'waiting') return 'amber';
  if (group === 'active') return 'blue';
  return 'accent';
}

function Wave({ state }: { state: TaskState }) {
  const fill = taskProgress(state);
  return (
    <div
      className={`progress wave-${waveTone(state)}`}
      role="progressbar"
      aria-valuenow={fill}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`${stateLabel[state]} · ${fill}%`}
      title={`${stateLabel[state]} · ${fill}% complete`}
    >
      <span className="progress-fill" style={{ width: `${fill}%` }} />
    </div>
  );
}

function Status({ state }: { state: TaskState }) {
  return (
    <span className={`status status-${state.toLowerCase()}`}>
      <span className="status-dot" />
      {stateLabel[state]}
    </span>
  );
}

function Connection({ state }: { state: ConnectionState }) {
  const labels: Record<ConnectionState, string> = {
    fixture: 'Fixture',
    connected: 'Connected',
    disconnected: 'Disconnected',
    reconnecting: 'Reconnecting…',
    incompatible: 'Incompatible',
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
  if (kind.includes('review')) return <ShieldCheck size={13} />;
  if (kind.includes('run')) return <SquareTerminal size={13} />;
  if (kind.includes('retry')) return <RefreshCw size={13} />;
  if (kind.includes('approval')) return <AlertTriangle size={13} />;
  if (kind.includes('ready')) return <Check size={13} />;
  return <Activity size={13} />;
}

function agentIcon(role: AgentRole) {
  if (role === 'architect') return <GitBranch size={12} />;
  if (role === 'reviewer') return <ShieldCheck size={12} />;
  return <Terminal size={12} />;
}

type Route = {
  projectId: string | null;
  taskId: string | null;
  view: 'overview' | 'tasks';
};

function routeFromLocation(): Route {
  const pathname = window.location.pathname;
  const taskMatch = pathname.match(/^\/projects\/([^/]+)\/tasks\/([^/]+)\/?$/);

  if (taskMatch)
    return {
      projectId: decodeURIComponent(taskMatch[1]),
      taskId: decodeURIComponent(taskMatch[2]),
      view: 'tasks',
    };
  const overviewMatch = pathname.match(/^\/projects\/([^/]+)\/overview\/?$/);

  if (overviewMatch)
    return {
      projectId: decodeURIComponent(overviewMatch[1]),
      taskId: null,
      view: 'overview',
    };
  const projectMatch = pathname.match(/^\/projects\/([^/]+)\/?$/);

  if (projectMatch)
    return {
      projectId: decodeURIComponent(projectMatch[1]),
      taskId: null,
      view: 'tasks',
    };
  const legacyMatch = pathname.match(/^\/tasks\/([^/]+)\/?$/);

  if (legacyMatch)
    return { projectId: null, taskId: decodeURIComponent(legacyMatch[1]), view: 'tasks' };

  return { projectId: null, taskId: null, view: 'tasks' };
}

function resolveDefaultRoute(current: Route, projects: Project[], tasks: Task[]): Route {
  let projectId = current.projectId;

  if (projectId && !projects.some((entry) => entry.id === projectId)) projectId = null;
  if (!projectId && current.taskId) {
    const ownerId = tasks.find((entry) => entry.id === current.taskId)?.projectId ?? null;

    if (ownerId && projects.some((entry) => entry.id === ownerId)) projectId = ownerId;
  }
  if (!projectId) {
    const stored = storedProjectId();

    if (stored && projects.some((entry) => entry.id === stored)) projectId = stored;
  }
  if (!projectId) projectId = projects[0]?.id ?? null;
  if (!projectId) return current;

  let taskId = current.view === 'overview' ? null : current.taskId;
  const scoped = scopedTasks(tasks, projectId);

  if (taskId && !scoped.some((entry) => entry.id === taskId)) taskId = null;
  if (!taskId && current.view !== 'overview') {
    taskId = storedTaskId(projectId);
    if (taskId && !scoped.some((entry) => entry.id === taskId)) taskId = null;
    if (!taskId) taskId = scoped[0]?.id ?? null;
  }

  return { projectId, taskId, view: current.view };
}

function routePath(projectId: string, taskId: string | null, view: 'overview' | 'tasks'): string {
  if (taskId)
    return `/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`;
  if (view === 'overview') return `/projects/${encodeURIComponent(projectId)}/overview`;

  return `/projects/${encodeURIComponent(projectId)}`;
}

const PROJECT_STORAGE_PREFIX = 'clew.v1';

function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(`${PROJECT_STORAGE_PREFIX}.${key}`);
  } catch {
    return null;
  }
}

function writePreference(key: string, value: string) {
  try {
    localStorage.setItem(`${PROJECT_STORAGE_PREFIX}.${key}`, value);
  } catch {
    // Private browsing or disabled storage must never break navigation.
  }
}

function storedProjectId(): string | null {
  return readPreference('current-project');
}

function storedTaskId(projectId: string): string | null {
  return readPreference(`last-task.${projectId}`);
}

/** Legacy tasks without a project stay visible instead of vanishing after the upgrade. */
function scopedTasks(all: Task[], projectId: string | null): Task[] {
  if (!projectId) return [];

  return all.filter((task) => task.projectId === projectId || task.projectId == null);
}

function Logo() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <GitBranch size={14} />
      </span>
      <span>clew</span>
      <span className="brand-slash">/</span>
      <span className="brand-context">control plane</span>
    </div>
  );
}

function ProjectSwitcher({
  projects,
  currentId,
  awareness,
  onSelect,
  onAdd,
}: {
  projects: Project[];
  currentId: string;
  awareness: Record<string, ProjectAwareness>;
  onSelect: (projectId: string) => void;
  onAdd: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const current = projects.find((entry) => entry.id === currentId);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node))
        setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="project-switcher" ref={containerRef}>
      <button
        ref={buttonRef}
        className="project-switcher-button"
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Project: ${current?.name ?? 'none'}`}
      >
        <span className="project-switcher-mark">
          <GitBranch size={13} />
        </span>
        <span className="project-switcher-name">{current?.name ?? 'Select project'}</span>
        <ChevronDown size={12} className="project-switcher-caret" />
      </button>
      {open && (
        <div className="project-menu">
          {projects.map((entry) => {
            const a = awareness[entry.id];

            return (
              <button
                key={entry.id}
                className={`project-menu-item${entry.id === currentId ? ' active' : ''}`}
                aria-current={entry.id === currentId}
                onClick={() => {
                  setOpen(false);
                  onSelect(entry.id);
                }}
              >
                <GitBranch size={12} />
                <span className="project-menu-name">{entry.name}</span>
                {a && (a.running > 0 || a.waiting > 0) && (
                  <span className="project-menu-badges">
                    {a.running > 0 && <span className="badge badge-blue">{a.running} running</span>}
                    {a.waiting > 0 && (
                      <span className="badge badge-amber">{a.waiting} waiting</span>
                    )}
                  </span>
                )}
                {entry.id === currentId && <Check size={12} className="project-menu-check" />}
              </button>
            );
          })}
          <div className="project-menu-sep" />
          <button
            className="project-menu-item"
            onClick={() => {
              setOpen(false);
              onAdd();
            }}
          >
            <Plus size={12} />
            <span className="project-menu-name">Add project</span>
          </button>
        </div>
      )}
    </div>
  );
}

function GlobalAttention({
  items,
  onSelect,
}: {
  items: AttentionItem[];
  onSelect: (projectId: string, taskId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node))
        setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (!items.length) return null;

  return (
    <div className="global-attention" ref={containerRef}>
      <button
        className="icon-button attention-trigger"
        aria-label={`${items.length} attention item${items.length === 1 ? '' : 's'}`}
        onClick={() => setOpen(!open)}
      >
        <Bell size={14} />
        <span className="attention-count">{items.length}</span>
      </button>
      {open && (
        <div className="attention-dropdown">
          <div className="attention-dropdown-head">
            <span>Needs attention</span>
          </div>
          {items.map(({ task, project }) => (
            <button
              key={task.id}
              className="attention-dropdown-item"
              onClick={() => {
                setOpen(false);
                onSelect(project.id, task.id);
              }}
            >
              <span className="task-id">{task.id}</span>
              <span className="attention-dropdown-title">{task.title}</span>
              <span className="attention-dropdown-project">{project.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CommandPalette({
  projects,
  tasks,
  onSelect,
}: {
  projects: Project[];
  tasks: Task[];
  onSelect: (projectId: string, taskId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const items = useMemo(() => {
    const all: { projectId: string; projectName: string; taskId: string | null; label: string }[] =
      [];

    for (const project of projects) {
      all.push({
        projectId: project.id,
        projectName: project.name,
        taskId: null,
        label: project.name,
      });
      for (const task of tasks) {
        if (task.projectId !== project.id) continue;
        all.push({
          projectId: project.id,
          projectName: project.name,
          taskId: task.id,
          label: `${task.id} — ${task.title}`,
        });
      }
    }

    if (!query.trim()) return all;
    const lower = query.toLowerCase();

    return all.filter(
      (entry) =>
        entry.label.toLowerCase().includes(lower) ||
        entry.projectName.toLowerCase().includes(lower) ||
        (entry.taskId ?? '').toLowerCase().includes(lower),
    );
  }, [projects, tasks, query]);

  const openRef = useRef(open);
  openRef.current = open;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useLayoutEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((v) => !v);

        return;
      }
      if (!openRef.current) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, itemsRef.current.length - 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (event.key === 'Enter' && itemsRef.current[activeIndexRef.current]) {
        event.preventDefault();
        const entry = itemsRef.current[activeIndexRef.current];

        setOpen(false);
        onSelectRef.current(entry.projectId, entry.taskId);
      }
    };
    window.addEventListener('keydown', onKeyDown);

    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);

    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  if (!open) return null;

  return (
    <div className="modal-backdrop palette-backdrop" role="presentation">
      <div className="command-palette" role="dialog" aria-label="Command palette">
        <div className="palette-input-wrap">
          <Search size={14} className="palette-search-icon" />
          <input
            ref={inputRef}
            className="palette-input"
            placeholder="Switch project or task…"
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
        </div>
        <div className="palette-list">
          {items.length === 0 && <div className="palette-empty">No results</div>}
          {items.map((entry, i) => (
            <button
              key={`${entry.projectId}-${entry.taskId ?? 'proj'}`}
              className={`palette-item${i === activeIndex ? ' active' : ''}`}
              onClick={() => {
                setOpen(false);
                onSelect(entry.projectId, entry.taskId);
              }}
              onMouseEnter={() => setActiveIndex(i)}
            >
              {entry.taskId ? (
                <span className="palette-item-task">
                  <span className="task-id">{entry.taskId}</span>
                  {entry.label.slice(entry.taskId.length)}
                </span>
              ) : (
                <span className="palette-item-project">
                  <GitBranch size={12} />
                  {entry.projectName}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="palette-footer">
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}

function ProjectSidebar({
  projects,
  projectId,
  view,
  tasks,
  selectedTaskId,
  statusFilter,
  awareness,
  onSelectProject,
  onSelectView,
  onSelectTask,
  onSetStatusFilter,
  onCreateTask,
  onAddProject,
}: {
  projects: Project[];
  projectId: string;
  view: 'overview' | 'tasks';
  tasks: Task[];
  selectedTaskId: string | null;
  statusFilter: string | null;
  awareness: Record<string, ProjectAwareness>;
  onSelectProject: (projectId: string) => void;
  onSelectView: (view: 'overview' | 'tasks') => void;
  onSelectTask: (taskId: string) => void;
  onSetStatusFilter: (filter: string | null) => void;
  onCreateTask: () => void;
  onAddProject: () => void;
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar-switcher-row">
        <ProjectSwitcher
          projects={projects}
          currentId={projectId}
          awareness={awareness}
          onSelect={onSelectProject}
          onAdd={onAddProject}
        />
        <button
          className="icon-button view-toggle"
          aria-label="Overview"
          aria-pressed={view === 'overview'}
          title={view === 'overview' ? 'Back to tasks' : 'Overview board'}
          onClick={() => onSelectView(view === 'overview' ? 'tasks' : 'overview')}
        >
          <LayoutDashboard size={14} />
        </button>
      </div>
      <div className="sidebar-heading">
        <span>Tasks</span>
        <button className="text-button" onClick={onCreateTask}>
          + New
        </button>
        <span className="count">{tasks.length}</span>
      </div>
      <div className="sidebar-filters">
        {[
          { key: null, label: 'All' },
          { key: 'waiting', label: 'Waiting' },
          { key: 'active', label: 'Active' },
          { key: 'other', label: 'Other' },
          { key: 'error', label: 'Failed' },
        ].map((f) => (
          <button
            key={f.key ?? 'all'}
            className={`filter-chip${statusFilter === f.key ? ' active' : ''}`}
            onClick={() => onSetStatusFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="task-list">
        {tasks.map((entry) => (
          <button
            className={`task-row ${entry.id === selectedTaskId ? 'selected' : ''}${entry.interactionStatus === 'waiting_for_operator' ? ' task-row-waiting' : ''}`}
            key={entry.id}
            onClick={() => onSelectTask(entry.id)}
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
                <AlertTriangle size={11} />
                {entry.attention.replaceAll('_', ' ')}
              </span>
            )}
            <span className="task-meta">
              {entry.profile} · {entry.attempts ? `${entry.attempts} runs` : 'not started'}
            </span>
            <Wave state={entry.state} />
          </button>
        ))}
      </div>
      <div className="sidebar-footer">
        <span className="version">v0.4</span>
      </div>
    </aside>
  );
}

export function Thread({ items }: { items: ThreadItem[] }) {
  const newestCursor = Math.max(0, ...items.map((e) => e.cursor));

  return (
    <div className="thread">
      {[...items].reverse().map((entry) => (
        <div
          className={`thread-item${entry.cursor === newestCursor ? ' thread-item-new' : ''}`}
          key={entry.id}
        >
          <div className="thread-marker">{iconFor(entry.kind)}</div>
          <div className="thread-line" />
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
              <span>{entry.source.id}</span>
              {entry.redacted && <span className="redacted">redacted</span>}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

const KANBAN_COLUMNS: { key: string; label: string; states: TaskState[] }[] = [
  { key: 'draft', label: 'Draft', states: ['DRAFT', 'PLAN_READY'] },
  {
    key: 'active',
    label: 'Active',
    states: ['QUEUED', 'RECOVERING', 'EXECUTING', 'VERIFYING', 'REVIEWING'],
  },
  { key: 'waiting', label: 'Waiting', states: ['WAITING_FOR_HUMAN', 'BLOCKED'] },
  { key: 'ready', label: 'Ready', states: ['READY', 'READY_TO_FINISH'] },
  { key: 'done', label: 'Done', states: ['COMPLETED', 'MERGED', 'RELEASED'] },
  { key: 'failed', label: 'Failed', states: ['FAILED', 'CANCELLED'] },
];

type OverviewTypeFilter = 'all' | 'quick' | 'standard' | 'deep';

function Overview({
  project,
  tasks,
  onSelectTask,
  onCreateTask,
}: {
  project: Project;
  tasks: Task[];
  onSelectTask: (taskId: string) => void;
  onCreateTask: () => void;
}) {
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [statusFilter, setStatusFilter] = useState<'all' | TaskState>('all');
  const [typeFilter, setTypeFilter] = useState<OverviewTypeFilter>('all');

  const filtered = tasks.filter(
    (task) =>
      (!attentionOnly || statusGroup[task.state] === 'waiting') &&
      (statusFilter === 'all' || task.state === statusFilter) &&
      (typeFilter === 'all' || task.profile === typeFilter),
  );

  return (
    <div className="overview">
      <div className="overview-head">
        <div className="overview-title">
          <span className="eyebrow">Project</span>
          <h2>{project.name}</h2>
        </div>
        <button className="button primary small" onClick={onCreateTask}>
          <Plus size={12} /> New task
        </button>
      </div>
      <div className="kanban-filters" role="group" aria-label="Board filters">
        <button
          className={`filter-chip${attentionOnly ? ' active' : ''}`}
          aria-pressed={attentionOnly}
          onClick={() => setAttentionOnly((value) => !value)}
        >
          <AlertTriangle size={11} /> Needs attention
        </button>
        <select
          className="kanban-filter"
          aria-label="Filter by status"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.currentTarget.value as 'all' | TaskState)}
        >
          <option value="all">All statuses</option>
          {(Object.keys(stateLabel) as TaskState[]).map((state) => (
            <option key={state} value={state}>
              {stateLabel[state]}
            </option>
          ))}
        </select>
        <select
          className="kanban-filter"
          aria-label="Filter by type"
          value={typeFilter}
          onChange={(event) => setTypeFilter(event.currentTarget.value as OverviewTypeFilter)}
        >
          <option value="all">All types</option>
          <option value="quick">Quick</option>
          <option value="standard">Standard</option>
          <option value="deep">Deep</option>
        </select>
      </div>
      <div className="kanban">
        {KANBAN_COLUMNS.map((column) => {
          const cards = filtered.filter((task) => column.states.includes(task.state));

          if (!cards.length) return null;
          return (
            <section
              className="kanban-column"
              key={column.key}
              aria-label={`${column.label} column`}
            >
              <header className="kanban-column-head">
                <h3>{column.label}</h3>
                <span className="small-muted">{cards.length}</span>
              </header>
              <div className="kanban-cards">
                {cards.map((task) => (
                  <button
                    className="kanban-card"
                    key={task.id}
                    onClick={() => onSelectTask(task.id)}
                  >
                    <div className="kanban-card-top">
                      <span className="task-id">{task.id}</span>
                      <Status state={task.state} />
                    </div>
                    <strong>{task.title}</strong>
                    <span className="kanban-card-meta">
                      {task.profile}
                      {task.attention ? ' · needs attention' : ''}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
        {!filtered.length && (
          <div className="empty-inline">No tasks match the current filters.</div>
        )}
      </div>
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
          <WifiOff size={15} />
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
                  <Check size={12} />
                ) : stage.status === 'BLOCKED' ? (
                  <AlertTriangle size={12} />
                ) : (
                  <Activity size={12} />
                )}
              </span>
              <div>
                <strong>{stage.id}</strong>
                <span>
                  {stage.kind} · {stage.status.toLowerCase()}
                </span>
              </div>
              <ChevronRight size={13} className="stage-arrow" />
            </div>
          ))}
        </div>
      ) : (
        <div className="empty-inline">No stages yet.</div>
      )}
    </section>
  );
}

function Findings({ task }: { task: Task }) {
  if (!task.findingDetails?.length) return null;
  return (
    <section className="panel findings-panel">
      <div className="panel-head compact">
        <h3>Findings</h3>
        <span className="small-muted">{task.findingDetails.length} open</span>
      </div>
      <div className="findings">
        {task.findingDetails.map((finding, i) => (
          <div className="finding" key={`${finding.criterion ?? 'f'}-${i}`}>
            <span>{finding.severity ?? 'review'}</span>
            <strong>{finding.criterion ?? 'Feedback'}</strong>
            <p>{finding.reason}</p>
            {finding.target && <code>{finding.target}</code>}
          </div>
        ))}
      </div>
    </section>
  );
}

type ChangeInspection = {
  version: 1;
  runId: string;
  state: 'available' | 'unavailable';
  reason?: string;
  summary: { files: number; additions: number; deletions: number };
  files: string[];
  statuses: { path: string; oldPath?: string; status: string }[];
  patch: string;
  binary: boolean;
  dirty: boolean;
  revisions: { base: string | null; head: string | null; committed?: string | null };
};

type ChangeLoad = {
  loading: boolean;
  result?: ChangeInspection;
  error?: string;
};

type AgentCard = {
  key: string;
  role: AgentRole;
  label: string;
  run?: Run;
  agentSession?: AgentSession;
};

function changeUnavailableLabel(reason?: string) {
  if (reason === 'runner-local-unavailable')
    return 'Changes are available only on the Runner host.';
  if (reason === 'missing-worktree') return 'This run worktree is no longer available.';
  if (reason === 'base-revision-unavailable') return 'The run baseline is unavailable.';
  if (reason === 'git-inspection-failed') return 'Git could not inspect this run.';
  return 'Changes are unavailable for this run.';
}

function patchForFile(patch: string, path: string | null) {
  if (!path) return patch;
  const sections = patch.split(/(?=^diff --git )/m).filter(Boolean);

  return sections.find((section) => section.includes(` b/${path}`)) ?? patch;
}

function ChangeActions({
  run,
  changes,
  disabled,
  onOpenEditor,
  onViewDiff,
  onCopyPath,
  onRefresh,
}: {
  run: Run | undefined;
  changes: ChangeLoad | undefined;
  disabled: boolean;
  onOpenEditor: () => void;
  onViewDiff: () => void;
  onCopyPath: () => void;
  onRefresh: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const available = changes?.result?.state === 'available';
  const label = changes?.loading
    ? 'Changes…'
    : available
      ? `Changes +${changes.result!.summary.additions} −${changes.result!.summary.deletions}`
      : !run || changes?.result?.state === 'unavailable' || changes?.error
        ? 'Changes unavailable'
        : 'Changes';
  const unavailable = !run || changes?.result?.state === 'unavailable';

  return (
    <div className="changes-control">
      <button
        className="button secondary small changes-main"
        disabled={disabled || unavailable}
        title={!run ? 'No persisted run for this agent' : undefined}
        onClick={() => {
          setMenuOpen(false);
          onOpenEditor();
        }}
      >
        <FileDiff size={12} /> {label}
      </button>
      <button
        className="button secondary small changes-menu-toggle"
        disabled={disabled || !run}
        aria-label={`Change actions for ${run?.stageId ?? 'agent'}`}
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <ChevronDown size={12} />
      </button>
      {menuOpen && run && (
        <div className="changes-menu" role="menu">
          <button
            role="menuitem"
            disabled={unavailable}
            onClick={() => {
              setMenuOpen(false);
              onOpenEditor();
            }}
          >
            <Laptop size={12} /> Open in editor
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              onViewDiff();
            }}
          >
            <FileDiff size={12} /> View diff
          </button>
          <button
            role="menuitem"
            disabled={unavailable}
            onClick={() => {
              setMenuOpen(false);
              onCopyPath();
            }}
          >
            <Copy size={12} /> Copy worktree path
          </button>
          <button role="menuitem" onClick={onRefresh}>
            <RefreshCw size={12} /> Refresh summary
          </button>
        </div>
      )}
    </div>
  );
}

function DiffViewer({
  run,
  changes,
  onRefresh,
  onClose,
}: {
  run: Run;
  changes: ChangeLoad | undefined;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const result = changes?.result;
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'unified' | 'split'>('unified');

  useEffect(() => {
    if (result?.state !== 'available') return;
    setSelectedPath((current) =>
      current && result.files.includes(current) ? current : (result.files[0] ?? null),
    );
  }, [result]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return (
    <div className="modal-backdrop diff-backdrop" role="presentation" onClick={onClose}>
      <section
        className="diff-viewer"
        role="dialog"
        aria-modal="true"
        aria-label={`Changes for ${run.stageId}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="diff-viewer-head">
          <div>
            <span className="eyebrow">
              {run.stageId} · attempt {run.attempt}
            </span>
            <h2>
              {result?.state === 'available'
                ? `Changes +${result.summary.additions} −${result.summary.deletions}`
                : 'Changes'}
            </h2>
          </div>
          <div className="diff-viewer-actions">
            <button className="icon-button" aria-label="Refresh diff" onClick={onRefresh}>
              <RefreshCw size={15} />
            </button>
            <button className="icon-button" aria-label="Close diff" onClick={onClose}>
              <X size={15} />
            </button>
          </div>
        </header>
        {changes?.loading && !result ? (
          <div className="diff-state">Loading changes…</div>
        ) : changes?.error ? (
          <div className="diff-state error">{changes.error}</div>
        ) : result?.state === 'unavailable' ? (
          <div className="diff-state unavailable">{changeUnavailableLabel(result.reason)}</div>
        ) : result?.state === 'available' && result.files.length === 0 ? (
          <div className="diff-state">No changes relative to the run baseline.</div>
        ) : result?.state === 'available' ? (
          <div className="diff-layout">
            <aside className="diff-files" aria-label="Changed files">
              {result.statuses.map((file) => (
                <button
                  className={`diff-file${selectedPath === file.path ? ' selected' : ''}`}
                  key={`${file.status}:${file.path}`}
                  type="button"
                  aria-pressed={selectedPath === file.path}
                  onClick={() => setSelectedPath(file.path)}
                >
                  <span>{file.status.trim() || 'M'}</span>
                  <code title={file.path}>{file.path}</code>
                </button>
              ))}
            </aside>
            <div className="diff-content">
              {result.binary && <div className="binary-notice">Includes binary changes</div>}
              <div className="diff-mode-toggle" aria-label="Diff layout">
                <button
                  type="button"
                  className={viewMode === 'unified' ? 'active' : ''}
                  aria-pressed={viewMode === 'unified'}
                  onClick={() => setViewMode('unified')}
                >
                  Unified
                </button>
                <button
                  type="button"
                  className={viewMode === 'split' ? 'active' : ''}
                  aria-pressed={viewMode === 'split'}
                  onClick={() => setViewMode('split')}
                >
                  Split
                </button>
              </div>
              <div className="diff-lines" role="region" aria-label="Unified diff">
                {patchForFile(result.patch, selectedPath)
                  .split('\n')
                  .map((line, index) => {
                    const kind = line.startsWith('@@')
                      ? 'hunk'
                      : line.startsWith('+++') || line.startsWith('---')
                        ? 'header'
                        : line.startsWith('+')
                          ? 'addition'
                          : line.startsWith('-')
                            ? 'deletion'
                            : 'context';
                    return viewMode === 'unified' ? (
                      <div className={`diff-line diff-line-${kind}`} key={`${index}:${line}`}>
                        <span className="diff-line-number">{index + 1}</span>
                        <code>{line || ' '}</code>
                      </div>
                    ) : (
                      <div className={`diff-split-line diff-line-${kind}`} key={`${index}:${line}`}>
                        <span className="diff-line-number">{index + 1}</span>
                        <code>{kind === 'addition' ? ' ' : line || ' '}</code>
                        <span className="diff-line-number">{index + 1}</span>
                        <code>{kind === 'deletion' ? ' ' : line || ' '}</code>
                      </div>
                    );
                  })}
              </div>
            </div>
          </div>
        ) : (
          <div className="diff-state">Select refresh to inspect this run.</div>
        )}
      </section>
    </div>
  );
}

function AgentGrid({
  task,
  canMutate,
  act,
  expandedAgent,
  onToggleExpand,
}: {
  task: Task;
  canMutate: boolean;
  act: (args: string[], success: string) => void;
  expandedAgent: string | null;
  onToggleExpand: (agent: string) => void;
}) {
  const cards = task.roles.flatMap<AgentCard>((role) => {
    if (role !== 'worker')
      return [
        {
          key: role,
          role,
          label: role,
          run: undefined,
          agentSession: task.agentSessions.find((session) => session.role === role),
        },
      ];
    const plannedWorkerStages = task.stages
      .filter((stage) => ['worker', 'integration'].includes(stage.kind))
      .map((stage) => stage.id);
    const runStages = task.runs
      .map((run) => run.stageId)
      .filter((stageId) => !['architect', 'reviewer', 'qa'].includes(stageId));
    const stageIds = [...new Set([...plannedWorkerStages, ...runStages])];

    return (stageIds.length ? stageIds : ['worker']).map((stageId) => ({
      key: stageId === 'worker' ? 'worker' : `worker:${stageId}`,
      role,
      label: stageId === 'worker' ? 'worker' : `worker · ${stageId}`,
      run: [...task.runs].reverse().find((candidate) => candidate.stageId === stageId),
      agentSession: undefined,
    }));
  });

  return (
    <div className="agent-grid">
      {cards.map(({ key, role, label, run, agentSession }) => {
        const isWorkerRole = role === 'worker';
        const currentRunIsNotInSnapshot = Boolean(
          task.runId && !task.runs.some((candidate) => candidate.id === task.runId),
        );
        const isCurrentRun = Boolean(
          run &&
          (run.id === task.runId ||
            ((!task.runId || currentRunIsNotInSnapshot) &&
              run.stageId === (task.sessionStageId ?? 'worker'))),
        );
        const isRunning = isWorkerRole
          ? run?.status === 'RUNNING' || (isCurrentRun && task.runStatus === 'RUNNING')
          : false;
        const isCompleted = isWorkerRole
          ? run?.status === 'COMPLETED' || (isCurrentRun && task.runStatus === 'COMPLETED')
          : false;
        const hasSession = isWorkerRole
          ? !!(run?.sessionId || (isCurrentRun && task.sessionId) || isRunning)
          : !!agentSession;
        const terminalId = isWorkerRole
          ? isCurrentRun
            ? (task.runId ?? run?.id)
            : run?.id
          : agentSession?.id;
        const terminalAvailable = isWorkerRole
          ? Boolean(
              terminalId &&
              (run?.terminalAvailable || (isCurrentRun && task.terminalAvailable)) &&
              (run?.terminalAccess ?? (isCurrentRun ? task.terminalAccess : 'unavailable')) !==
                'runner_local',
            )
          : Boolean(agentSession);
        const expanded = expandedAgent === key && terminalAvailable && Boolean(terminalId);
        const statusClass = isRunning ? 'running' : isCompleted ? 'completed' : 'idle';

        return (
          <div className={`agent-card${expanded ? ' expanded' : ''}`} key={key}>
            <div className="agent-header">
              <span className="agent-role">
                <span className="agent-role-icon">{agentIcon(role)}</span>
                {label}
              </span>
              <span className={`agent-status ${statusClass}`}>
                {isRunning ? 'running' : isCompleted ? 'done' : hasSession ? 'available' : 'idle'}
              </span>
            </div>
            <div className="agent-meta">
              {isWorkerRole ? (
                run ? (
                  <>
                    {run.harness} · attempt {run.attempt}
                    {run.commitSha && <span> · {run.commitSha.slice(0, 7)}</span>}
                  </>
                ) : (
                  <span>No runs</span>
                )
              ) : agentSession ? (
                <>
                  {agentSession.harness} · session available
                  {agentSession.workspace && <span> · {agentSession.workspace}</span>}
                </>
              ) : (
                <span>Plan not created yet</span>
              )}
            </div>
            <div className="agent-actions">
              <button
                className="button secondary small"
                disabled={!canMutate || !terminalAvailable}
                aria-expanded={expanded}
                aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label} terminal`}
                onClick={() => onToggleExpand(key)}
              >
                <SquareTerminal size={12} />
                {expanded ? 'Collapse' : 'Expand'}
              </button>
              <button
                className="button secondary small"
                disabled={!canMutate || !hasSession}
                aria-label={`Open ${label} externally`}
                title={
                  hasSession ? `Open ${label} in Terminal` : `No session available for ${label}`
                }
                onClick={() => {
                  if (isWorkerRole) {
                    act(
                      [
                        'session',
                        'open',
                        task.id,
                        '--stage',
                        run?.stageId ?? role,
                        '--role',
                        role,
                        '--harness',
                        run?.harness ?? 'codex',
                        ...(isRunning ? ['--surface', 'live', '--mode', 'live'] : []),
                      ],
                      `${role} terminal opened`,
                    );
                  } else {
                    act(
                      [
                        'session',
                        'open',
                        task.id,
                        '--role',
                        role,
                        '--harness',
                        agentSession?.harness ?? 'codex',
                      ],
                      `${role} terminal opened`,
                    );
                  }
                }}
              >
                <Terminal size={12} />
                Open externally
              </button>
            </div>
            {expanded && terminalId && (
              <TerminalPane
                terminalId={terminalId}
                runId={isWorkerRole ? terminalId : null}
                agentSessionId={isWorkerRole ? null : agentSession?.id}
                taskId={task.id}
                role={role}
                sessionId={
                  isWorkerRole
                    ? (run?.sessionId ?? (isCurrentRun ? task.sessionId : null) ?? null)
                    : agentSession!.sessionId
                }
                onClose={() => onToggleExpand(key)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

type CreateTaskInput = {
  title: string;
  body: string;
  profile: 'quick' | 'standard' | 'deep';
  tags: string;
};

function autoTitle(body: string): string {
  const firstLine = body.split('\n')[0].trim();

  return firstLine.slice(0, 120);
}

function CreateTask({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (input: CreateTaskInput) => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [profile, setProfile] = useState<'quick' | 'standard' | 'deep'>('quick');
  const [tags, setTags] = useState('');
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const handleBodyInput = (event: Event) => {
    const value = (event.currentTarget as HTMLTextAreaElement).value;
    setBody(value);
    if (
      !title.trim() ||
      (title === autoTitle(body.slice(0, value.length - 1)) && value.length > 0)
    ) {
      setTitle(autoTitle(value));
    }
  };

  const submit = (event: Event) => {
    event.preventDefault();
    const cleanTitle = (title.trim() || autoTitle(body)).trim();
    if (!cleanTitle || !body.trim()) return;
    void onCreate({
      title: cleanTitle,
      body: body.trim(),
      profile,
      tags: tags.trim(),
    });
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
            <X size={14} />
          </button>
        </div>
        <label htmlFor="task-body">What should be done?</label>
        <textarea
          ref={bodyRef}
          id="task-body"
          className="create-task-body"
          value={body}
          onInput={handleBodyInput}
          placeholder="Describe the task, expected behavior, constraints..."
          required
        />
        <label htmlFor="task-title">Title</label>
        <input
          id="task-title"
          value={title}
          onInput={(event) => setTitle(event.currentTarget.value)}
          placeholder={autoTitle(body) || 'Short title'}
        />
        <label>Complexity</label>
        <div className="profile-selector">
          {(
            [
              ['quick', 'Quick'],
              ['standard', 'Standard'],
              ['deep', 'Deep'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`profile-chip ${profile === key ? 'selected' : ''}`}
              onClick={() => setProfile(key)}
              aria-pressed={profile === key}
            >
              <span className="profile-name">{label}</span>
              <span className="profile-hint">
                {key === 'quick'
                  ? 'worker'
                  : key === 'standard'
                    ? '+ review'
                    : 'architect + review'}
              </span>
            </button>
          ))}
        </div>
        <label htmlFor="task-tags">Tags</label>
        <input
          id="task-tags"
          value={tags}
          onInput={(event) => setTags(event.currentTarget.value)}
          placeholder="comma, separated"
        />
        <p className="small-muted">
          Created as Draft. You'll need to approve the next step before it starts.
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

function FinalizationGate({
  task,
  onClose,
  onAction,
}: {
  task: Task;
  onClose: () => void;
  onAction: (args: string[], success: string) => Promise<boolean>;
}) {
  const report = task.finalization;
  const [message, setMessage] = useState(`Integrate ${task.id}`);
  const [evidence, setEvidence] = useState('');
  const [strategy, setStrategy] = useState(report?.git?.strategy ?? 'squash');
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);

  useEffect(() => {
    closeButton.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const focusable = [
          ...(dialog.current?.querySelectorAll<HTMLElement>(
            'button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
          ) ?? []),
        ];
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable.at(-1);

        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  if (!report) return null;
  const finish = async () => {
    let result = false;

    if (task.state === 'MERGED')
      result = await onAction(
        ['task', 'mark-released', task.id, '--evidence', evidence],
        'Task marked released',
      );
    else if (report.git?.enabled)
      result = await onAction(
        ['task', 'integrate', task.id, '--strategy', strategy, '--message', message],
        strategy === 'pr' || strategy === 'human' ? 'Integration handed off' : 'Task merged',
      );
    else if (task.revision)
      result = await onAction(['complete', task.id, '--revision', task.revision], 'Task completed');
    if (result) onClose();
  };

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        ref={dialog}
        className="create-task finalization-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="finalization-title"
      >
        <span className="eyebrow">Finalization gate</span>
        <h2 id="finalization-title">Finish work</h2>
        <div className="finalization-checks">
          {report.checks.map((item) => (
            <div
              className={`finalization-check ${item.passed ? 'passed' : item.blocking ? 'blocked' : 'warning'}`}
              key={item.id}
            >
              <span>{item.passed ? '✓' : item.blocking ? '!' : '○'}</span>
              <div>
                <strong>{item.label}</strong>
                <small>{item.detail}</small>
              </div>
            </div>
          ))}
        </div>
        {report.git?.enabled && task.state !== 'MERGED' && (
          <>
            <label>
              Integration strategy
              <select value={strategy} onChange={(event) => setStrategy(event.currentTarget.value)}>
                <option value="squash">Squash merge</option>
                <option value="merge">Merge commit</option>
                <option value="pr">Create PR / handoff</option>
                <option value="human">Human merge</option>
              </select>
            </label>
            <label>
              Commit message
              <input value={message} onChange={(event) => setMessage(event.currentTarget.value)} />
            </label>
          </>
        )}
        {task.state === 'MERGED' && (
          <label>
            Deployment evidence
            <input
              value={evidence}
              onChange={(event) => setEvidence(event.currentTarget.value)}
              placeholder="CI run, release URL, or note"
            />
          </label>
        )}
        {report.blockingReasons.length > 0 && (
          <p className="attention">{report.blockingReasons.join(' · ')}</p>
        )}
        <div className="modal-actions">
          <button ref={closeButton} className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="button primary"
            disabled={task.state === 'MERGED' ? !evidence : !report.ready}
            onClick={() => void finish()}
          >
            {task.state === 'MERGED'
              ? 'Mark released'
              : report.git?.enabled
                ? 'Integrate'
                : 'Complete task'}
          </button>
        </div>
      </section>
    </div>
  );
}

function AddProject({
  onClose,
  onAdd,
}: {
  onClose: () => void;
  onAdd: (folder: string, name: string) => Promise<void>;
}) {
  const [folder, setFolder] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: Event) => {
    event.preventDefault();
    if (!folder.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      await onAdd(folder.trim(), name.trim());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not add project');
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="create-task add-project" onSubmit={(event) => void submit(event)}>
        <div className="panel-head compact">
          <div>
            <span className="eyebrow">Local repository</span>
            <h2>Add project</h2>
          </div>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <label htmlFor="project-folder">Folder</label>
        <input
          id="project-folder"
          value={folder}
          onInput={(event) => setFolder(event.currentTarget.value)}
          placeholder="/Users/me/dev/clew"
          required
        />
        <label htmlFor="project-name">Project name</label>
        <input
          id="project-name"
          value={name}
          onInput={(event) => setName(event.currentTarget.value)}
          placeholder="Clew"
        />
        <p className="small-muted">
          The folder must be a local Git repository. Its repository root, default branch, and name
          are detected automatically.
        </p>
        {error && (
          <p className="add-project-error" role="alert">
            <AlertTriangle size={12} />
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? 'Adding…' : 'Add project'}
          </button>
        </div>
      </form>
    </div>
  );
}

const WORKFLOW_STEPS = [
  { key: 'plan', label: 'Plan' },
  { key: 'execute', label: 'Execute' },
  { key: 'review', label: 'Review' },
  { key: 'done', label: 'Done' },
] as const;

function workflowStepIndex(state: TaskState) {
  const stepOf: Record<TaskState, number> = {
    DRAFT: 0,
    PLAN_READY: 0,
    QUEUED: 1,
    RECOVERING: 1,
    EXECUTING: 1,
    VERIFYING: 1,
    REVIEWING: 2,
    WAITING_FOR_HUMAN: 2,
    READY: 3,
    READY_TO_FINISH: 3,
    MERGED: 3,
    RELEASED: 3,
    COMPLETED: 3,
    FAILED: -1,
    CANCELLED: -1,
    BLOCKED: -1,
  };

  return stepOf[state] ?? 0;
}

function StepIndicator({
  state,
  selected,
  onSelect,
}: {
  state: TaskState;
  selected: string;
  onSelect: (key: string) => void;
}) {
  const active = workflowStepIndex(state);

  return (
    <div className="stepper">
      {WORKFLOW_STEPS.map((step, i) => (
        <span key={step.key} style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
          {i > 0 && <span className="step-sep" />}
          <button
            type="button"
            onClick={() => onSelect(step.key)}
            aria-current={i === active ? 'step' : undefined}
            aria-pressed={selected === step.key}
            className={`${active < 0 ? 'step' : i < active ? 'step done' : i === active ? 'step active' : 'step'}${selected === step.key ? ' selected' : ''}`}
          >
            <span className="step-dot" />
            {step.label}
          </button>
        </span>
      ))}
    </div>
  );
}

type AgentConnectionId = 'codex' | 'claude' | 'opencode';

const AGENT_CONNECTIONS: { id: AgentConnectionId; label: string }[] = [
  { id: 'codex', label: 'Codex CLI' },
  { id: 'claude', label: 'Claude CLI' },
  { id: 'opencode', label: 'OpenCode CLI' },
];

const SETTINGS_CHAPTERS = [{ key: 'agent', label: 'Agent' }] as const;

type SettingsChapter = (typeof SETTINGS_CHAPTERS)[number]['key'];

function readAgentConnection(): AgentConnectionId | null {
  const stored = readPreference('agent-connection');

  return AGENT_CONNECTIONS.some((entry) => entry.id === stored)
    ? (stored as AgentConnectionId)
    : null;
}

function SettingsModal({ onClose }: { onClose: () => void }) {
  const [chapter, setChapter] = useState<SettingsChapter>('agent');
  const [connection, setConnection] = useState<AgentConnectionId | null>(() =>
    readAgentConnection(),
  );
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === 'Tab') {
        const focusable = [
          ...(dialogRef.current?.querySelectorAll<HTMLElement>(
            'button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
          ) ?? []),
        ];
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable.at(-1)!;

        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  const select = (id: AgentConnectionId) => {
    setConnection(id);
    writePreference('agent-connection', id);
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="create-task settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <div className="panel-head compact">
          <div>
            <span className="eyebrow">Settings</span>
            <h2>Settings</h2>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="icon-button"
            aria-label="Close settings"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>
        <div className="settings-layout">
          <nav className="settings-chapters" aria-label="Settings chapters">
            {SETTINGS_CHAPTERS.map((entry) => (
              <button
                key={entry.key}
                type="button"
                className={`settings-chapter${chapter === entry.key ? ' active' : ''}`}
                aria-current={chapter === entry.key}
                onClick={() => setChapter(entry.key)}
              >
                {entry.label}
              </button>
            ))}
          </nav>
          {chapter === 'agent' && (
            <div className="settings-chapter-panel">
              <p className="settings-notice">
                Pick a preferred agent connection. This choice is stored on this device only —
                nothing here is tested against your machine, and it does not change how tasks run
                yet.
              </p>
              <div className="agent-connections" role="group" aria-label="Agent connections">
                {AGENT_CONNECTIONS.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className={`agent-connection${connection === entry.id ? ' selected' : ''}`}
                    aria-pressed={connection === entry.id}
                    onClick={() => select(entry.id)}
                  >
                    <span className="agent-connection-label">{entry.label}</span>
                    {connection === entry.id && (
                      <span className="agent-connection-mark">
                        <Check size={12} /> Selected
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [route, setRoute] = useState<Route>(() => routeFromLocation());
  const [connection, setConnection] = useState<ConnectionState>('reconnecting');
  const [diagnostic, setDiagnostic] = useState(false);
  const [notice, setNotice] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [finishOpen, setFinishOpen] = useState(false);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    settingsButtonRef.current?.focus();
  }, []);
  const [nextStep, setNextStep] = useState<NextStep | null>(null);
  const [selectedStep, setSelectedStep] = useState('plan');
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [descExpanded, setDescExpanded] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [changesByRun, setChangesByRun] = useState<Record<string, ChangeLoad>>({});
  const [diffRunId, setDiffRunId] = useState<string | null>(null);
  const [selectedChangeRunId, setSelectedChangeRunId] = useState<string | null>(null);
  const [runRequested, setRunRequested] = useState(false);
  const autoOpenedTerminal = useRef<string | null>(null);
  const changeRequestSequence = useRef<Record<string, number>>({});
  const lastCursor = useRef(Number(sessionStorage.getItem('clew-event-cursor') ?? 0));
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const refreshTimer = useRef<number | undefined>(undefined);
  const routeRef = useRef(route);
  routeRef.current = route;

  useEffect(() => {
    const onPopState = () => setRoute(routeFromLocation());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const refresh = useCallback(() => {
    if (refreshInFlight.current) return refreshInFlight.current;
    const operation = loadTasks().then(
      ({ tasks: nextTasks, projects: nextProjects = [], state }) => {
        setConnection(state);
        if (state === 'connected' || state === 'fixture') {
          setTasks(nextTasks);
          setProjects(nextProjects);
          setLastUpdatedAt(new Date());
          const resolved = resolveDefaultRoute(routeRef.current, nextProjects, nextTasks);
          const changed =
            resolved.projectId !== routeRef.current.projectId ||
            resolved.taskId !== routeRef.current.taskId ||
            resolved.view !== routeRef.current.view;

          if (changed) {
            const path = routePath(resolved.projectId!, resolved.taskId, resolved.view);

            setRoute(resolved);
            if (window.location.pathname !== path) window.history.replaceState({}, '', path);
          }
        }
      },
    );
    refreshInFlight.current = operation.finally(() => {
      refreshInFlight.current = null;
    });
    return refreshInFlight.current;
  }, []);

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

  const project = useMemo(() => {
    if (route.projectId) {
      const direct = projects.find((entry) => entry.id === route.projectId);
      if (direct) return direct;
    }
    if (route.taskId) {
      const ownerId = tasks.find((entry) => entry.id === route.taskId)?.projectId ?? null;
      const owner = ownerId ? projects.find((entry) => entry.id === ownerId) : null;
      if (owner) return owner;
    }
    const stored = storedProjectId();
    if (stored) {
      const candidate = projects.find((entry) => entry.id === stored);
      if (candidate) return candidate;
    }
    return projects[0] ?? null;
  }, [projects, tasks, route.projectId, route.taskId]);

  const projectTasks = useMemo(
    () => (project ? scopedTasks(tasks, project.id) : []),
    [tasks, project],
  );

  const awareness = useMemo(() => {
    const map: Record<string, ProjectAwareness> = {};

    for (const p of projects) map[p.id] = projectAwareness(tasks, p.id);

    return map;
  }, [tasks, projects]);

  const attentionItems = useMemo(() => globalAttention(tasks, projects), [tasks, projects]);

  const task = useMemo(() => {
    if (!project || route.view === 'overview') return null;
    if (route.taskId) {
      const direct = projectTasks.find((entry) => entry.id === route.taskId);
      if (direct) return direct;
    }
    const stored = storedTaskId(project.id);
    const fromStored = stored ? projectTasks.find((entry) => entry.id === stored) : null;

    return fromStored ?? projectTasks[0] ?? null;
  }, [project, projectTasks, route.taskId, route.view]);

  const selectProject = (projectId: string) => {
    writePreference('current-project', projectId);
    const targetTasks = scopedTasks(tasks, projectId);
    const last = storedTaskId(projectId);
    const taskId =
      last && targetTasks.some((entry) => entry.id === last) ? last : (targetTasks[0]?.id ?? null);
    setStatusFilter(null);
    setRoute({ projectId, taskId, view: 'tasks' });
    const path = routePath(projectId, taskId, 'tasks');
    if (window.location.pathname !== path) window.history.pushState({}, '', path);
  };

  const selectTask = (taskId: string) => {
    if (!project) return;
    writePreference(`last-task.${project.id}`, taskId);
    setRoute({ projectId: project.id, taskId, view: 'tasks' });
    const path = routePath(project.id, taskId, 'tasks');
    if (window.location.pathname !== path) window.history.pushState({}, '', path);
  };

  const selectView = (nextView: 'overview' | 'tasks') => {
    if (!project) return;
    const taskId = nextView === 'overview' ? null : (task?.id ?? null);
    setRoute({ projectId: project.id, taskId, view: nextView });
    const path = routePath(project.id, taskId, nextView);
    if (window.location.pathname !== path) window.history.pushState({}, '', path);
  };

  const selectProjectAndTask = (projectId: string, taskId: string | null) => {
    writePreference('current-project', projectId);
    if (taskId) writePreference(`last-task.${projectId}`, taskId);
    const targetTasks = scopedTasks(tasks, projectId);
    const resolvedTaskId =
      taskId && targetTasks.some((entry) => entry.id === taskId)
        ? taskId
        : (targetTasks[0]?.id ?? null);
    setStatusFilter(null);
    setRoute({ projectId, taskId: resolvedTaskId, view: 'tasks' });
    const path = routePath(projectId, resolvedTaskId, 'tasks');
    if (window.location.pathname !== path) window.history.pushState({}, '', path);
  };

  const addProject = async (folder: string, name: string) => {
    try {
      const result = await execute(['project', 'add', folder, ...(name ? ['--name', name] : [])]);
      if ((result as { fixture?: boolean } | null)?.fixture) {
        const id = `PRJ-${Date.now()}`;
        const created: Project = {
          id,
          name: name || folder.split('/').filter(Boolean).pop() || 'Project',
          localPath: folder,
          repositoryRoot: folder,
          defaultBranch: 'main',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        setProjects((current) => [...current, created]);
        setNotice(`Project added: ${created.name}`);
        setAddProjectOpen(false);
        selectProject(id);
      } else {
        await refresh();
        const created = result as { id?: string } | null;
        if (created?.id) {
          setNotice('Project added');
          setAddProjectOpen(false);
          selectProject(created.id);
        } else setNotice('Project added');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not add project';

      setNotice(message);
      throw new Error(message);
    }
  };

  useEffect(() => {
    setSelectedChangeRunId((current) => {
      if (current && task?.runs.some((run) => run.id === current)) return current;
      return task?.runId && task.runs.some((run) => run.id === task.runId)
        ? task.runId
        : (task?.runs.at(-1)?.id ?? null);
    });
  }, [task?.id, task?.runId]);

  const refreshRunChanges = useCallback(async (runId: string) => {
    const sequence = (changeRequestSequence.current[runId] ?? 0) + 1;

    changeRequestSequence.current[runId] = sequence;
    setChangesByRun((current) => ({
      ...current,
      [runId]: { ...current[runId], loading: true, error: undefined },
    }));
    try {
      const value = await execute(['task', 'changes', runId]);
      const result = value as ChangeInspection & { fixture?: boolean };

      if (changeRequestSequence.current[runId] !== sequence) return;
      if (result?.fixture)
        setChangesByRun((current) => ({
          ...current,
          [runId]: {
            loading: false,
            result: {
              version: 1,
              runId,
              state: 'unavailable',
              reason: 'fixture-unavailable',
              summary: { files: 0, additions: 0, deletions: 0 },
              files: [],
              statuses: [],
              patch: '',
              binary: false,
              dirty: false,
              revisions: { base: null, head: null },
            },
          },
        }));
      else if (result?.runId === runId && ['available', 'unavailable'].includes(result.state))
        setChangesByRun((current) => ({
          ...current,
          [runId]: { loading: false, result },
        }));
      else throw new Error('Change inspection response is incompatible');
    } catch (error) {
      if (changeRequestSequence.current[runId] !== sequence) return;
      setChangesByRun((current) => ({
        ...current,
        [runId]: {
          loading: false,
          error: error instanceof Error ? error.message : 'Could not inspect changes',
        },
      }));
    }
  }, []);

  const runStateSignature = task?.runs.map((run) => `${run.id}:${run.status}`).join('|') ?? '';

  useEffect(() => {
    if (!task) return;
    for (const run of task.runs) void refreshRunChanges(run.id);
  }, [refreshRunChanges, runStateSignature, task?.id]);

  useEffect(() => {
    if (!task) return undefined;
    const activeRunIds = task.runs.filter((run) => run.status === 'RUNNING').map((run) => run.id);

    if (!activeRunIds.length) return undefined;
    const timer = window.setInterval(() => {
      for (const runId of activeRunIds) void refreshRunChanges(runId);
    }, 2_000);

    return () => window.clearInterval(timer);
  }, [refreshRunChanges, runStateSignature, task?.id]);

  useEffect(() => {
    if (task?.terminalActive && task.runId && autoOpenedTerminal.current !== task.runId) {
      autoOpenedTerminal.current = task.runId;
      const currentRun = task.runs.find((run) => run.id === task.runId);

      setExpandedAgent(
        currentRun && currentRun.stageId !== 'worker' ? `worker:${currentRun.stageId}` : 'worker',
      );
    }
  }, [task?.runId, task?.runs, task?.terminalActive]);

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

  const sortedTasks = useMemo(() => {
    const list = statusFilter
      ? projectTasks.filter((t) => {
          if (statusFilter === 'waiting') return statusGroup[t.state] === 'waiting';
          if (statusFilter === 'error') return statusGroup[t.state] === 'error';
          if (statusFilter === 'active') return statusGroup[t.state] === 'active';
          if (statusFilter === 'other') return statusGroup[t.state] === 'other';
          return true;
        })
      : projectTasks;
    return [...list].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
  }, [projectTasks, statusFilter]);

  const createTask = async ({ title, body, profile, tags }: CreateTaskInput) => {
    if (!canMutateFor(connection)) {
      setNotice('Actions are disabled while the control plane is disconnected');
      return;
    }
    const tagList = tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const args = [
      'task',
      'create',
      ...(project ? ['--project', project.id] : []),
      '--title',
      title,
      '--description',
      body,
      '--profile',
      profile,
      ...tagList.flatMap((tag) => ['--tags', tag]),
    ];
    try {
      const result = await execute(args);
      if ((result as { fixture?: boolean } | null)?.fixture) {
        const id = `LOCAL-${Date.now()}`;
        setTasks((current) => [
          {
            id,
            projectId: project?.id ?? null,
            createdAt: new Date().toISOString(),
            title,
            goal: body,
            profile,
            tags: tagList,
            analysis: {
              version: 1,
              kind: { value: 'feature', confidence: 0.62 },
              readiness: {
                score: 50,
                readyToStart: false,
                unresolved: ['Acceptance criteria are distinct and testable'],
              },
              recommendation: {
                action: 'shape' as const,
                profile: 'standard' as const,
                reasons: ['1 readiness check(s) unresolved'],
              },
            },
            state: 'DRAFT' as TaskState,
            attention: null,
            revision: null,
            attempts: 0,
            roles: rolesForProfile('standard'),
            runs: [],
            stages: [],
            reviewed: false,
            findings: 0,
            agentSessions: [],
            thread: {
              version: 1,
              items: [],
              nextCursor: null,
              hasMore: false,
              redaction: 'public-safe' as const,
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

  if (!project) {
    const unavailable = connection === 'disconnected' || connection === 'incompatible';
    const waiting = connection === 'reconnecting';
    return (
      <div className="app">
        <header className="topbar">
          <Logo />
          <div className="topbar-right">
            <Connection state={connection} />
            <button
              ref={settingsButtonRef}
              className="icon-button"
              aria-label="Settings"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings size={14} />
            </button>
          </div>
        </header>
        <main className="empty">
          {unavailable ? <WifiOff size={24} /> : <Inbox size={24} />}
          <h1>
            {unavailable
              ? 'Control plane unavailable'
              : waiting
                ? 'Connecting…'
                : 'Welcome to Clew'}
          </h1>
          <p>
            {connection === 'incompatible'
              ? 'This UI cannot safely read the daemon response. Update Clew and reload.'
              : connection === 'disconnected'
                ? 'Start the local daemon, then retry the connection.'
                : waiting
                  ? 'Loading your projects.'
                  : 'Add a local Git project to start managing agentic development.'}
          </p>
          <div className="empty-actions">
            {unavailable || waiting ? (
              <button className="button secondary" onClick={() => void refresh()}>
                <RefreshCw size={14} /> Retry
              </button>
            ) : (
              <button className="button primary" onClick={() => setAddProjectOpen(true)}>
                <Plus size={14} /> Add project
              </button>
            )}
          </div>
        </main>
        {!unavailable && !waiting && addProjectOpen && (
          <AddProject onClose={() => setAddProjectOpen(false)} onAdd={addProject} />
        )}
        {settingsOpen && <SettingsModal onClose={closeSettings} />}
      </div>
    );
  }

  if (!projectTasks.length) {
    return (
      <div className="app">
        <header className="topbar">
          <Logo />
          <div className="topbar-right">
            <Connection state={connection} />
            <GlobalAttention items={attentionItems} onSelect={selectProjectAndTask} />
            <button
              ref={settingsButtonRef}
              className="icon-button"
              aria-label="Settings"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings size={14} />
            </button>
          </div>
        </header>
        <div className="workspace">
          <ProjectSidebar
            projects={projects}
            projectId={project.id}
            view={route.view}
            tasks={[]}
            selectedTaskId={null}
            statusFilter={statusFilter}
            awareness={awareness}
            onSelectProject={selectProject}
            onSelectView={selectView}
            onSelectTask={selectTask}
            onSetStatusFilter={setStatusFilter}
            onCreateTask={() => setCreateOpen(true)}
            onAddProject={() => setAddProjectOpen(true)}
          />
          <main className="content">
            <div className="content-inner">
              <div className="empty">
                <Inbox size={24} />
                <h1>No tasks yet</h1>
                <p>{project.name}</p>
                <div className="empty-actions">
                  <button className="button primary" onClick={() => setCreateOpen(true)}>
                    <Check size={14} /> New task
                  </button>
                </div>
              </div>
            </div>
          </main>
        </div>
        {createOpen && <CreateTask onClose={() => setCreateOpen(false)} onCreate={createTask} />}
        {addProjectOpen && (
          <AddProject onClose={() => setAddProjectOpen(false)} onAdd={addProject} />
        )}
        {settingsOpen && <SettingsModal onClose={closeSettings} />}
        <CommandPalette projects={projects} tasks={tasks} onSelect={selectProjectAndTask} />
      </div>
    );
  }

  if (route.view === 'overview') {
    return (
      <div className="app">
        <header className="topbar">
          <Logo />
          <div className="topbar-right">
            <Connection state={connection} />
            <GlobalAttention items={attentionItems} onSelect={selectProjectAndTask} />
            <button
              ref={settingsButtonRef}
              className="icon-button"
              aria-label="Settings"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings size={14} />
            </button>
            <button
              className="icon-button"
              aria-label="Refresh tasks"
              onClick={() => void refresh()}
            >
              <RefreshCw size={14} />
            </button>
            <span className="avatar">LC</span>
          </div>
        </header>
        <div className="workspace">
          <ProjectSidebar
            projects={projects}
            projectId={project.id}
            view="overview"
            tasks={sortedTasks}
            selectedTaskId={task?.id ?? null}
            statusFilter={statusFilter}
            awareness={awareness}
            onSelectProject={selectProject}
            onSelectView={selectView}
            onSelectTask={selectTask}
            onSetStatusFilter={setStatusFilter}
            onCreateTask={() => setCreateOpen(true)}
            onAddProject={() => setAddProjectOpen(true)}
          />
          <main className="content">
            <div className="content-inner">
              <Overview
                project={project}
                tasks={projectTasks}
                onSelectTask={selectTask}
                onCreateTask={() => setCreateOpen(true)}
              />
            </div>
          </main>
        </div>
        {createOpen && <CreateTask onClose={() => setCreateOpen(false)} onCreate={createTask} />}
        {addProjectOpen && (
          <AddProject onClose={() => setAddProjectOpen(false)} onAdd={addProject} />
        )}
        {settingsOpen && <SettingsModal onClose={closeSettings} />}
        <CommandPalette projects={projects} tasks={tasks} onSelect={selectProjectAndTask} />
      </div>
    );
  }

  // The tasks view is reached only with a non-empty project task list, where
  // the memo falls back to the first task. Narrow for the render path below.
  if (!task) return null;

  const canMutate = connection === 'connected' || connection === 'fixture';
  const act = async (args: string[], success: string) => {
    if (!canMutate) {
      setNotice('Actions are disabled while the control plane is disconnected');
      return false;
    }
    const confirmationRequired = new Set([
      'approve',
      'approve-run',
      'complete',
      'continue',
      'reject-run',
      'retry',
      'run',
    ]);
    if (
      (confirmationRequired.has(args[0]) ||
        (args[0] === 'task' &&
          ['approve-step', 'integrate', 'mark-merged', 'mark-released'].includes(args[1]))) &&
      !window.confirm(`Confirm ${args.join(' ')}?`)
    )
      return false;
    if (args[0] === 'run') setRunRequested(true);
    try {
      const result = await execute(args);
      if ((result as { fixture?: boolean } | null)?.fixture) {
        if (args[0] === 'run') setRunRequested(false);
        setTasks((current) =>
          current.map((entry) => {
            if (entry.id !== task.id) return entry;
            if (args[0] === 'complete') return { ...entry, state: 'COMPLETED' as TaskState };
            if (args[0] === 'approve')
              return { ...entry, state: 'PLAN_READY' as TaskState, attention: null };
            if (args[0] === 'run') return { ...entry, state: 'EXECUTING' as TaskState };
            if (args[0] === 'finish-worker') return { ...entry, state: 'VERIFYING' as TaskState };
            if (args[0] === 'task' && args[1] === 'approve-step')
              return { ...entry, state: 'EXECUTING' as TaskState };
            if (args[0] === 'retry') return { ...entry, state: 'RECOVERING' as TaskState };
            if (args[0] === 'continue')
              return { ...entry, state: 'RECOVERING' as TaskState, attention: null };
            return entry;
          }),
        );
      } else {
        await refresh();
      }
      setNotice(success);
      await refresh();
      return true;
    } catch (error) {
      if (args[0] === 'run') setRunRequested(false);
      setNotice(error instanceof Error ? error.message : 'Action failed');
      return false;
    }
  };

  const canStart = ['DRAFT', 'PLAN_READY', 'QUEUED'].includes(task.state);
  const canContinue =
    task.state === 'READY' ||
    (task.state === 'WAITING_FOR_HUMAN' && task.attention !== 'PLAN_APPROVAL_REQUIRED');
  const interactiveWorker =
    task.runStatus === 'RUNNING' && task.terminalActive === true && Boolean(task.runId);
  const pendingHarnessApproval = task.harnessApprovals?.find((a) => !a.decision);
  const recommendedActionLabel = task.analysis
    ? {
        shape: 'Shape task',
        investigate: 'Investigate',
        plan: 'Plan',
        start: 'Start',
      }[task.analysis.recommendation.action]
    : 'Analyze task';

  const explainNextStep = async () => {
    try {
      const result = await execute(['task', 'next-step', task.id]);
      if ((result as { fixture?: boolean } | null)?.fixture) {
        setNextStep({
          taskId: task.id,
          kind: 'start_worker',
          currentStep: 'DRAFT',
          resultingStep: 'EXECUTING',
          summary: 'Start one read-only worker for this task',
          inputs: { harness: 'codex', model: 'default', permissionMode: 'read-only' },
          sideEffects: ['start one local worker process', 'create one run record'],
          approvalRequired: true,
          status: 'PENDING',
        });
      } else setNextStep(result as NextStep);
      setNotice('Next step is ready for review');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not explain next step');
    }
  };

  const runViewerAction = async (run: Run, viewer?: 'cursor' | 'vscode' | 'worktree-path') => {
    try {
      const result = (await execute([
        'task',
        'open-changes',
        task.id,
        '--run',
        run.id,
        ...(viewer ? ['--viewer', viewer] : []),
      ])) as { fixture?: boolean; state?: string; reason?: string };

      if (result?.state === 'unavailable') setNotice(changeUnavailableLabel(result.reason));
      else setNotice(viewer === 'worktree-path' ? 'Worktree path copied' : 'Opened in editor');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not open changes');
    }
  };

  const viewRunDiff = (run: Run) => {
    setDiffRunId(run.id);
    void refreshRunChanges(run.id);
  };

  const diffRun = task.runs.find((run) => run.id === diffRunId);
  const latestTaskRun = task.runs.at(-1);
  const changeRun = task.runs.find((run) => run.id === selectedChangeRunId) ?? latestTaskRun;
  const selectedWorkflowIndex = WORKFLOW_STEPS.findIndex((step) => step.key === selectedStep);
  const currentWorkflowIndex = workflowStepIndex(task.state);
  const selectedStepStatus =
    currentWorkflowIndex < 0
      ? task.state.toLowerCase().replaceAll('_', ' ')
      : selectedWorkflowIndex < currentWorkflowIndex
        ? 'completed'
        : selectedWorkflowIndex === currentWorkflowIndex
          ? 'current'
          : 'pending';
  const stepDetail =
    selectedStep === 'plan'
      ? {
          explanation: 'Define the execution stages and approve the plan before work starts.',
          prerequisites: 'A valid task contract.',
          action:
            task.attention === 'PLAN_APPROVAL_REQUIRED'
              ? 'Approve the proposed plan'
              : 'No action required',
          approval: task.attention === 'PLAN_APPROVAL_REQUIRED' ? 'Required' : 'Not required',
          sideEffects: 'Persists the approved execution plan; does not modify the repository.',
        }
      : selectedStep === 'execute'
        ? {
            explanation:
              nextStep?.summary ?? 'Run the selected profile in isolated agent worktrees.',
            prerequisites: 'Approved plan and an available execution environment.',
            action:
              nextStep?.status === 'PENDING'
                ? 'Approve start'
                : task.state === 'EXECUTING'
                  ? 'Continue in the active terminal'
                  : 'Inspect the next-step state',
            approval: nextStep?.approvalRequired ? 'Required' : 'Depends on the task state',
            sideEffects:
              nextStep?.sideEffects?.join('; ') ??
              'Creates run records and isolated worktrees; never merges or pushes automatically.',
          }
        : selectedStep === 'review'
          ? {
              explanation:
                'Inspect worker evidence, revisions, findings, and requested corrections.',
              prerequisites: 'At least one completed worker run.',
              action: task.findings ? 'Resolve review findings' : 'Inspect review evidence',
              approval:
                task.state === 'WAITING_FOR_HUMAN' ? 'Operator action required' : 'Not required',
              sideEffects: 'Records review evidence or schedules a bounded retry.',
            }
          : {
              explanation: 'Accept the verified revision and finish the task lifecycle.',
              prerequisites: 'READY state and a verified revision.',
              action: task.state === 'READY' ? 'Complete task' : 'No action available',
              approval:
                task.state === 'READY' ? 'Explicit operator action required' : 'Not available',
              sideEffects:
                'Records completion only; does not merge, push, or alter the primary checkout.',
            };

  return (
    <div className="app">
      <header className="topbar">
        <Logo />
        <div className="topbar-right">
          <Connection state={connection} />
          <GlobalAttention items={attentionItems} onSelect={selectProjectAndTask} />
          <button
            ref={settingsButtonRef}
            className="icon-button"
            aria-label="Settings"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings size={14} />
          </button>
          <button className="icon-button" aria-label="Refresh tasks" onClick={() => void refresh()}>
            <RefreshCw size={14} />
          </button>
          <span className="avatar">LC</span>
        </div>
      </header>
      <div className="workspace">
        <ProjectSidebar
          projects={projects}
          projectId={project.id}
          view="tasks"
          tasks={sortedTasks}
          selectedTaskId={task.id}
          statusFilter={statusFilter}
          awareness={awareness}
          onSelectProject={selectProject}
          onSelectView={selectView}
          onSelectTask={selectTask}
          onSetStatusFilter={setStatusFilter}
          onCreateTask={() => setCreateOpen(true)}
          onAddProject={() => setAddProjectOpen(true)}
        />
        <main className="content">
          <div className="content-inner">
            <section className="task-header">
              <div className="eyebrow">
                <button className="breadcrumb-project" onClick={() => selectView('tasks')}>
                  {project.name}
                </button>
                <span className="eyebrow-slash">/</span>
                {task.id}
                <span className="eyebrow-tag">{task.profile}</span>
              </div>
              <div className="task-title-row">
                <div className="task-title-copy">
                  <h1>{task.title}</h1>
                </div>
                <div className="header-actions">
                  {task.runs.length > 1 && (
                    <label className="change-run-select">
                      <span className="sr-only">Select change run</span>
                      <select
                        aria-label="Select change run"
                        value={changeRun?.id ?? ''}
                        onChange={(event) => setSelectedChangeRunId(event.currentTarget.value)}
                      >
                        {task.runs.map((run) => (
                          <option value={run.id} key={run.id}>
                            {run.stageId} · attempt {run.attempt}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <ChangeActions
                    run={changeRun}
                    changes={changeRun ? changesByRun[changeRun.id] : undefined}
                    disabled={!canMutate}
                    onOpenEditor={() => changeRun && void runViewerAction(changeRun)}
                    onViewDiff={() => changeRun && viewRunDiff(changeRun)}
                    onCopyPath={() => changeRun && void runViewerAction(changeRun, 'worktree-path')}
                    onRefresh={() => changeRun && void refreshRunChanges(changeRun.id)}
                  />
                  <button
                    className="button secondary"
                    disabled={!canMutate || (!interactiveWorker && !canStart && !canContinue)}
                    onClick={() => {
                      if (interactiveWorker)
                        return void act(
                          ['finish-worker', task.id, '--run', task.runId!],
                          'Worker is finishing',
                        );
                      if (canContinue)
                        return void act(
                          ['continue', task.id, '--message', 'Continue task'],
                          'Continuation requested',
                        );
                      if (nextStep?.status === 'PENDING')
                        return void act(
                          ['task', 'approve-step', task.id, '--action', nextStep.id ?? ''],
                          'Start approved',
                        );
                      return void explainNextStep();
                    }}
                  >
                    {interactiveWorker ? <Check size={13} /> : <RefreshCw size={13} />}
                    {interactiveWorker
                      ? 'Finish worker'
                      : canContinue
                        ? 'Continue'
                        : nextStep?.status === 'PENDING'
                          ? 'Approve start'
                          : 'Next step'}
                  </button>
                  <button
                    className="button primary"
                    disabled={
                      !canMutate ||
                      !['READY', 'READY_TO_FINISH', 'MERGED'].includes(task.state) ||
                      !task.finalization
                    }
                    onClick={() => setFinishOpen(true)}
                  >
                    <Check size={13} /> {task.state === 'MERGED' ? 'Mark released' : 'Finish work'}
                  </button>
                </div>
              </div>
              <button className="description-toggle" onClick={() => setDescExpanded(!descExpanded)}>
                {descExpanded ? '▾' : '▸'} Description
              </button>
              {descExpanded && <p className="description-text">{task.goal}</p>}
              {task.state === 'DRAFT' && task.analysis && (
                <section className="task-recommendation" aria-label="Recommended next action">
                  <div>
                    <span className="eyebrow">Recommended next action</span>
                    <h3>{recommendedActionLabel}</h3>
                    <p>{task.analysis.recommendation.reasons.join(' · ')}</p>
                  </div>
                  <div className="recommendation-meta">
                    <span>{task.analysis.kind.value}</span>
                    <span>Readiness {task.analysis.readiness.score}%</span>
                    <span>{task.analysis.recommendation.profile}</span>
                  </div>
                  <button
                    className="button primary small"
                    disabled={!canMutate}
                    onClick={() => {
                      if (nextStep?.status === 'PENDING')
                        void act(
                          ['task', 'approve-step', task.id, '--action', nextStep.id ?? ''],
                          'Recommended action started',
                        );
                      else void explainNextStep();
                    }}
                  >
                    {nextStep?.status === 'PENDING'
                      ? `Start ${nextStep.inputs?.profile ?? task.analysis.recommendation.profile}`
                      : recommendedActionLabel}
                  </button>
                </section>
              )}
              {task.finalization && task.state !== 'DRAFT' && (
                <section
                  className="task-recommendation finalization-recommendation"
                  aria-label="Finalization gate"
                >
                  <div>
                    <span className="eyebrow">Finalization gate</span>
                    <h3>{task.finalization.ready ? 'Ready to finish' : 'Attention required'}</h3>
                    <p>
                      {task.finalization.ready
                        ? 'Verification, review, and workspace checks are complete.'
                        : task.finalization.blockingReasons.join(' · ') ||
                          'Inspect the checks before finishing.'}
                    </p>
                  </div>
                  <div className="recommendation-meta">
                    {task.finalization.checks.map((item) => (
                      <span key={item.id}>
                        {item.passed ? '✓' : '○'} {item.label}
                      </span>
                    ))}
                  </div>
                </section>
              )}
              <StepIndicator
                state={task.state}
                selected={selectedStep}
                onSelect={(key) => {
                  setSelectedStep(key);
                  if (key === 'execute' && !nextStep) void explainNextStep();
                }}
              />
              <section className="step-details" aria-label={`${selectedStep} step details`}>
                <span className="eyebrow">Selected step</span>
                <h3>
                  {selectedStep === 'plan'
                    ? 'Plan'
                    : selectedStep === 'execute'
                      ? 'Execute'
                      : selectedStep === 'review'
                        ? 'Review'
                        : 'Done'}
                </h3>
                <p>{stepDetail.explanation}</p>
                <dl className="step-detail-grid">
                  <div>
                    <dt>Status</dt>
                    <dd>{selectedStepStatus}</dd>
                  </div>
                  <div>
                    <dt>Prerequisites</dt>
                    <dd>{stepDetail.prerequisites}</dd>
                  </div>
                  <div>
                    <dt>Available action</dt>
                    <dd>{stepDetail.action}</dd>
                  </div>
                  <div>
                    <dt>Approval</dt>
                    <dd>{stepDetail.approval}</dd>
                  </div>
                  <div>
                    <dt>Side effects</dt>
                    <dd>{stepDetail.sideEffects}</dd>
                  </div>
                </dl>
                {selectedStep === 'execute' && nextStep && (
                  <div className="next-step-details">
                    <span>
                      {nextStep.currentStep} → {nextStep.resultingStep ?? '—'}
                    </span>
                    <span>
                      Harness: {nextStep.inputs?.harness ?? '—'} · Model:{' '}
                      {nextStep.inputs?.model ?? '—'}
                    </span>
                  </div>
                )}
              </section>
              {(task.attention || pendingHarnessApproval) && (
                <div className="attention-actions">
                  <span className="attention-label">
                    <AlertTriangle size={13} />
                    Attention
                  </span>
                  {task.attention === 'PLAN_APPROVAL_REQUIRED' && (
                    <>
                      <span className="attention-text">Plan approval required</span>
                      <button
                        className="button primary small"
                        disabled={!canMutate}
                        onClick={() => act(['approve', task.id], 'Plan approved')}
                      >
                        Approve plan
                      </button>
                    </>
                  )}
                  {task.state === 'WAITING_FOR_HUMAN' &&
                    task.attention !== 'PLAN_APPROVAL_REQUIRED' && (
                      <span className="attention-text">Operator input required</span>
                    )}
                  {pendingHarnessApproval && (
                    <>
                      <span className="attention-text">
                        Worker approval ·{' '}
                        <span className="mono">
                          {String(
                            pendingHarnessApproval.params.command ?? pendingHarnessApproval.method,
                          )}
                        </span>
                      </span>
                      <button
                        className="button primary small"
                        disabled={!canMutate}
                        onClick={() =>
                          act(
                            ['approve-run', pendingHarnessApproval.id],
                            'Worker approval accepted',
                          )
                        }
                      >
                        Approve
                      </button>
                      <button
                        className="button secondary small"
                        disabled={!canMutate}
                        onClick={() =>
                          act(['reject-run', pendingHarnessApproval.id], 'Worker approval rejected')
                        }
                      >
                        Reject
                      </button>
                    </>
                  )}
                </div>
              )}
              <div className="metrics">
                <div className="metric">
                  <span className="metric-label">Revision</span>
                  <span className="metric-value">{task.revision ?? '—'}</span>
                </div>
                <div className="metric">
                  <span className="metric-label">Review</span>
                  <span className="metric-value">
                    {!task.reviewed
                      ? 'Pending'
                      : task.findings
                        ? `${task.findings} findings`
                        : 'Passed'}
                  </span>
                </div>
                <div className="metric">
                  <span className="metric-label">Runs</span>
                  <span className="metric-value">{task.attempts}</span>
                </div>
                <div className="metric">
                  <span className="metric-label">Profile</span>
                  <span className="metric-value">{task.profile}</span>
                </div>
              </div>
            </section>

            {(notice || task.interactionStatus === 'waiting_for_operator') && (
              <div
                className="notice status-notice"
                role={task.interactionStatus === 'waiting_for_operator' ? 'status' : undefined}
              >
                {task.interactionStatus === 'waiting_for_operator' ? (
                  <SquareTerminal size={18} />
                ) : (
                  <CircleHelp size={14} />
                )}
                <div>
                  <strong>
                    {task.interactionStatus === 'waiting_for_operator'
                      ? 'Terminal is waiting for you'
                      : notice}
                  </strong>
                  {task.interactionStatus === 'waiting_for_operator' && (
                    <p>
                      The worker returned a response. Continue in the terminal or finish the worker.
                    </p>
                  )}
                </div>
                {task.interactionStatus !== 'waiting_for_operator' && (
                  <button onClick={() => setNotice('')} aria-label="Dismiss">
                    <X size={12} />
                  </button>
                )}
                {task.interactionStatus === 'waiting_for_operator' &&
                  task.terminalAvailable &&
                  task.runId &&
                  task.terminalAccess !== 'runner_local' && (
                    <button className="text-button" onClick={() => setExpandedAgent('worker')}>
                      Open terminal <ChevronRight size={14} />
                    </button>
                  )}
              </div>
            )}

            {(connection === 'disconnected' || connection === 'incompatible') && (
              <div className="connection-banner" role="alert">
                <WifiOff size={14} />
                {connection === 'incompatible'
                  ? 'Daemon contract is incompatible. Actions are disabled.'
                  : `Daemon connection is unavailable. Showing last known data${lastUpdatedAt ? ` from ${lastUpdatedAt.toLocaleTimeString()}` : ''}; actions are disabled.`}
              </div>
            )}

            <AgentGrid
              task={task}
              canMutate={canMutate}
              act={act}
              expandedAgent={expandedAgent}
              onToggleExpand={(agent) =>
                setExpandedAgent((current) => (current === agent ? null : agent))
              }
            />

            <div className="main-grid">
              <section className="panel thread-panel">
                <div className="panel-head">
                  <div>
                    <span className="eyebrow">Activity</span>
                    <h2>Thread</h2>
                  </div>
                  <button
                    className={`toggle ${diagnostic ? 'active' : ''}`}
                    onClick={() => setDiagnostic(!diagnostic)}
                  >
                    {diagnostic ? 'Thread view' : 'Diagnostic'} <ArrowUpRight size={12} />
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
              </aside>
            </div>
          </div>
        </main>
      </div>
      {diffRun && (
        <DiffViewer
          run={diffRun}
          changes={changesByRun[diffRun.id]}
          onRefresh={() => void refreshRunChanges(diffRun.id)}
          onClose={() => setDiffRunId(null)}
        />
      )}
      {createOpen && <CreateTask onClose={() => setCreateOpen(false)} onCreate={createTask} />}
      {finishOpen && task.finalization && (
        <FinalizationGate task={task} onClose={() => setFinishOpen(false)} onAction={act} />
      )}
      {addProjectOpen && <AddProject onClose={() => setAddProjectOpen(false)} onAdd={addProject} />}
      {settingsOpen && <SettingsModal onClose={closeSettings} />}
      <CommandPalette projects={projects} tasks={tasks} onSelect={selectProjectAndTask} />
    </div>
  );
}

function canMutateFor(connection: ConnectionState) {
  return connection === 'connected' || connection === 'fixture';
}
