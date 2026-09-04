import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Copy,
  FileDiff,
  GitBranch,
  Inbox,
  Laptop,
  RefreshCw,
  ShieldCheck,
  SquareTerminal,
  Terminal,
  WifiOff,
  X,
} from 'lucide-preact';
import { execute, loadTasks, subscribeToEvents, type ConnectionState } from './api';
import { rolesForProfile } from './api';
import type { AgentRole, AgentSession, NextStep, Run, Task, TaskState, ThreadItem } from './types';
import { TerminalPane } from './TerminalPane';
import packageMetadata from '../package.json';

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

function taskIdFromLocation() {
  const match = window.location.pathname.match(/^\/tasks\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
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

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState(
    () => taskIdFromLocation() ?? sessionStorage.getItem('clew-selected-task') ?? 'CLEW-071',
  );
  const [connection, setConnection] = useState<ConnectionState>('reconnecting');
  const [diagnostic, setDiagnostic] = useState(false);
  const [notice, setNotice] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
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
      ? tasks.filter((t) => {
          if (statusFilter === 'waiting') return statusGroup[t.state] === 'waiting';
          if (statusFilter === 'error') return statusGroup[t.state] === 'error';
          if (statusFilter === 'active') return statusGroup[t.state] === 'active';
          if (statusFilter === 'other') return statusGroup[t.state] === 'other';
          return true;
        })
      : tasks;
    return [...list].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
  }, [tasks, statusFilter]);

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
            createdAt: new Date().toISOString(),
            title,
            goal: body,
            profile,
            tags: tagList,
            state: 'DRAFT' as TaskState,
            attention: null,
            revision: null,
            attempts: 0,
            roles: rolesForProfile(profile),
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

  if (!task) {
    const unavailable = connection === 'disconnected' || connection === 'incompatible';
    return (
      <div className="app">
        <header className="topbar">
          <Logo />
          <Connection state={connection} />
        </header>
        <main className="empty">
          {unavailable ? <WifiOff size={24} /> : <Inbox size={24} />}
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
              <Check size={14} /> Create task
            </button>
            <button className="button secondary" onClick={() => void refresh()}>
              <RefreshCw size={14} /> Retry
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
      (confirmationRequired.has(args[0]) || (args[0] === 'task' && args[1] === 'approve-step')) &&
      !window.confirm(`Confirm ${args.join(' ')}?`)
    )
      return;
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
          <button className="icon-button" aria-label="Refresh tasks" onClick={() => void refresh()}>
            <RefreshCw size={14} />
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
                onClick={() => setStatusFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="task-list">
            {sortedTasks.map((entry) => (
              <button
                className={`task-row ${entry.id === task.id ? 'selected' : ''}${entry.interactionStatus === 'waiting_for_operator' ? ' task-row-waiting' : ''}`}
                key={entry.id}
                onClick={() => selectTask(entry.id)}
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
              </button>
            ))}
          </div>
          <div className="sidebar-footer">
            <span className="version">v{packageMetadata.version}</span>
          </div>
        </aside>
        <main className="content">
          <div className="content-inner">
            <section className="task-header">
              <div className="eyebrow">
                {task.id}
                <span className="eyebrow-tag">{task.profile}</span>
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'start',
                  gap: 16,
                }}
              >
                <div style={{ minWidth: 0 }}>
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
                    disabled={!canMutate || task.state !== 'READY' || !task.revision}
                    title={!task.revision ? 'A verified revision is required' : undefined}
                    onClick={() =>
                      act(['complete', task.id, '--revision', task.revision!], 'Task completed')
                    }
                  >
                    <Check size={13} /> Complete
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
    </div>
  );
}

function canMutateFor(connection: ConnectionState) {
  return connection === 'connected' || connection === 'fixture';
}
