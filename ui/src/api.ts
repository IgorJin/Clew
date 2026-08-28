import { fixtureTasks } from './fixtures';
import type { Task, TaskState, ThreadItem } from './types';

export type ConnectionState =
  'fixture' | 'connected' | 'disconnected' | 'reconnecting' | 'incompatible';

type JsonObject = Record<string, unknown>;

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
    'COMPLETED',
    'FAILED',
    'CANCELLED',
    'BLOCKED',
  ];
  if (!states.includes(value as TaskState))
    throw new IncompatibleDaemonError('task state is unsupported');
  return value as TaskState;
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
      name: 'cli.execute',
      payload: { args },
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
  const runs = Array.isArray(show.runs) ? show.runs.map((run) => object(run, 'run')) : [];
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
    .find((run) => run.status === 'COMPLETED' && typeof run.commit_sha === 'string')?.commit_sha;
  const latestRun = runs.at(-1);
  const state = taskState(show.state);

  return {
    id: string(show.id, 'task id'),
    title: string(contract.title, 'task title'),
    goal: string(contract.goal, 'task goal'),
    profile: typeof contract.profile === 'string' ? contract.profile : 'quick',
    state,
    attention:
      state === 'WAITING_FOR_HUMAN'
        ? planRecord?.status === 'PENDING_APPROVAL'
          ? 'PLAN_APPROVAL_REQUIRED'
          : 'HUMAN_ACTION_REQUIRED'
        : null,
    revision: typeof latestRevision === 'string' ? latestRevision : null,
    sessionId: typeof latestRun?.session_id === 'string' ? latestRun.session_id : null,
    sessionHarness: typeof latestRun?.harness === 'string' ? latestRun.harness : null,
    sessionStageId: typeof latestRun?.stage_id === 'string' ? latestRun.stage_id : null,
    sessionWorkspace: typeof latestRun?.workspace === 'string' ? latestRun.workspace : null,
    attempts: runs.length,
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
    const accepted = response.status === 204;
    if (accepted) sessionStorage.setItem('clew-session', '1');
    return accepted;
  } catch {
    return false;
  }
}

export async function loadTask(taskId: string): Promise<Task> {
  const [show, thread, history] = await Promise.all([
    command(['task', 'show', taskId]),
    command(['task', 'thread', taskId]),
    command(['task', 'history', taskId]),
  ]);
  return mapTask(show, thread, history);
}

export async function loadTasks(): Promise<{ tasks: Task[]; state: ConnectionState }> {
  const forced = import.meta.env.DEV ? new URLSearchParams(location.search).get('state') : null;
  if (forced === 'empty') return { tasks: [], state: 'fixture' };
  if (forced === 'disconnected' || forced === 'incompatible')
    return { tasks: fixtureTasks, state: forced };
  if (!sessionStorage.getItem('clew-token') && !sessionStorage.getItem('clew-session')) {
    const connected = await bootstrap();
    if (!connected)
      return import.meta.env.DEV
        ? { tasks: fixtureTasks, state: 'fixture' }
        : { tasks: [], state: 'disconnected' };
  }
  try {
    const payload = await command(['task', 'list']);
    if (!Array.isArray(payload)) throw new IncompatibleDaemonError('task list is invalid');
    const tasks = await Promise.all(
      payload.map((value) => loadTask(string(object(value, 'task list item').id, 'task id'))),
    );
    return { tasks, state: 'connected' };
  } catch (error) {
    if (import.meta.env.DEV && !(error instanceof IncompatibleDaemonError))
      return { tasks: fixtureTasks, state: 'fixture' };
    return {
      tasks: [],
      state: error instanceof IncompatibleDaemonError ? 'incompatible' : 'disconnected',
    };
  }
}

export function subscribeToEvents(
  after: number,
  onEvent: (event: { cursor: number }) => void,
  onState: (state: ConnectionState) => void,
) {
  if (!sessionStorage.getItem('clew-token') && !sessionStorage.getItem('clew-session'))
    return () => undefined;
  let socket: WebSocket | undefined;
  let stopped = false;
  let reconnectDelay = 500;
  const connect = () => {
    if (stopped) return;
    onState('reconnecting');
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
        window.setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, 5000);
      }
    };
  };
  connect();

  return () => {
    stopped = true;
    socket?.close();
  };
}

export async function execute(args: string[]): Promise<unknown> {
  if (!sessionStorage.getItem('clew-token') && !sessionStorage.getItem('clew-session'))
    return { fixture: true };
  return command(args);
}
