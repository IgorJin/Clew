export type TaskState =
  | 'DRAFT'
  | 'PLAN_READY'
  | 'QUEUED'
  | 'RECOVERING'
  | 'EXECUTING'
  | 'VERIFYING'
  | 'REVIEWING'
  | 'WAITING_FOR_HUMAN'
  | 'READY'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'BLOCKED';

export type ThreadItem = {
  version: 1;
  id: string;
  cursor: number;
  kind: string;
  at: string;
  source: { kind: string; id: string; eventType?: string };
  summary: string;
  taskId?: string | null;
  stageId?: string | null;
  runId?: string | null;
  actor?: string;
  redacted?: boolean;
  target?: { stageId?: string; runId?: string } | null;
};

export type Task = {
  id: string;
  title: string;
  goal: string;
  profile: string;
  state: TaskState;
  attention?: string | null;
  revision?: string | null;
  sessionId?: string | null;
  sessionHarness?: string | null;
  sessionStageId?: string | null;
  sessionWorkspace?: string | null;
  attempts: number;
  stages: { id: string; status: string; kind: string }[];
  reviewed?: boolean;
  findings: number;
  findingDetails?: {
    severity?: string;
    criterion?: string;
    reason: string;
    target?: string | null;
  }[];
  completion?: { at?: string; actor?: string } | null;
  thread: {
    version: 1;
    items: ThreadItem[];
    nextCursor: number | null;
    hasMore: boolean;
    redaction: 'public-safe';
  };
  events: { seq: number; type: string; at: string; payload: Record<string, unknown> }[];
};
