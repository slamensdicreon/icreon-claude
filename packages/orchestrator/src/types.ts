// Types shared by workflows, activities and the client. Workflow-safe: no Node imports.
import type {
  DecisionCategory,
  AgentState,
  Budgets,
  EscalationCard,
  EscalationStatus,
  EscalationType,
  MetricKey,
  NewEvent,
  TaskState,
} from '@lw/contracts';
import type { Blueprint, Plan, PlannedTask } from '@lw/plan';
import type { Playbook } from '@lw/playbook-sdk';

export const TASK_QUEUE = 'launchworks-orchestration';

/**
 * Each playbook's projects run on a queue of their own, served by a worker with that playbook's
 * agents and tools. The first playbook keeps the original queue name, so projects started before
 * there was a catalog keep running.
 */
export function taskQueueFor(playbookId: string): string {
  return playbookId === 'sitecoreai-migration' ? TASK_QUEUE : `${TASK_QUEUE}.${playbookId}`;
}

export interface ProjectPolicy {
  concurrency: number;
  budgets: Budgets;
  /** Optional gates switched on in Settings, e.g. `pilot-slice-review`. */
  enabledGates: string[];
  /**
   * Features the brief confirms (e.g. `personalization`). Plan templates with `when` need one;
   * none are assumed, because installed packages don't prove a product is licensed.
   */
  features?: string[];
  /** Default-action deadline per escalation type, in ms. Missing type = waits for the Director. */
  escalationDeadlinesMs: Partial<Record<EscalationType, number>>;
  /** Stop window after a directive acknowledgement. Spec: 30 s. */
  directiveWindowMs: number;
  /** How long a reversible Director choice can be undone before it takes effect. Spec: 10 s. */
  undoWindowMs: number;
  /**
   * History length at which the project workflow starts a fresh run (continue-as-new) at its next
   * quiet moment, so a restarted worker never replays a long history. Default 4,000 events.
   */
  continueAsNewAt?: number;
}

export interface ProjectInput {
  projectId: string;
  name: string;
  client: string;
  playbook: Playbook;
  policy: ProjectPolicy;
  /** Site definition from intake. */
  site?: { sourceUrl: string | null };
  /**
   * The project was recorded by the New Project wizard (project.created, credentials), so the
   * workflow starts it rather than creating it.
   */
  registered?: boolean;
  /** Set when a run continues as new: the state the previous run handed over. */
  resume?: ProjectSnapshot;
}

/**
 * What a project card does once answered. Data, not a callback, so an open card survives the
 * workflow continuing as new.
 */
export type Resolver =
  | {
      kind: 'agent-decision';
      taskId: string;
      question: string;
      options: { id: string; label: string }[];
    }
  | { kind: 'blocked'; taskId: string }
  | { kind: 'budget' }
  | {
      kind: 'gate';
      key: string;
      phase: number;
      coveredTasks: string[];
      checkpointTaskId: string | null;
    };

/** An unanswered card carried into the next run. */
export interface EscalationSnapshot {
  card: EscalationCard;
  status: EscalationStatus;
  deadlineAt: number | null;
  windowMs: number | null;
  deferredUntil: number | null;
  resolver: Resolver;
}

/**
 * The project workflow's state at a quiet moment (no agent session running, no undo or directive
 * window open), handed to its next run. Everything else the workflow knows is in the event log.
 */
export interface ProjectSnapshot {
  startedAt: number;
  blueprint: Blueprint | null;
  plan: Plan;
  states: Record<string, TaskState>;
  attempts: Record<string, number>;
  instructions: Record<string, string | null>;
  retryFromBlocked: string[];
  reruns: string[];
  waitingOn: [string, { ids: string[]; what: string; prior: string | null; note?: string }][];
  /** Absent in snapshots taken before capability gaps existed. */
  capabilityWait?: [string, string][];
  /** Lead answers in a row per task, and what they were (absent before Lead triage). */
  leadAnswers?: Record<string, number>;
  leadNotes?: Record<string, string[]>;
  waits: Record<string, number>;
  sentBack: Record<string, number>;
  /** Sent-back tasks held until the earlier ones of their group are redone (absent before). */
  holdUntil?: [string, string[]][];
  /** Tasks to check again without their agent when they next run (absent before). */
  revalidate?: string[];
  /** Tasks redone after a review sent them back, until they finish again (absent before). */
  redoing?: string[];
  taskEscalation: [string, string][];
  started: number[];
  done: number[];
  gates: [string, { status: 'none' | 'pending' | 'approved'; escalationId: string | null }][];
  escalations: EscalationSnapshot[];
  agentStates: [string, AgentState][];
  pausedRoles: string[];
  pausedPhases: number[];
  pausedTasks: string[];
  cancelledPhases: number[];
  artifactVersions: [string, number][];
  phaseArtifact: [number, { artifactId: string; title: string; version: number }][];
  spent: { tokens: number; usd: number };
  flags: {
    projectPaused: boolean;
    budgetHold: boolean;
    softWarned: boolean;
    hardStopped: boolean;
    budgetPaused: boolean;
  };
  childRuns: number;
  /** Which run of the project this is, from 1. */
  run: number;
}

export interface AgentRequest {
  projectId: string;
  task: PlannedTask;
  attempt: number;
  /** Lead feedback from the previous rejection, if any. */
  feedback: string | null;
  /** Director instructions (re-run with instructions, send back with notes). */
  instructions: string | null;
}

export interface AgentResult {
  tokens: number;
  usd: number;
  /** Measured values reported by the task (e.g. parity from the Parity Auditor). */
  metrics?: Partial<Record<MetricKey, number>>;
  /** What the agent says it did; its Lead reviews it against the steps it took. */
  summary?: string;
  /** Artifacts the task produced; the orchestrator assigns versions. */
  artifacts?: { artifactId: string; kind: ArtifactKind; title: string }[];
}

export type ArtifactKind = Extract<NewEvent, { type: 'artifact.versioned' }>['data']['kind'];

export interface ValidationResult {
  pass: boolean;
  reason: string | null;
  /** Failed because of other tasks' work: wait on them (and send them back) instead of retrying. */
  waitOn?: AgentWaiting;
  /** The automated checks as they stood, for the card a rejected task may end in. */
  checks?: CheckStanding[];
}

/** One acceptance check's standing at a review. */
export interface CheckStanding {
  id: string;
  status: 'pass' | 'fail' | 'pending';
}

export type DirectiveInterpretation =
  | { kind: 'status' }
  | { kind: 'note'; interpretation: string }
  | { kind: 'replan'; interpretation: string; blueprint: Blueprint }
  /** Run these tasks again, with these instructions. */
  | { kind: 'rerun'; interpretation: string; taskIds: string[]; notes: string };

export interface TaskItem {
  task: PlannedTask;
  /** State the task is in when the child starts it. */
  from: 'ready' | 'blocked';
  /** Attempts already made. */
  attempt: number;
  instructions: string | null;
  /** Check the task again without running its agent: what it waited on has been redone. */
  revalidate?: boolean;
}

export interface TaskInput {
  projectId: string;
  /** One task, or a batch of same-template tasks for one agent session. */
  items: TaskItem[];
  paused: boolean;
}

/** `state` is where the child left the task, so the parent's next transition starts from it. */
export type TaskOutcome = { state: TaskState; attempt: number } & (
  | { outcome: 'done'; result: AgentResult }
  | { outcome: 'escalate'; reason: string; spent: AgentResult; checks?: CheckStanding[] }
  | {
      outcome: 'access_denied';
      reason: string;
      spent: AgentResult;
      /** The role's tools aren't connected at all, so nothing ran (rather than a refusal). */
      notConnected?: boolean;
    }
  | { outcome: 'needs_decision'; decision: AgentDecision; spent: AgentResult }
  | { outcome: 'waiting'; waiting: AgentWaiting; spent: AgentResult }
  /** The agent's tools can't do a step: the task waits for engineering to add the capability. */
  | { outcome: 'capability_gap'; summary: string; capability: string; spent: AgentResult }
  | { outcome: 'cancelled'; spent: AgentResult }
);

/** Error type an agent activity throws when a target system refuses its credential. */
export const ACCESS_DENIED = 'AccessDenied';
/** Error type for a live project's task whose role has no connected tools: nothing was run. */
export const NOT_CONNECTED = 'NotConnected';
/** Error type for an agent that cannot continue without a Director decision. Details: AgentDecision. */
export const NEEDS_DECISION = 'NeedsDecision';
/** Error type for an agent waiting on other tasks in the plan. Details: AgentWaiting. */
export const WAITING = 'WaitingOnTasks';
/** Error type for an agent whose tools can't do a step. Details: { summary, capability }. */
export const CAPABILITY_GAP = 'CapabilityGap';
/** Error type for an agent session that ended without finishing (refusal, budget, turn limit). */
export const AGENT_FAILED = 'AgentFailed';

/** Other tasks in the plan still have to produce what an agent needs. */
export interface AgentWaiting {
  summary: string;
  taskIds: string[];
  /** Finished tasks sent back to their owners with fixes; the agent waits on them too. */
  sendBack?: { taskId: string; fixes: string }[];
  what: string;
  /**
   * Set when the Lead's review, not the agent, found the work waits on others: once they are
   * redone, the task is checked again without running its agent, unless it has fixes of its own.
   */
  review?: { fixes: string | null };
}

export interface AgentDecision {
  summary: string;
  question: string;
  options: string[];
  recommended: string;
}

/** A question an agent stopped on, for its Lead to see before the Director does. */
export interface TriageRequest {
  projectId: string;
  taskId: string;
  role: string;
  category: DecisionCategory;
  card: {
    title: string;
    context: string;
    impact: string;
    options: { id: string; label: string; recommended: boolean }[];
  };
  /** This task's earlier Lead answers, oldest first. */
  previous: string[];
}

/**
 * What triage made of it, by the category's autonomy level. ask: straight to the Director.
 * agents: the agent's recommendation stands. lead and shadow: the Lead's answer, or why it
 * forwarded; in shadow the card still goes to the Director, with the answer on it.
 */
export type TriageOutcome =
  | { level: 'ask'; tokens: number; usd: number }
  | { level: 'agents'; tokens: number; usd: number }
  | {
      level: 'lead' | 'shadow';
      leadId: string;
      leadName: string;
      decision: 'answer';
      optionId: string;
      reasoning: string;
      ruleIds: string[];
      tokens: number;
      usd: number;
    }
  | {
      level: 'lead' | 'shadow';
      leadId: string;
      leadName: string;
      decision: 'forward';
      reasoning: string;
      tokens: number;
      usd: number;
    };
