import { fixtureProjects, fixtureTasks } from './fixtures';
import type {
  AgentRole,
  FinalizationReport,
  Project,
  Run,
  Task,
  TaskAnalysis,
  TaskState,
  ThreadItem,
} from './types';

export type ConnectionState =
  'fixture' | 'connected' | 'disconnected' | 'reconnecting' | 'incompatible';

type JsonObject = Record<string, unknown>;

// Must match DAEMON_RUNTIME_VERSION in src/daemon.js. A mismatch means the daemon
// process predates the UI bundle and must be restarted before commands are allowed.
export const DAEMON_RUNTIME_VERSION = 4;

const PROFILE_ROLES: Record<string, AgentRole[]> = {
  quick: ['worker'],
  standard: ['worker', 'reviewer'],
  deep: ['architect', 'worker', 'reviewer'],
};

export function rolesForProfile(profile: string): AgentRole[] {
  return PROFILE_ROLES[profile] ?? ['worker'];
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function mapRun(value: unknown, index: number): Run {
  const run = object(value, 'run');

  return {
    id: typeof run.id === 'string' ? run.id : `run-${index}`,
    stageId: typeof run.stage_id === 'string' ? run.stage_id : 'worker',
    attempt: Number(run.attempt ?? 0),
    status: typeof run.status === 'string' ? run.status : 'UNKNOWN',
    harness: typeof run.harness === 'string' ? run.harness : 'codex',
    sessionId: nullableString(run.session_id),
    workspace: nullableString(run.workspace),
    commitSha: nullableString(run.commit_sha),
    startedAt: nullableString(run.started_at),
    finishedAt: nullableString(run.finished_at),
    terminalAvailable: run.terminalAvailable === true,
    terminalAccess:
      run.terminalAccess === 'runner_local'
        ? 'runner_local'
        : run.terminalAccess === 'controller_local'
          ? 'controller_local'
          : 'unavailable',
    terminalActive: run.terminalActive === true,
    interactionStatus: typeof run.interactionStatus === 'string' ? run.interactionStatus : null,
    interactionTurnId: typeof run.interactionTurnId === 'string' ? run.interactionTurnId : null,
    lastAgentMessage: typeof run.lastAgentMessage === 'string' ? run.lastAgentMessage : null,
    interactionUpdatedAt:
      typeof run.interactionUpdatedAt === 'string' ? run.interactionUpdatedAt : null,
  };
}

function mapProject(value: unknown, index: number): Project {
  const project = object(value, 'project');

  return {
    id: typeof project.id === 'string' && project.id ? project.id : `project-${index}`,
    name: typeof project.name === 'string' && project.name ? project.name : `Project ${index + 1}`,
    localPath: nullableString(project.local_path),
    repositoryRoot: nullableString(project.repository_root),
    defaultBranch: nullableString(project.default_branch),
    createdAt: nullableString(project.created_at),
    updatedAt: nullableString(project.updated_at),
  };
}

class IncompatibleDaemonError extends Error {}

function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new IncompatibleDaemonError(`${name} is invalid`);
  return value as JsonObject;
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new IncompatibleDaemonError(`${name} is invalid`);
  return value;
}

function mapTaskAnalysis(value: unknown): TaskAnalysis | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const analysis = value as JsonObject;
  const kind = object(analysis.kind, 'task analysis kind');
  const readiness = object(analysis.readiness, 'task readiness');
  const recommendation = object(analysis.recommendation, 'task recommendation');
  const action = string(recommendation.action, 'recommended action');
  const profile = string(recommendation.profile, 'recommended profile');

  if (!['shape', 'investigate', 'plan', 'start'].includes(action)) return null;
  if (!['quick', 'standard', 'deep'].includes(profile)) return null;

  return {
    version: 1,
    kind: {
      value: string(kind.value, 'task kind'),
      confidence: Number(kind.confidence ?? 0),
    },
    readiness: {
      score: Number(readiness.score ?? 0),
      readyToStart: readiness.readyToStart === true,
      unresolved: Array.isArray(readiness.unresolved)
        ? readiness.unresolved.filter((item): item is string => typeof item === 'string')
        : [],
    },
    recommendation: {
      action: action as TaskAnalysis['recommendation']['action'],
      profile: profile as TaskAnalysis['recommendation']['profile'],
      reasons: Array.isArray(recommendation.reasons)
        ? recommendation.reasons.filter((item): item is string => typeof item === 'string')
        : [],
    },
  };
}

function taskState(value: unknown): TaskState {
  const states: TaskState[] = [
    'DRAFT',
    'PLAN_READY',
    'QUEUED',
    'RECOVERING',
    'EXECUTING',
    'VERIFYING',
    'REVIEWING',
    'WAITING_FOR_HUMAN',
    'READY',
    'READY_TO_FINISH',
    'MERGED',
    'RELEASED',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
    'BLOCKED',
  ];
  if (!states.includes(value as TaskState))
    throw new IncompatibleDaemonError('task state is unsupported');
  return value as TaskState;
}

function mapFinalization(value: unknown): FinalizationReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const report = value as JsonObject;

  if (report.version !== 1 || typeof report.ready !== 'boolean' || !Array.isArray(report.checks))
    throw new IncompatibleDaemonError('finalization report is unsupported');
  const state = taskState(report.state);
  const checks = report.checks.map((value) => {
    const item = object(value, 'finalization check');

    return {
      id: string(item.id, 'finalization check id'),
      label: string(item.label, 'finalization check label'),
      passed: item.passed === true,
      blocking: item.blocking === true,
      detail: nullableString(item.detail),
    };
  });
  const git =
    report.git && typeof report.git === 'object' ? object(report.git, 'finalization git') : null;

  return {
    version: 1,
    taskId: string(report.taskId, 'finalization task id'),
    runId: nullableString(report.runId),
    state,
    ready: report.ready,
    checks,
    blockingReasons: Array.isArray(report.blockingReasons)
      ? report.blockingReasons.filter((item): item is string => typeof item === 'string')
      : [],
    availableActions: Array.isArray(report.availableActions)
      ? report.availableActions.filter((item): item is string => typeof item === 'string')
      : [],
    recommendedAction: nullableString(report.recommendedAction),
    ...(git
      ? {
          git: {
            enabled: git.enabled === true,
            targetBranch: string(git.targetBranch, 'integration target branch'),
            strategy: string(git.strategy, 'integration strategy'),
            cleanup: git.cleanup === true,
            dirty: git.dirty === true,
            conflicts: typeof git.conflicts === 'boolean' ? git.conflicts : null,
            targetClean: typeof git.targetClean === 'boolean' ? git.targetClean : null,
            targetCheckedOut:
              typeof git.targetCheckedOut === 'boolean' ? git.targetCheckedOut : null,
          },
        }
      : {}),
  };
}

function threadPage(value: unknown): Task['thread'] {
  const page = object(value, 'thread page');
  if (page.version !== 1 || !Array.isArray(page.items))
    throw new IncompatibleDaemonError('thread contract version is unsupported');
  let previous = 0;
  const items = page.items.map((candidate) => {
    const item = object(candidate, 'thread item');
    const cursor = Number(item.cursor);
    if (!Number.isSafeInteger(cursor) || cursor < 1 || cursor <= previous)
      throw new IncompatibleDaemonError('thread cursor ordering is invalid');
    previous = cursor;
    const source = object(item.source, 'thread source');
    return {
      ...item,
      version: 1,
      id: string(item.id, 'thread id'),
      cursor,
      kind: string(item.kind, 'thread kind'),
      at: string(item.at, 'thread timestamp'),
      summary: string(item.summary, 'thread summary'),
      source: {
        ...source,
        kind: string(source.kind, 'thread source kind'),
        id: string(source.id, 'thread source id'),
      },
    } as ThreadItem;
  });
  return {
    version: 1,
    items,
    nextCursor:
      page.nextCursor === null || page.nextCursor === undefined ? null : Number(page.nextCursor),
    hasMore: Boolean(page.hasMore),
    redaction: 'public-safe',
  };
}

async function command(args: string[]): Promise<unknown> {
  if (sessionStorage.getItem('clew-incompatible') === '1')
    throw new Error('Daemon version mismatch; run `clew daemon restart`');
  const token = sessionStorage.getItem('clew-token');
  const response = await fetch('/api/v1/command', {
    method: 'POST',
    credentials: 'include',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      version: 1,
      requestId: crypto.randomUUID(),
      kind: 'command',
      name: 'service.execute',
      payload: { args, clientRuntimeVersion: DAEMON_RUNTIME_VERSION },
    }),
  });
  const body = object(await response.json(), 'API envelope');
  if (body.version !== 1) throw new IncompatibleDaemonError('daemon protocol is incompatible');
  if (!response.ok || body.kind === 'error') {
    const error = body.error ? object(body.error, 'API error') : {};
    throw new Error(typeof error.message === 'string' ? error.message : 'Command failed');
  }
  if (body.kind !== 'response') throw new IncompatibleDaemonError('API response kind is invalid');
  return body.payload;
}

function mapTask(showValue: unknown, threadValue: unknown, historyValue: unknown): Task {
  const show = object(showValue, 'task detail');
  const contract = object(show.contract, 'task contract');
  const history = object(historyValue, 'task history');
  const runs = Array.isArray(show.runs) ? show.runs.map((run, i) => mapRun(run, i)) : [];
  const planRecord = show.plan ? object(show.plan, 'plan') : null;
  const plan = planRecord?.plan ? object(planRecord.plan, 'execution plan') : null;
  const planStages = Array.isArray(plan?.stages)
    ? plan.stages.map((stage) => object(stage, 'plan stage'))
    : [];
  const persistedStages = Array.isArray(show.stages)
    ? show.stages.map((stageValue) => {
        const stage = object(stageValue, 'stage');
        return {
          id: string(stage.id, 'stage id'),
          status: string(stage.status, 'stage status'),
          kind: 'worker',
        };
      })
    : [];
  const stages = planStages.length
    ? planStages.map((planned) => {
        const id = string(planned.id, 'plan stage id');
        const persisted = persistedStages.find((stage) => stage.id === id);

        return {
          id,
          status: persisted?.status ?? 'PENDING',
          kind: typeof planned.kind === 'string' ? planned.kind : (persisted?.kind ?? 'worker'),
        };
      })
    : persistedStages;
  const review = show.review ? object(show.review, 'review') : null;
  const findingDetails = Array.isArray(review?.findings)
    ? review.findings.map((findingValue) => {
        const finding = object(findingValue, 'review finding');
        return {
          severity: typeof finding.severity === 'string' ? finding.severity : undefined,
          criterion: typeof finding.criterion === 'string' ? finding.criterion : undefined,
          reason: string(finding.reason, 'review finding reason'),
          target: typeof finding.target === 'string' ? finding.target : null,
        };
      })
    : [];
  const latestRevision = [...runs]
    .reverse()
    .find((run) => run.status === 'COMPLETED' && run.commitSha)?.commitSha;
  const latestRun = runs.at(-1);
  const state = taskState(show.state);
  const analysis = mapTaskAnalysis(show.analysis);

  return {
    id: string(show.id, 'task id'),
    projectId: typeof show.project_id === 'string' ? show.project_id : null,
    // Older daemon payloads did not expose created_at. Keep them usable while
    // still preferring the immutable creation timestamp for sidebar ordering.
    createdAt:
      typeof show.created_at === 'string'
        ? show.created_at
        : typeof show.updated_at === 'string'
          ? show.updated_at
          : '1970-01-01T00:00:00.000Z',
    title: string(contract.title, 'task title'),
    goal: string(contract.goal, 'task goal'),
    profile: typeof contract.profile === 'string' ? contract.profile : 'quick',
    analysis,
    architecture:
      show.architecture && typeof show.architecture === 'object'
        ? (show.architecture as Task['architecture'])
        : null,
    finalization: mapFinalization(show.finalization),
    tags: Array.isArray(contract.tags)
      ? contract.tags.filter((t): t is string => typeof t === 'string')
      : [],
    state,
    attention:
      state === 'WAITING_FOR_HUMAN'
        ? planRecord?.status === 'PENDING_APPROVAL'
          ? 'PLAN_APPROVAL_REQUIRED'
          : 'HUMAN_ACTION_REQUIRED'
        : null,
    revision: typeof latestRevision === 'string' ? latestRevision : null,
    workerOutput: typeof show.workerOutput === 'string' ? show.workerOutput : null,
    workerOutputRunId: typeof show.workerOutputRunId === 'string' ? show.workerOutputRunId : null,
    sessionId: typeof latestRun?.sessionId === 'string' ? latestRun.sessionId : null,
    sessionHarness: typeof latestRun?.harness === 'string' ? latestRun.harness : null,
    sessionStageId: typeof latestRun?.stageId === 'string' ? latestRun.stageId : null,
    sessionWorkspace: typeof latestRun?.workspace === 'string' ? latestRun.workspace : null,
    runId: typeof latestRun?.id === 'string' ? latestRun.id : null,
    runStatus: typeof latestRun?.status === 'string' ? latestRun.status : null,
    terminalAvailable: latestRun?.terminalAvailable === true,
    terminalAccess:
      latestRun?.terminalAccess === 'runner_local'
        ? 'runner_local'
        : latestRun?.terminalAccess === 'controller_local'
          ? 'controller_local'
          : 'unavailable',
    terminalActive: latestRun?.terminalActive === true,
    interactionStatus:
      typeof latestRun?.interactionStatus === 'string' ? latestRun.interactionStatus : null,
    interactionTurnId:
      typeof latestRun?.interactionTurnId === 'string' ? latestRun.interactionTurnId : null,
    lastAgentMessage:
      typeof latestRun?.lastAgentMessage === 'string' ? latestRun.lastAgentMessage : null,
    interactionUpdatedAt:
      typeof latestRun?.interactionUpdatedAt === 'string' ? latestRun.interactionUpdatedAt : null,
    harnessApprovals: Array.isArray(show.harnessApprovals)
      ? show.harnessApprovals.map((approvalValue) => {
          const approval = object(approvalValue, 'harness approval');

          return {
            id: string(approval.id, 'approval id'),
            run_id: string(approval.run_id, 'approval run id'),
            method: string(approval.method, 'approval method'),
            params: object(approval.params ?? {}, 'approval params'),
            decision: typeof approval.decision === 'string' ? approval.decision : null,
            requested_at: string(approval.requested_at, 'approval timestamp'),
            decided_at: typeof approval.decided_at === 'string' ? approval.decided_at : null,
          };
        })
      : [],
    attempts: runs.length,
    roles: rolesForProfile(
      analysis?.recommendation.profile ??
        (typeof contract.profile === 'string' ? contract.profile : 'quick'),
    ),
    runs,
    agentSessions: Array.isArray(show.agentSessions)
      ? show.agentSessions.map((sessionValue) => {
          const session = object(sessionValue, 'agent session');
          return {
            id: string(session.id, 'session id'),
            taskId: string(session.task_id, 'session task_id'),
            role: string(session.role, 'session role'),
            harness: string(session.harness, 'session harness'),
            sessionId: string(session.session_id, 'session session_id'),
            workspace: session.workspace ? string(session.workspace, 'session workspace') : null,
            terminalAccess:
              typeof session.workspace === 'string' &&
              session.workspace.startsWith('runner-workspace:')
                ? 'runner_local'
                : typeof session.workspace === 'string'
                  ? 'controller_local'
                  : 'unavailable',
            createdAt: string(session.created_at, 'session created_at'),
          };
        })
      : [],
    stages,
    reviewed: review !== null,
    findings: findingDetails.length,
    findingDetails,
    completion: show.completion
      ? (object(show.completion, 'completion') as Task['completion'])
      : null,
    thread: threadPage(threadValue),
    events: Array.isArray(history.events)
      ? history.events.map((eventValue) => {
          const event = object(eventValue, 'diagnostic event');
          return {
            seq: Number(event.seq),
            type: string(event.type, 'event type'),
            at: string(event.at, 'event timestamp'),
            payload: object(event.payload ?? {}, 'event payload'),
          };
        })
      : [],
  };
}

export async function bootstrap(): Promise<boolean> {
  try {
    const response = await fetch('/api/v1/bootstrap', { credentials: 'include' });
    const accepted =
      response.status === 204 &&
      response.headers.get('x-clew-runtime-version') === String(DAEMON_RUNTIME_VERSION);
    if (response.status === 204 && !accepted) {
      sessionStorage.removeItem('clew-session');
      sessionStorage.removeItem('clew-token');
      sessionStorage.setItem('clew-incompatible', '1');

      return false;
    }
    if (accepted) sessionStorage.removeItem('clew-incompatible');
    if (accepted) sessionStorage.setItem('clew-session', '1');
    return accepted;
  } catch {
    return false;
  }
}

async function loadSnapshot(retryBootstrap = true): Promise<JsonObject> {
  const response = await fetch('/api/v1/snapshot', { credentials: 'include' });

  if (response.status === 401 && retryBootstrap && (await bootstrap())) return loadSnapshot(false);
  const payload = object(await response.json(), 'control snapshot');

  if (!response.ok) throw new Error('Control snapshot failed');
  if (payload.version !== 1 || !Array.isArray(payload.tasks))
    throw new IncompatibleDaemonError('control snapshot version is unsupported');

  return payload;
}

export async function loadTasks(): Promise<{
  tasks: Task[];
  projects: Project[];
  state: ConnectionState;
}> {
  const forced = import.meta.env.DEV ? new URLSearchParams(location.search).get('state') : null;
  if (forced === 'empty') return { tasks: [], projects: [], state: 'fixture' };
  if (forced === 'disconnected' || forced === 'incompatible')
    return { tasks: fixtureTasks, projects: fixtureProjects, state: forced };
  try {
    const connected = await bootstrap();
    if (!connected) {
      const state =
        sessionStorage.getItem('clew-incompatible') === '1' ? 'incompatible' : 'disconnected';

      if (import.meta.env.DEV && state !== 'incompatible')
        return { tasks: fixtureTasks, projects: fixtureProjects, state: 'fixture' };
      return { tasks: [], projects: [], state };
    }
    const payload = await loadSnapshot();
    const tasks = (payload.tasks as unknown[]).map((value) => {
      const snapshot = object(value, 'task snapshot');

      return mapTask(snapshot.show, snapshot.thread, snapshot.history);
    });
    const projects = Array.isArray(payload.projects)
      ? (payload.projects as unknown[]).map((value, index) => mapProject(value, index))
      : [];

    if (Number.isSafeInteger(Number(payload.cursor)))
      sessionStorage.setItem('clew-event-cursor', String(payload.cursor));
    return { tasks, projects, state: 'connected' };
  } catch (error) {
    if (import.meta.env.DEV && !(error instanceof IncompatibleDaemonError))
      return { tasks: fixtureTasks, projects: fixtureProjects, state: 'fixture' };
    return {
      tasks: [],
      projects: [],
      state: error instanceof IncompatibleDaemonError ? 'incompatible' : 'disconnected',
    };
  }
}

export function subscribeToEvents(
  after: number,
  onEvent: (event: { cursor: number }) => void,
  onState: (state: ConnectionState) => void,
) {
  let socket: WebSocket | undefined;
  let reconnectTimer: number | undefined;
  let stopped = false;
  let reconnectDelay = 500;
  const scheduleReconnect = () => {
    if (stopped) return;
    reconnectTimer = window.setTimeout(() => void connect(), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 5000);
  };
  const connect = async () => {
    if (stopped) return;
    onState('reconnecting');
    if (!(await bootstrap())) {
      const incompatible = sessionStorage.getItem('clew-incompatible') === '1';
      if (incompatible) stopped = true;
      onState(incompatible ? 'incompatible' : 'disconnected');
      scheduleReconnect();

      return;
    }
    socket = new WebSocket(
      `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/?after=${after}`,
    );
    socket.onopen = () => {
      reconnectDelay = 500;
      onState('connected');
    };
    socket.onmessage = (message) => {
      try {
        const event = object(JSON.parse(String(message.data)), 'stream event');
        const cursor = Number(event.cursor);
        if (!Number.isSafeInteger(cursor) || cursor <= after)
          throw new IncompatibleDaemonError('stream cursor is invalid');
        after = cursor;
        sessionStorage.setItem('clew-event-cursor', String(cursor));
        onEvent({ cursor });
      } catch {
        stopped = true;
        onState('incompatible');
        socket?.close();
      }
    };
    socket.onclose = () => {
      if (!stopped) {
        onState('disconnected');
        scheduleReconnect();
      }
    };
  };
  void connect();

  return () => {
    stopped = true;
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
    socket?.close();
  };
}

export async function execute(args: string[]): Promise<unknown> {
  if (!sessionStorage.getItem('clew-token') && !sessionStorage.getItem('clew-session'))
    return { fixture: true };
  return command(args);
}
