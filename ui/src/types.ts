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

export type AgentRole = 'architect' | 'worker' | 'reviewer' | 'qa';

export type AgentSession = {
  id: string;
  taskId: string;
  role: string;
  harness: string;
  sessionId: string;
  workspace: string | null;
  createdAt: string;
};

export type Run = {
  id: string;
  stageId: string;
  attempt: number;
  status: string;
  harness: string;
  sessionId: string | null;
  workspace: string | null;
  commitSha: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  terminalAvailable?: boolean;
  terminalAccess?: 'controller_local' | 'runner_local' | 'unavailable';
  terminalActive?: boolean;
  interactionStatus?: string | null;
  interactionTurnId?: string | null;
  lastAgentMessage?: string | null;
  interactionUpdatedAt?: string | null;
};

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
  tags: string[];
  state: TaskState;
  attention?: string | null;
  revision?: string | null;
  roles: AgentRole[];
  runs: Run[];
  agentSessions: AgentSession[];
  workerOutput?: string | null;
  workerOutputRunId?: string | null;
  sessionId?: string | null;
  sessionHarness?: string | null;
  sessionStageId?: string | null;
  sessionWorkspace?: string | null;
  runId?: string | null;
  runStatus?: string | null;
  terminalAvailable?: boolean;
  terminalAccess?: 'controller_local' | 'runner_local' | 'unavailable';
  terminalActive?: boolean;
  interactionStatus?: string | null;
  interactionTurnId?: string | null;
  lastAgentMessage?: string | null;
  interactionUpdatedAt?: string | null;
  harnessApprovals?: {
    id: string;
    run_id: string;
    method: string;
    params: Record<string, unknown>;
    decision?: string | null;
    requested_at: string;
    decided_at?: string | null;
  }[];
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

export type NextStep = {
  id?: string;
  taskId: string;
  kind: string;
  currentStep: string;
  resultingStep?: string;
  summary: string;
  inputs?: Record<string, string>;
  sideEffects?: string[];
  approvalRequired: boolean;
  status?: string;
};
