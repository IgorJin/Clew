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
  FolderOpen,
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
import {
  indexShortcuts,
  isTerminalElement,
  isTextEntryElement,
  optionModifierLabel,
  primaryModifierLabel,
  useShortcuts,
  type KeyCombo,
  type Shortcut,
  type ShortcutMetadata,
  type ShortcutScope,
} from './shortcuts';
import { useCommandHold } from './commandHold';

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

const complexityLevel: Record<string, number> = {
  quick: 1,
  standard: 2,
  deep: 3,
};

function complexityLabel(profile: string) {
  if (profile === 'deep') return 'high complexity';
  if (profile === 'standard') return 'medium complexity';
  return 'low complexity';
}

function ComplexityChevrons({ profile }: { profile: string }) {
  return (
    <span
      className="complexity-chevrons"
      aria-label={complexityLabel(profile)}
      title={complexityLabel(profile)}
    >
      {[1, 2, 3].map((level) => (
        <ChevronRight
          key={level}
          size={11}
          strokeWidth={3}
          aria-hidden="true"
          className={
            level <= (complexityLevel[profile] ?? 1)
              ? 'complexity-chevron complexity-chevron-active'
              : 'complexity-chevron'
          }
        />
      ))}
    </span>
  );
}

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

function projectSlug(name: string): string {
  return name
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

function projectRouteKey(project: Project, projects: Project[]): string {
  const slug = projectSlug(project.name) || project.id.toLowerCase();
  const matches = projects.filter((entry) => projectSlug(entry.name) === slug);

  return matches[0]?.id === project.id ? slug : `${slug}-${project.id.toLowerCase()}`;
}

function projectFromRouteKey(routeKey: string, projects: Project[]): Project | null {
  const byId = projects.find((entry) => entry.id === routeKey);

  if (byId) return byId;
  const normalized = routeKey.toLowerCase();

  return projects.find((entry) => projectRouteKey(entry, projects) === normalized) ?? null;
}

function resolveDefaultRoute(current: Route, projects: Project[], tasks: Task[]): Route {
  let projectId = current.projectId
    ? (projectFromRouteKey(current.projectId, projects)?.id ?? null)
    : null;

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

function routePath(
  projectId: string,
  taskId: string | null,
  view: 'overview' | 'tasks',
  projects: Project[],
): string {
  const project = projects.find((entry) => entry.id === projectId);
  const routeKey = project ? projectRouteKey(project, projects) : projectId;

  if (taskId)
    return `/projects/${encodeURIComponent(routeKey)}/tasks/${encodeURIComponent(taskId)}`;
  if (view === 'overview') return `/projects/${encodeURIComponent(routeKey)}/overview`;

  return `/projects/${encodeURIComponent(routeKey)}`;
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

function scopedTasks(all: Task[], projectId: string | null): Task[] {
  if (!projectId) return [];

  return all.filter((task) => task.projectId === projectId);
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
  open,
  projects,
  tasks,
  onSelect,
  onClose,
  onShowHelp,
}: {
  open: boolean;
  projects: Project[];
  tasks: Task[];
  onSelect: (projectId: string, taskId: string | null) => void;
  onClose: () => void;
  onShowHelp: () => void;
}) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const items = useMemo(() => {
    const all: {
      projectId: string;
      projectName: string;
      taskId: string | null;
      label: string;
      help?: boolean;
    }[] = [];

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
    all.push({
      projectId: '',
      projectName: 'Help',
      taskId: null,
      label: 'Keyboard shortcuts',
      help: true,
    });

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
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onShowHelpRef = useRef(onShowHelp);
  onShowHelpRef.current = onShowHelp;

  useLayoutEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!openRef.current) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, itemsRef.current.length - 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (event.key === 'Enter' && itemsRef.current[activeIndexRef.current]) {
        event.preventDefault();
        const entry = itemsRef.current[activeIndexRef.current];

        onCloseRef.current();
        if (entry.help) onShowHelpRef.current();
        else onSelectRef.current(entry.projectId, entry.taskId);
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
              key={entry.help ? 'help' : `${entry.projectId}-${entry.taskId ?? 'proj'}`}
              className={`palette-item${i === activeIndex ? ' active' : ''}`}
              onClick={() => {
                onClose();
                if (entry.help) onShowHelp();
                else onSelect(entry.projectId, entry.taskId);
              }}
              onMouseEnter={() => setActiveIndex(i)}
            >
              {entry.help ? (
                <span className="palette-item-project">
                  <CircleHelp size={12} />
                  {entry.label}
                </span>
              ) : entry.taskId ? (
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

function useModalDismiss(onClose: () => void) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);

  onCloseRef.current = onClose;

  useEffect(() => {
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return closeButtonRef;
}

function KeyHint({
  metadata,
  position,
}: {
  metadata?: ShortcutMetadata;
  position?: 'corner' | 'start' | 'end' | 'row';
}) {
  if (!metadata) return null;
  const disabled = !metadata.enabled;

  return (
    <span
      className={`key-hint${disabled ? ' key-hint-disabled' : ''}${position ? ` key-hint-${position}` : ''}`}
      aria-hidden="true"
      title={disabled ? metadata.disabledReason : metadata.label}
    >
      {metadata.chord}
    </span>
  );
}

function PaletteButton({
  hints,
  onOpen,
}: {
  hints: Map<string, ShortcutMetadata> | null;
  onOpen: () => void;
}) {
  return (
    <button
      className="icon-button key-hint-anchor"
      aria-label="Open command palette"
      onClick={onOpen}
    >
      <Search size={14} />
      <KeyHint metadata={hints?.get('palette.open')} position="corner" />
    </button>
  );
}

function ShortcutHelp({ shortcuts, onClose }: { shortcuts: Shortcut[]; onClose: () => void }) {
  const byId = indexShortcuts(shortcuts);
  const dismissRef = useModalDismiss(onClose);
  const groups: { title: string; ids: string[] }[] = [
    {
      title: 'Navigation',
      ids: ['palette.open', ...Array.from({ length: 10 }, (_, index) => `task.open.${index + 1}`)],
    },
    {
      title: 'Task actions',
      ids: [
        'task.continue',
        'task.changes.internal',
        'task.changes.external',
        'task.terminal.focus',
        'task.terminal.external',
      ],
    },
  ];

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="create-task settings-modal shortcut-help"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="panel-head compact">
          <div>
            <span className="eyebrow">Help</span>
            <h2>Keyboard shortcuts</h2>
          </div>
          <button
            ref={dismissRef}
            type="button"
            className="icon-button"
            aria-label="Close keyboard shortcuts"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>
        {groups.map((group) => (
          <section key={group.title} className="shortcut-help-group" aria-label={group.title}>
            <h3>{group.title}</h3>
            <ul className="shortcut-help-list">
              {group.ids.map((id) => {
                const entry = byId.get(id);

                if (!entry) return null;

                return (
                  <li key={id}>
                    <span className="shortcut-help-chord">{entry.chord}</span>
                    {entry.fallbackChords.map((fallback) => (
                      <span key={fallback} className="shortcut-help-chord shortcut-help-fallback">
                        {fallback}
                      </span>
                    ))}
                    <span className="shortcut-help-label">{entry.label}</span>
                    {!entry.enabled && entry.disabledReason && (
                      <span className="shortcut-help-reason">{entry.disabledReason}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </section>
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
  hints,
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
  hints: Map<string, ShortcutMetadata> | null;
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
        {tasks.map((entry, index) => (
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
              {entry.profile}
              <ComplexityChevrons profile={entry.profile} />
              <span aria-hidden="true">·</span>
              {entry.attempts ? `${entry.attempts} runs` : 'not started'}
            </span>
            <Wave state={entry.state} />
            {index < 10 && (
              <KeyHint metadata={hints?.get(`task.open.${index + 1}`)} position="row" />
            )}
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
          <div className="thread-content">
            <div className="thread-meta">
              <span className="thread-kind">
                {kindLabel[entry.kind] ?? entry.kind.replaceAll('_', ' ')}
              </span>
              <time>{formatTime(entry.at)}</time>
            </div>
            <div className="thread-summary">{entry.summary}</div>
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
  hints,
  onOpenEditor,
  onViewDiff,
  onCopyPath,
  onRefresh,
}: {
  run: Run | undefined;
  changes: ChangeLoad | undefined;
  disabled: boolean;
  hints: Map<string, ShortcutMetadata> | null;
  onOpenEditor: () => void;
  onViewDiff: () => void;
  onCopyPath: () => void;
  onRefresh: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const available = changes?.result?.state === 'available';
  const summary = available ? changes.result!.summary : undefined;
  const changeButtonLabel = summary
    ? summary.additions || summary.deletions
      ? `+${summary.additions}, -${summary.deletions}`
      : 'No diff'
    : changes?.loading
      ? 'Loading…'
      : !run || changes?.result?.state === 'unavailable' || changes?.error
        ? 'Unavailable'
        : 'Diff';
  const unavailable = !run || changes?.result?.state === 'unavailable';

  return (
    <div className="changes-control">
      <button
        className="button secondary small changes-main key-hint-anchor"
        aria-label={changeButtonLabel}
        disabled={disabled || unavailable}
        title={!run ? 'No persisted run for this agent' : undefined}
        onClick={() => {
          setMenuOpen(false);
          onOpenEditor();
        }}
      >
        <FileDiff size={12} />
        {summary ? (
          summary.additions || summary.deletions ? (
            <>
              <span className="change-count change-count-additions">+{summary.additions}</span>
              <span className="change-count change-count-deletions">-{summary.deletions}</span>
            </>
          ) : (
            <span className="change-count-empty">No diff</span>
          )
        ) : changes?.loading ? (
          'Loading…'
        ) : !run || changes?.result?.state === 'unavailable' || changes?.error ? (
          'Unavailable'
        ) : (
          'Diff'
        )}
        <KeyHint metadata={hints?.get('task.changes.external')} position="corner" />
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
            className="key-hint-anchor"
            onClick={() => {
              setMenuOpen(false);
              onViewDiff();
            }}
          >
            <FileDiff size={12} /> View diff
            <KeyHint metadata={hints?.get('task.changes.internal')} position="end" />
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

type AgentCardState = {
  isWorkerRole: boolean;
  isCurrentRun: boolean;
  isRunning: boolean;
  isCompleted: boolean;
  hasSession: boolean;
  terminalId: string | undefined;
  terminalAvailable: boolean;
  canOpenExternally: boolean;
  hasOpenReviewFindings: boolean;
  statusClass: string;
  statusLabel: string;
};

function buildAgentCards(task: Task): AgentCard[] {
  return task.roles.flatMap<AgentCard>((role) => {
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
}

function agentCardState(task: Task, card: AgentCard): AgentCardState {
  const { role, run, agentSession } = card;
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
    : role === 'reviewer'
      ? task.state === 'REVIEWING'
      : role === 'architect'
        ? task.state === 'DRAFT' && Boolean(agentSession)
        : false;
  const isCompleted = isWorkerRole
    ? run?.status === 'COMPLETED' || (isCurrentRun && task.runStatus === 'COMPLETED')
    : role === 'reviewer'
      ? task.reviewed === true && task.state !== 'REVIEWING'
      : role === 'architect'
        ? Boolean(task.architecture)
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
    : Boolean(agentSession && agentSession.terminalAccess === 'controller_local');
  const canOpenExternally = isWorkerRole ? hasSession : terminalAvailable;
  const hasOpenReviewFindings = role === 'reviewer' && task.findings > 0;
  const statusClass = isRunning
    ? 'running'
    : hasOpenReviewFindings
      ? 'error'
      : isCompleted
        ? 'completed'
        : 'idle';
  const statusLabel = isRunning
    ? 'running'
    : hasOpenReviewFindings
      ? `${task.findings} open`
      : isCompleted
        ? 'done'
        : hasSession
          ? 'available'
          : 'idle';

  return {
    isWorkerRole,
    isCurrentRun,
    isRunning,
    isCompleted,
    hasSession,
    terminalId,
    terminalAvailable,
    canOpenExternally,
    hasOpenReviewFindings,
    statusClass,
    statusLabel,
  };
}

function openSessionArgs(task: Task, card: AgentCard, state: AgentCardState): string[] {
  const { role, run, agentSession } = card;

  if (state.isWorkerRole)
    return [
      'session',
      'open',
      task.id,
      '--stage',
      run?.stageId ?? role,
      '--role',
      role,
      '--harness',
      run?.harness ?? 'codex',
      ...(state.isRunning ? ['--surface', 'live', '--mode', 'live'] : []),
    ];

  return [
    'session',
    'open',
    task.id,
    '--role',
    role,
    '--harness',
    agentSession?.harness ?? 'codex',
  ];
}

type TerminalTarget = {
  key: string;
  label: string;
  card: AgentCard;
  state: AgentCardState;
};

type TaskShortcutBinding = {
  enabled: () => boolean;
  disabledReason: () => string | undefined;
  onDisabled?: (reason: string) => void;
  run: () => void;
};

type TaskShortcutBindings = {
  continue: TaskShortcutBinding;
  changesInternal: TaskShortcutBinding;
  changesExternal: TaskShortcutBinding;
  terminalFocus: TaskShortcutBinding;
  terminalExternal: TaskShortcutBinding;
};

function terminalTargets(task: Task): TerminalTarget[] {
  return buildAgentCards(task).map((card) => ({
    key: card.key,
    label: card.label,
    card,
    state: agentCardState(task, card),
  }));
}

function focusTerminalTargets(task: Task): TerminalTarget[] {
  return terminalTargets(task).filter(
    (target) =>
      target.state.isRunning && target.state.terminalAvailable && Boolean(target.state.terminalId),
  );
}

function TerminalChooser({
  targets,
  onSelect,
  onClose,
}: {
  targets: TerminalTarget[];
  onSelect: (target: TerminalTarget) => void;
  onClose: () => void;
}) {
  const dismissRef = useModalDismiss(onClose);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="create-task"
        role="dialog"
        aria-modal="true"
        aria-label="Choose terminal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="panel-head compact">
          <div>
            <span className="eyebrow">Terminal</span>
            <h2>Choose terminal</h2>
          </div>
          <button
            ref={dismissRef}
            type="button"
            className="icon-button"
            aria-label="Close terminal chooser"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>
        <div className="agent-connections" role="group" aria-label="Terminal targets">
          {targets.map((target) => (
            <button
              key={target.key}
              type="button"
              className="agent-connection"
              onClick={() => onSelect(target)}
            >
              <span className="agent-connection-label">{target.label}</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function AgentGrid({
  task,
  canMutate,
  act,
  hints,
  expandedAgent,
  onToggleExpand,
}: {
  task: Task;
  canMutate: boolean;
  act: (args: string[], success: string) => void;
  hints: Map<string, ShortcutMetadata> | null;
  expandedAgent: string | null;
  onToggleExpand: (agent: string) => void;
}) {
  const cards = buildAgentCards(task);

  return (
    <div className="agent-grid">
      {cards.map((card) => {
        const { key, role, label, run, agentSession } = card;
        const state = agentCardState(task, card);
        const {
          isWorkerRole,
          isCurrentRun,
          terminalId,
          terminalAvailable,
          canOpenExternally,
          statusClass,
          statusLabel,
        } = state;
        const expanded = expandedAgent === key && terminalAvailable && Boolean(terminalId);

        return (
          <div className={`agent-card${expanded ? ' expanded' : ''}`} key={key}>
            <div className="agent-header">
              <span className="agent-role">
                <span className="agent-role-icon">{agentIcon(role)}</span>
                {label}
              </span>
              <span className={`agent-status ${statusClass}`}>{statusLabel}</span>
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
              ) : role === 'reviewer' && task.state === 'REVIEWING' ? (
                <span>Reviewing the latest worker revision</span>
              ) : role === 'reviewer' && task.reviewed ? (
                <span>
                  {task.findings > 0
                    ? `Review requested corrections · ${task.findings} open finding${task.findings === 1 ? '' : 's'}`
                    : 'Review passed'}
                  {agentSession && (
                    <span>
                      {' · '}
                      {agentSession.harness}{' '}
                      {agentSession.terminalAccess === 'runner_local'
                        ? 'session recorded on Runner'
                        : 'session available'}
                    </span>
                  )}
                </span>
              ) : agentSession ? (
                <>
                  {agentSession.harness} ·{' '}
                  {agentSession.terminalAccess === 'runner_local'
                    ? 'session recorded on Runner'
                    : 'session available'}
                  {agentSession.workspace && agentSession.terminalAccess !== 'runner_local' && (
                    <span> · {agentSession.workspace}</span>
                  )}
                </>
              ) : (
                <span>{role === 'reviewer' ? 'Review not started' : 'Plan not created yet'}</span>
              )}
            </div>
            <div className="agent-actions">
              <button
                className="button secondary small key-hint-anchor"
                disabled={!canMutate || !terminalAvailable}
                aria-expanded={expanded}
                aria-label={`${expanded ? 'Collapse' : 'Expand'} ${label} terminal`}
                onClick={() => onToggleExpand(key)}
              >
                <SquareTerminal size={12} />
                {expanded ? 'Collapse' : 'Expand'}
                <KeyHint metadata={hints?.get('task.terminal.focus')} position="corner" />
              </button>
              <button
                className="button secondary small key-hint-anchor"
                disabled={!canMutate || !canOpenExternally}
                aria-label={`Open ${label} externally`}
                title={
                  canOpenExternally
                    ? `Open ${label} in Terminal`
                    : agentSession?.terminalAccess === 'runner_local'
                      ? `${label} session is available only on the Runner`
                      : `No session available for ${label}`
                }
                onClick={() => act(openSessionArgs(task, card, state), `${role} terminal opened`)}
              >
                <Terminal size={12} />
                Open externally
                <KeyHint metadata={hints?.get('task.terminal.external')} position="corner" />
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
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

type CreateTaskInput = {
  id: string;
  title: string;
  body: string;
};

function createClientTaskId(): string {
  return `CLEW-${crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const intentId = useRef<string | null>(null);

  const submit = async (event: Event) => {
    event.preventDefault();
    if (submitting.current) return;
    const cleanTitle = title.trim();
    const cleanBody = body.trim();

    if (!cleanTitle || !cleanBody) return;
    submitting.current = true;
    intentId.current ??= createClientTaskId();
    setBusy(true);
    setError('');
    try {
      await onCreate({ id: intentId.current, title: cleanTitle, body: cleanBody });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Task creation failed');
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="create-task" onSubmit={(event) => void submit(event)}>
        <div className="panel-head compact">
          <div>
            <span className="eyebrow">New task</span>
            <h2>Create a task</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close"
            onClick={onClose}
            disabled={busy}
          >
            <X size={14} />
          </button>
        </div>
        <label htmlFor="task-title">Title</label>
        <input
          id="task-title"
          value={title}
          onInput={(event) => setTitle(event.currentTarget.value)}
          placeholder="Short title"
          required
        />
        <label htmlFor="task-body">Description</label>
        <textarea
          id="task-body"
          className="create-task-body"
          value={body}
          onInput={(event) => setBody(event.currentTarget.value)}
          placeholder="Describe the task, expected behavior, and constraints"
          required
        />
        <p className="small-muted">
          Clew selects the workflow from the description. Quick tasks start immediately.
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
            {busy ? 'Creating…' : 'Create task'}
          </button>
        </div>
      </form>
    </div>
  );
}

type StartApproval = {
  taskId: string;
  title: string;
  profile: 'standard' | 'deep';
  step: NextStep;
};

function StartApprovalDialog({
  approval,
  onClose,
  onConfirm,
}: {
  approval: StartApproval;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const confirming = useRef(false);
  const cancelButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !confirming.current) onClose();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const confirm = async () => {
    if (confirming.current) return;
    confirming.current = true;
    setBusy(true);
    try {
      await onConfirm();
    } catch {
      confirming.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="create-task start-approval"
        role="dialog"
        aria-modal="true"
        aria-labelledby="start-approval-title"
      >
        <div className="panel-head compact">
          <div>
            <span className="eyebrow">{approval.profile} workflow</span>
            <h2 id="start-approval-title">Start this task?</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close"
            onClick={onClose}
            disabled={busy}
          >
            <X size={14} />
          </button>
        </div>
        <p>
          <strong>{approval.title}</strong>
        </p>
        <p>{approval.step.summary}</p>
        {approval.step.sideEffects?.length ? (
          <ul className="start-approval-effects">
            {approval.step.sideEffects.map((effect) => (
              <li key={effect}>{effect}</li>
            ))}
          </ul>
        ) : null}
        <div className="modal-actions">
          <button
            ref={cancelButton}
            type="button"
            className="button secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="button primary"
            onClick={() => void confirm()}
            disabled={busy}
          >
            {busy ? 'Starting…' : 'Start task'}
          </button>
        </div>
      </section>
    </div>
  );
}

type ActionConfirmation = {
  args: string[];
  success: string;
  title: string;
  summary: string;
  effects: string[];
  confirmLabel: string;
};

function describeAction(args: string[], task: Task) {
  const command = args[0];

  if (command === 'approve')
    return {
      title: 'Approve plan',
      summary: 'Clew will approve the current execution plan.',
      effects: [
        'The task will be allowed to move to the execution stage.',
        'Approving the plan does not change files in the repository.',
      ],
      confirmLabel: 'Approve plan',
    };

  if (command === 'approve-run') {
    return {
      title: 'Allow worker action',
      summary: 'Clew will allow the worker to continue with the requested operation.',
      effects: [
        'The operation will run inside the worker workspace.',
        'The worker will continue this run after the operation finishes.',
      ],
      confirmLabel: 'Allow action',
    };
  }

  if (command === 'reject-run') {
    return {
      title: 'Reject worker action',
      summary: 'Clew will deny the worker request and keep that operation from running.',
      effects: ['The worker may stop or report that the run cannot continue.'],
      confirmLabel: 'Reject action',
    };
  }

  if (command === 'continue')
    return {
      title: 'Restart worker',
      summary: 'Clew will start a new worker run for this task.',
      effects: [
        task.findings
          ? `The worker will receive the ${task.findings} open review finding${task.findings === 1 ? '' : 's'} as feedback.`
          : 'The worker will receive a fresh instruction to re-check the task.',
        'The previous Codex session will be resumed when it is still available; otherwise a new session starts.',
        'Verification and review will run again after the worker finishes.',
      ],
      confirmLabel: 'Restart worker',
    };

  if (command === 'complete')
    return {
      title: 'Complete task',
      summary: 'Clew will mark this task as completed using the verified revision.',
      effects: ['No new worker run will start.', 'The primary checkout will not be changed.'],
      confirmLabel: 'Complete task',
    };

  if (command === 'retry')
    return {
      title: 'Retry worker',
      summary: 'Clew will queue another worker attempt for this task.',
      effects: [
        'The selected stage will run again in an isolated workspace.',
        'Verification and review will run for the new attempt.',
      ],
      confirmLabel: 'Retry worker',
    };

  if (command === 'run')
    return {
      title: 'Start worker',
      summary: 'Clew will start a worker run for this task.',
      effects: ['A run record and an isolated workspace will be created.'],
      confirmLabel: 'Start worker',
    };

  if (command === 'task') {
    const action = args[1];

    if (action === 'integrate') {
      const strategy = args[args.indexOf('--strategy') + 1] ?? 'selected';
      const strategyLabel =
        strategy === 'squash'
          ? 'squash-merge'
          : strategy === 'merge'
            ? 'merge commit'
            : strategy === 'pr'
              ? 'pull-request handoff'
              : strategy === 'human'
                ? 'human integration handoff'
                : strategy;
      const target = task.finalization?.git?.targetBranch ?? 'the target branch';

      return {
        title: 'Integrate task',
        summary: `Clew will use a ${strategyLabel} to apply the verified revision to ${target}.`,
        effects: [
          strategy === 'pr' || strategy === 'human'
            ? 'The task will be handed off instead of changing the branch automatically.'
            : 'The integration will change the target branch, not the worker workspace.',
        ],
        confirmLabel: 'Integrate',
      };
    }

    if (action === 'mark-merged')
      return {
        title: 'Mark task merged',
        summary: 'Clew will record that the verified revision was merged outside Clew.',
        effects: ['Clew will not perform another merge.'],
        confirmLabel: 'Mark merged',
      };

    if (action === 'mark-released')
      return {
        title: 'Mark task released',
        summary: 'Clew will record the release and close the task lifecycle.',
        effects: ['The deployment or release has already happened outside this action.'],
        confirmLabel: 'Mark released',
      };
  }

  return {
    title: 'Confirm task action',
    summary: 'Clew will apply the requested action to this task.',
    effects: [],
    confirmLabel: 'Confirm',
  };
}

function ActionConfirmationDialog({
  action,
  onClose,
  onConfirm,
}: {
  action: ActionConfirmation;
  onClose: () => void;
  onConfirm: () => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false);
  const confirming = useRef(false);
  const cancelButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !confirming.current) onClose();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const confirm = async () => {
    if (confirming.current) return;
    confirming.current = true;
    setBusy(true);
    try {
      if (await onConfirm()) onClose();
      else {
        confirming.current = false;
        setBusy(false);
      }
    } catch {
      confirming.current = false;
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}
    >
      <section
        className="create-task action-confirmation"
        role="dialog"
        aria-modal="true"
        aria-label={`Confirm action: ${action.title}`}
        aria-describedby="action-confirmation-description"
      >
        <div className="panel-head compact">
          <div>
            <h2 id="action-confirmation-title">{action.title}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close"
            onClick={onClose}
            disabled={busy}
          >
            <X size={14} />
          </button>
        </div>
        <p id="action-confirmation-description">{action.summary}</p>
        {action.effects.length > 0 && (
          <ul className="action-confirmation-effects">
            {action.effects.map((effect) => (
              <li key={effect}>{effect}</li>
            ))}
          </ul>
        )}
        <div className="modal-actions">
          <button
            ref={cancelButton}
            type="button"
            className="button secondary"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="button primary"
            onClick={() => void confirm()}
            disabled={busy}
          >
            {busy ? 'Applying…' : action.confirmLabel}
          </button>
        </div>
      </section>
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
  onBrowse,
}: {
  onClose: () => void;
  onAdd: (folder: string, name: string) => Promise<void>;
  onBrowse: () => Promise<string | null>;
}) {
  const [folder, setFolder] = useState('');
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState('');

  const folderName = (path: string) =>
    path
      .trim()
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .filter(Boolean)
      .at(-1) ?? '';

  const browse = async () => {
    if (busy || browsing) return;
    setBrowsing(true);
    setError('');
    try {
      const selected = await onBrowse();

      if (selected) {
        setFolder(selected);
        if (!nameEdited) setName(folderName(selected));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not open folder picker');
    } finally {
      setBrowsing(false);
    }
  };

  const submit = async (event: Event) => {
    event.preventDefault();
    if (!folder.trim() || busy || browsing) return;
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
        <div className="folder-picker-field">
          <input
            id="project-folder"
            value={folder}
            onInput={(event) => setFolder(event.currentTarget.value)}
            placeholder="/Users/me/dev/clew"
            required
          />
          <button
            type="button"
            className="button secondary"
            onClick={() => void browse()}
            disabled={busy || browsing}
          >
            <FolderOpen size={14} /> {browsing ? 'Opening…' : 'Browse…'}
          </button>
        </div>
        <label htmlFor="project-name">Project name</label>
        <input
          id="project-name"
          value={name}
          onInput={(event) => {
            setName(event.currentTarget.value);
            setNameEdited(true);
          }}
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
          <button
            type="button"
            className="button secondary"
            onClick={onClose}
            disabled={busy || browsing}
          >
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={busy || browsing}>
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
  selected: string | null;
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
            className={
              active < 0 ? 'step' : i < active ? 'step done' : i === active ? 'step active' : 'step'
            }
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
  const [startApproval, setStartApproval] = useState<StartApproval | null>(null);
  const [actionConfirmation, setActionConfirmation] = useState<ActionConfirmation | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    settingsButtonRef.current?.focus();
  }, []);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [terminalChooser, setTerminalChooser] = useState<{
    mode: 'focus' | 'external';
    targets: TerminalTarget[];
  } | null>(null);
  const terminalChoiceRef = useRef<Record<string, string>>({});
  const taskShortcutsRef = useRef<TaskShortcutBindings | null>(null);

  taskShortcutsRef.current = null;
  const commandHold = useCommandHold();
  const [helpOpen, setHelpOpen] = useState(false);
  const [nextStep, setNextStep] = useState<NextStep | null>(null);
  const [selectedStep, setSelectedStep] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [descExpanded, setDescExpanded] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [changesByRun, setChangesByRun] = useState<Record<string, ChangeLoad>>({});
  const [diffRunId, setDiffRunId] = useState<string | null>(null);
  const [selectedChangeRunId, setSelectedChangeRunId] = useState<string | null>(null);
  const [runRequested, setRunRequested] = useState(false);
  const startRequests = useRef(new Set<string>());
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

          if (changed) setRoute(resolved);
          if (resolved.projectId) {
            const path = routePath(
              resolved.projectId,
              resolved.taskId,
              resolved.view,
              nextProjects,
            );

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
      const direct = projectFromRouteKey(route.projectId, projects);
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

  useEffect(() => {
    if (!project) return;
    const path = routePath(project.id, route.taskId, route.view, projects);

    if (window.location.pathname !== path) window.history.replaceState({}, '', path);
  }, [project, projects, route.taskId, route.view]);

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
    const path = routePath(projectId, taskId, 'tasks', projects);
    if (window.location.pathname !== path) window.history.pushState({}, '', path);
  };

  const selectTask = (taskId: string) => {
    if (!project) return;
    writePreference(`last-task.${project.id}`, taskId);
    setRoute({ projectId: project.id, taskId, view: 'tasks' });
    const path = routePath(project.id, taskId, 'tasks', projects);
    if (window.location.pathname !== path) window.history.pushState({}, '', path);
  };

  const selectView = (nextView: 'overview' | 'tasks') => {
    if (!project) return;
    const taskId = nextView === 'overview' ? null : (task?.id ?? null);
    setRoute({ projectId: project.id, taskId, view: nextView });
    const path = routePath(project.id, taskId, nextView, projects);
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
    const path = routePath(projectId, resolvedTaskId, 'tasks', projects);
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

  const browseProjectFolder = async () => {
    const result = (await execute(['project', 'browse'])) as {
      fixture?: boolean;
      folder?: unknown;
    } | null;

    if (result?.fixture) throw new Error('Connect to the local Clew daemon to browse folders');
    if (result?.folder === null || result?.folder === undefined) return null;
    if (typeof result.folder !== 'string')
      throw new Error('Folder picker returned an invalid path');

    return result.folder;
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

  const shortcutScope = (): ShortcutScope => {
    if (
      paletteOpen ||
      createOpen ||
      finishOpen ||
      addProjectOpen ||
      settingsOpen ||
      startApproval ||
      actionConfirmation ||
      terminalChooser ||
      helpOpen ||
      diffRunId
    )
      return 'modal';

    const active = document.activeElement;

    if (isTerminalElement(active)) return 'terminal';
    if (isTextEntryElement(active)) return 'input';
    if (project && task) return 'task';

    return 'global';
  };

  const primary = primaryModifierLabel();
  const alternate = optionModifierLabel();
  const shortcuts = useMemo<Shortcut[]>(() => {
    const digitKeys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
    const digitCodes = [
      'Digit1',
      'Digit2',
      'Digit3',
      'Digit4',
      'Digit5',
      'Digit6',
      'Digit7',
      'Digit8',
      'Digit9',
      'Digit0',
    ];
    const list: Shortcut[] = digitKeys.map((key, index) => {
      const ordinal = index + 1;
      const entry = sortedTasks[index] ?? null;

      return {
        id: `task.open.${ordinal}`,
        label: `Open task ${ordinal}`,
        chord: `${primary}${key}`,
        fallbackChords: [`${alternate}${key}`],
        combos: [
          { key, primary: true },
          { code: digitCodes[index], primary: true },
          { key, alt: true },
          { code: digitCodes[index], alt: true },
        ],
        scopes: ['global', 'task'],
        enabled: () => Boolean(entry),
        disabledReason: () => (entry ? undefined : 'No visible task in this position'),
        run: () => {
          const current = sortedTasks[index];

          if (current) selectTask(current.id);
        },
      };
    });

    list.push({
      id: 'palette.open',
      label: 'Open command palette',
      chord: `${primary}K`,
      fallbackChords: primary === '⌘' ? ['Ctrl+K'] : [],
      combos: [
        { key: 'k', primary: true },
        { code: 'KeyK', primary: true },
      ],
      scopes: ['global', 'task', 'input', 'terminal', 'modal'],
      enabled: () => Boolean(project),
      run: () => setPaletteOpen((value) => !value),
    });

    const taskBinding = (
      id: string,
      label: string,
      chord: string,
      fallbackChords: string[],
      combos: KeyCombo[],
      key: keyof TaskShortcutBindings,
    ): Shortcut => ({
      id,
      label,
      chord,
      fallbackChords,
      combos,
      scopes: ['task'],
      enabled: () => taskShortcutsRef.current?.[key].enabled() ?? false,
      disabledReason: () =>
        taskShortcutsRef.current?.[key].disabledReason() ?? 'Open a task to use this action.',
      onDisabled: (reason: string) => taskShortcutsRef.current?.[key].onDisabled?.(reason),
      run: () => taskShortcutsRef.current?.[key].run(),
    });

    list.push(
      taskBinding(
        'task.continue',
        'Continue task',
        `${primary}↵`,
        primary === '⌘' ? ['Ctrl+Enter'] : [],
        [
          { key: 'Enter', primary: true },
          { code: 'Enter', primary: true },
        ],
        'continue',
      ),
      taskBinding(
        'task.changes.internal',
        'View changes',
        `${primary}E`,
        primary === '⌘' ? ['Ctrl+E'] : [],
        [
          { key: 'e', primary: true },
          { code: 'KeyE', primary: true },
        ],
        'changesInternal',
      ),
      taskBinding(
        'task.changes.external',
        'Open changes externally',
        `${primary}⇧E`,
        primary === '⌘' ? ['Ctrl+Shift+E'] : [],
        [
          { key: 'e', primary: true, shift: true },
          { code: 'KeyE', primary: true, shift: true },
        ],
        'changesExternal',
      ),
      taskBinding(
        'task.terminal.focus',
        'Focus terminal',
        `${primary}'`,
        primary === '⌘' ? ["Ctrl+'"] : [],
        [
          { key: "'", primary: true },
          { code: 'Quote', primary: true },
        ],
        'terminalFocus',
      ),
      taskBinding(
        'task.terminal.external',
        'Open session externally',
        `${primary}⇧'`,
        primary === '⌘' ? ["Ctrl+Shift+'"] : [],
        [
          { key: "'", primary: true, shift: true },
          { code: 'Quote', primary: true, shift: true },
        ],
        'terminalExternal',
      ),
    );

    return list;
  }, [sortedTasks, selectTask, setPaletteOpen, project, primary, alternate]);

  useShortcuts(shortcuts, shortcutScope);

  const hints = commandHold.active ? indexShortcuts(shortcuts) : null;

  useEffect(() => {
    commandHold.reset();
  }, [
    route,
    paletteOpen,
    terminalChooser,
    settingsOpen,
    createOpen,
    finishOpen,
    addProjectOpen,
    startApproval,
    actionConfirmation,
    helpOpen,
    diffRunId,
    commandHold.reset,
  ]);

  const runApprovedStart = async (taskId: string, actionId: string) => {
    if (startRequests.current.has(taskId)) return;
    startRequests.current.add(taskId);
    setStartApproval(null);
    setRunRequested(true);
    setNotice('Starting task…');
    const operation = execute(['task', 'approve-step', taskId, '--action', actionId]);

    try {
      const result = await operation;

      if ((result as { fixture?: boolean } | null)?.fixture)
        setTasks((current) =>
          current.map((entry) =>
            entry.id === taskId ? { ...entry, state: 'EXECUTING' as TaskState } : entry,
          ),
        );
      else await refresh();
      setNotice('Start approved');
    } catch (error) {
      setRunRequested(false);
      setNotice(error instanceof Error ? error.message : 'Could not start task');
    } finally {
      startRequests.current.delete(taskId);
    }
  };

  const requestStart = (taskId: string, title: string, step: NextStep) => {
    const profile = step.analysis?.recommendation.profile ?? step.inputs?.profile;

    if (!step.id) throw new Error('Next step returned no action id');
    if (profile === 'quick') {
      void runApprovedStart(taskId, step.id);
      return;
    }
    setStartApproval({
      taskId,
      title,
      profile: profile === 'deep' ? 'deep' : 'standard',
      step,
    });
  };

  const prepareStart = async (taskId: string, title: string) => {
    const result = (await execute(['task', 'next-step', taskId])) as NextStep & {
      fixture?: boolean;
    };
    const step: NextStep = result?.fixture
      ? {
          id: `action-${taskId}`,
          taskId,
          kind: 'start_worker',
          currentStep: 'DRAFT',
          resultingStep: 'EXECUTING',
          summary: 'Start implementation with the quick profile',
          inputs: { harness: 'codex', profile: 'quick', permissionMode: 'read-only' },
          sideEffects: ['start one local worker process', 'create one run record'],
          approvalRequired: true,
          status: 'PENDING',
        }
      : result;

    setNextStep(step);
    requestStart(taskId, title, step);
  };

  const createTask = async ({ id, title, body }: CreateTaskInput) => {
    if (!canMutateFor(connection)) {
      const error = new Error('Actions are disabled while the control plane is disconnected');

      setNotice(error.message);
      throw error;
    }
    const args = [
      'task',
      'create',
      '--id',
      id,
      ...(project ? ['--project', project.id] : []),
      '--title',
      title,
      '--description',
      body,
      '--profile',
      'auto',
      '--risk',
      'low',
      '--accept',
      `Deliver the requested outcome: ${body}`,
    ];
    try {
      const result = await execute(args);
      const createdId = (result as { id?: string } | null)?.id ?? id;

      if ((result as { fixture?: boolean } | null)?.fixture) {
        setTasks((current) => [
          {
            id: createdId,
            projectId: project?.id ?? null,
            createdAt: new Date().toISOString(),
            title,
            goal: body,
            profile: 'auto',
            tags: [],
            analysis: {
              version: 1,
              kind: { value: 'feature', confidence: 0.62 },
              readiness: {
                score: 100,
                readyToStart: true,
                unresolved: [],
              },
              recommendation: {
                action: 'start' as const,
                profile: 'quick' as const,
                reasons: ['Clear, bounded, low-risk task'],
              },
            },
            state: 'DRAFT' as TaskState,
            attention: null,
            revision: null,
            attempts: 0,
            roles: rolesForProfile('quick'),
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
        selectTask(createdId);
      } else {
        await refresh();
        selectTask(createdId);
      }
      setCreateOpen(false);
      setNotice(`Task created: ${title}`);
      try {
        await prepareStart(createdId, title);
      } catch (error) {
        setNotice(
          `Task created, but its start could not be prepared: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Task creation failed');
      throw error;
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
          <AddProject
            onClose={() => setAddProjectOpen(false)}
            onAdd={addProject}
            onBrowse={browseProjectFolder}
          />
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
            <PaletteButton hints={hints} onOpen={() => setPaletteOpen(true)} />
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
            hints={hints}
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
          <AddProject
            onClose={() => setAddProjectOpen(false)}
            onAdd={addProject}
            onBrowse={browseProjectFolder}
          />
        )}
        {settingsOpen && <SettingsModal onClose={closeSettings} />}
        {helpOpen && <ShortcutHelp shortcuts={shortcuts} onClose={() => setHelpOpen(false)} />}
        <CommandPalette
          open={paletteOpen}
          projects={projects}
          tasks={tasks}
          onSelect={selectProjectAndTask}
          onClose={() => setPaletteOpen(false)}
          onShowHelp={() => setHelpOpen(true)}
        />
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
            <PaletteButton hints={hints} onOpen={() => setPaletteOpen(true)} />
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
            hints={hints}
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
          <AddProject
            onClose={() => setAddProjectOpen(false)}
            onAdd={addProject}
            onBrowse={browseProjectFolder}
          />
        )}
        {settingsOpen && <SettingsModal onClose={closeSettings} />}
        {helpOpen && <ShortcutHelp shortcuts={shortcuts} onClose={() => setHelpOpen(false)} />}
        <CommandPalette
          open={paletteOpen}
          projects={projects}
          tasks={tasks}
          onSelect={selectProjectAndTask}
          onClose={() => setPaletteOpen(false)}
          onShowHelp={() => setHelpOpen(true)}
        />
      </div>
    );
  }

  // The tasks view is reached only with a non-empty project task list, where
  // the memo falls back to the first task. Narrow for the render path below.
  if (!task) return null;

  const canMutate = connection === 'connected' || connection === 'fixture';
  const act = async (args: string[], success: string, confirmed = false) => {
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
      !confirmed &&
      (confirmationRequired.has(args[0]) ||
        (args[0] === 'task' && ['integrate', 'mark-merged', 'mark-released'].includes(args[1])))
    ) {
      setActionConfirmation({ args: [...args], success, ...describeAction(args, task) });
      return false;
    }
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
  const canRestartWorker =
    task.state === 'READY' ||
    (task.state === 'WAITING_FOR_HUMAN' && task.attention !== 'PLAN_APPROVAL_REQUIRED');
  const interactiveWorker =
    task.runStatus === 'RUNNING' && task.terminalActive === true && Boolean(task.runId);
  const pendingHarnessApproval = task.harnessApprovals?.find((a) => !a.decision);
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
  const waitingForOperator = task.interactionStatus === 'waiting_for_operator';
  const changeRunAvailable = Boolean(changeRun);
  const terminalTargetsAvailable = focusTerminalTargets(task).length > 0;
  const externalTargetsAvailable = terminalTargets(task).some(
    (target) => target.state.canOpenExternally,
  );

  const focusTerminalTarget = (target: TerminalTarget) => {
    terminalChoiceRef.current[task.id] = target.key;
    setExpandedAgent(target.key);
    window.setTimeout(() => {
      document.querySelector<HTMLElement>('.terminal-panel .xterm-helper-textarea')?.focus();
    }, 0);
  };

  const openExternalTarget = (target: TerminalTarget) => {
    terminalChoiceRef.current[task.id] = target.key;
    void act(
      openSessionArgs(task, target.card, target.state),
      `${target.card.role} terminal opened`,
    );
  };

  const chooseTerminal = (mode: 'focus' | 'external') => {
    const targets =
      mode === 'external'
        ? terminalTargets(task).filter((target) => target.state.canOpenExternally)
        : focusTerminalTargets(task);

    if (!targets.length) {
      setNotice(
        mode === 'external'
          ? 'No session is available to open externally'
          : 'No embedded terminal is available',
      );
      return;
    }
    const preferred = targets.find((target) => target.key === terminalChoiceRef.current[task.id]);

    if (preferred) {
      if (mode === 'external') openExternalTarget(preferred);
      else focusTerminalTarget(preferred);
      return;
    }
    if (targets.length === 1) {
      if (mode === 'external') openExternalTarget(targets[0]);
      else focusTerminalTarget(targets[0]);
      return;
    }
    setTerminalChooser({ mode, targets });
  };

  const runContinue = () => {
    if (!canMutate) {
      setNotice('Actions are disabled while the control plane is disconnected');
      return;
    }
    if (interactiveWorker) {
      if (waitingForOperator) {
        chooseTerminal('focus');
        return;
      }
      setNotice('The worker is running without waiting for input');
      return;
    }
    if (canRestartWorker) {
      void act(
        ['continue', task.id, '--message', 'Restart the worker and re-check the task'],
        'Worker restart requested',
      );
      return;
    }
    if (nextStep?.status === 'PENDING') {
      requestStart(task.id, task.title, nextStep);
      return;
    }
    if (canStart) {
      void explainNextStep();
      return;
    }
    setNotice('No safe continue action is available for this task state');
  };

  taskShortcutsRef.current = {
    continue: {
      enabled: () =>
        canMutate &&
        ((interactiveWorker && waitingForOperator) ||
          canRestartWorker ||
          nextStep?.status === 'PENDING' ||
          canStart),
      disabledReason: () => {
        if (!canMutate) return 'Actions are disabled while the control plane is disconnected';
        if (interactiveWorker && !waitingForOperator)
          return 'The worker is running without waiting for input';
        return 'No safe continue action is available for this task state';
      },
      onDisabled: (reason: string) => setNotice(reason),
      run: runContinue,
    },
    changesInternal: {
      enabled: () => canMutate && changeRunAvailable,
      disabledReason: () => {
        if (!canMutate) return 'Actions are disabled while the control plane is disconnected';
        return changeRunAvailable ? undefined : 'No run is selected for inspection';
      },
      run: () => {
        if (changeRun) viewRunDiff(changeRun);
      },
    },
    changesExternal: {
      enabled: () => canMutate && changeRunAvailable,
      disabledReason: () => {
        if (!canMutate) return 'Actions are disabled while the control plane is disconnected';
        return changeRunAvailable ? undefined : 'No run is selected for inspection';
      },
      run: () => {
        if (changeRun) void runViewerAction(changeRun);
      },
    },
    terminalFocus: {
      enabled: () => canMutate && terminalTargetsAvailable,
      disabledReason: () => {
        if (!canMutate) return 'Actions are disabled while the control plane is disconnected';
        return terminalTargetsAvailable ? undefined : 'No embedded terminal is available';
      },
      run: () => chooseTerminal('focus'),
    },
    terminalExternal: {
      enabled: () => canMutate && externalTargetsAvailable,
      disabledReason: () => {
        if (!canMutate) return 'Actions are disabled while the control plane is disconnected';
        return externalTargetsAvailable ? undefined : 'No session is available to open externally';
      },
      run: () => chooseTerminal('external'),
    },
  };

  const mainAction = (() => {
    if (interactiveWorker) {
      if (waitingForOperator)
        return {
          label: 'Focus terminal',
          icon: <SquareTerminal size={13} />,
          enabled: canMutate && terminalTargetsAvailable,
          reason: !canMutate
            ? 'Actions are disabled while the control plane is disconnected'
            : terminalTargetsAvailable
              ? undefined
              : 'No embedded terminal is available',
          run: () => chooseTerminal('focus'),
        };
      return {
        label: 'Running',
        icon: <RefreshCw size={13} />,
        enabled: false,
        reason: 'The worker is running without waiting for input',
        run: () => {},
      };
    }
    if (canRestartWorker)
      return {
        label: 'Continue',
        icon: <RefreshCw size={13} />,
        enabled: canMutate,
        reason: canMutate
          ? undefined
          : 'Actions are disabled while the control plane is disconnected',
        run: runContinue,
      };
    if (nextStep?.status === 'PENDING')
      return {
        label: 'Approve start',
        icon: <Check size={13} />,
        enabled: canMutate,
        reason: canMutate
          ? undefined
          : 'Actions are disabled while the control plane is disconnected',
        run: () => requestStart(task.id, task.title, nextStep),
      };
    if (canStart)
      return {
        label: 'Next step',
        icon: <RefreshCw size={13} />,
        enabled: canMutate,
        reason: canMutate
          ? undefined
          : 'Actions are disabled while the control plane is disconnected',
        run: () => void explainNextStep(),
      };
    return {
      label: 'Continue',
      icon: <RefreshCw size={13} />,
      enabled: false,
      reason: 'No safe continue action is available for this task state',
      run: () => {},
    };
  })();

  const taskHints = commandHold.active ? indexShortcuts(shortcuts) : null;

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
          <PaletteButton hints={hints} onOpen={() => setPaletteOpen(true)} />
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
          hints={taskHints}
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
                <span className="eyebrow-tag">
                  {task.profile}
                  <ComplexityChevrons profile={task.profile} />
                </span>
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
                    hints={taskHints}
                    onOpenEditor={() => changeRun && void runViewerAction(changeRun)}
                    onViewDiff={() => changeRun && viewRunDiff(changeRun)}
                    onCopyPath={() => changeRun && void runViewerAction(changeRun, 'worktree-path')}
                    onRefresh={() => changeRun && void refreshRunChanges(changeRun.id)}
                  />
                  <button
                    className="button secondary key-hint-anchor"
                    disabled={!canMutate || !mainAction.enabled}
                    title={mainAction.reason}
                    onClick={mainAction.run}
                  >
                    {mainAction.icon} {mainAction.label}
                    <KeyHint metadata={taskHints?.get('task.continue')} position="corner" />
                  </button>
                  {interactiveWorker && (
                    <button
                      className="button secondary"
                      disabled={!canMutate}
                      onClick={() =>
                        void act(
                          ['finish-worker', task.id, '--run', task.runId!],
                          'Worker is finishing',
                        )
                      }
                    >
                      <Check size={13} /> Finish worker
                    </button>
                  )}
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
              <StepIndicator
                state={task.state}
                selected={selectedStep}
                onSelect={(key) => {
                  const closing = selectedStep === key;

                  setSelectedStep(closing ? null : key);
                  if (!closing && key === 'execute' && !nextStep) void explainNextStep();
                }}
              />
              {selectedStep && (
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
              )}
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
                        Worker needs permission to perform an operation
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
                      The worker is waiting for your answer. Respond in the terminal to continue
                      this run, or finish it to start verification.
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
                  ? 'Daemon version is incompatible. Run `clew daemon restart`, then reload.'
                  : `Daemon connection is unavailable. Showing last known data${lastUpdatedAt ? ` from ${lastUpdatedAt.toLocaleTimeString()}` : ''}; actions are disabled.`}
              </div>
            )}

            <AgentGrid
              task={task}
              canMutate={canMutate}
              act={act}
              hints={taskHints}
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
      {startApproval && (
        <StartApprovalDialog
          approval={startApproval}
          onClose={() => setStartApproval(null)}
          onConfirm={() => runApprovedStart(startApproval.taskId, startApproval.step.id!)}
        />
      )}
      {actionConfirmation && (
        <ActionConfirmationDialog
          action={actionConfirmation}
          onClose={() => setActionConfirmation(null)}
          onConfirm={() => act(actionConfirmation.args, actionConfirmation.success, true)}
        />
      )}
      {addProjectOpen && (
        <AddProject
          onClose={() => setAddProjectOpen(false)}
          onAdd={addProject}
          onBrowse={browseProjectFolder}
        />
      )}
      {settingsOpen && <SettingsModal onClose={closeSettings} />}
      {terminalChooser && (
        <TerminalChooser
          targets={terminalChooser.targets}
          onClose={() => setTerminalChooser(null)}
          onSelect={(target) => {
            const mode = terminalChooser.mode;

            setTerminalChooser(null);
            if (mode === 'external') openExternalTarget(target);
            else focusTerminalTarget(target);
          }}
        />
      )}
      {helpOpen && <ShortcutHelp shortcuts={shortcuts} onClose={() => setHelpOpen(false)} />}
      <CommandPalette
        open={paletteOpen}
        projects={projects}
        tasks={tasks}
        onSelect={selectProjectAndTask}
        onClose={() => setPaletteOpen(false)}
        onShowHelp={() => setHelpOpen(true)}
      />
    </div>
  );
}

function canMutateFor(connection: ConnectionState) {
  return connection === 'connected' || connection === 'fixture';
}
