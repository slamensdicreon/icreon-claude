// Types shared by workflows, activities and the client. Workflow-safe: no Node imports.
import type { Budgets, EscalationType, MetricKey, NewEvent, TaskState } from '@lw/contracts';
import type { Blueprint, PlannedTask } from '@lw/plan';
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
}

export type DirectiveInterpretation =
  | { kind: 'status' }
  | { kind: 'note'; interpretation: string }
  | { kind: 'replan'; interpretation: string; blueprint: Blueprint };

export interface TaskItem {
  task: PlannedTask;
  /** State the task is in when the child starts it. */
  from: 'ready' | 'blocked';
  /** Attempts already made. */
  attempt: number;
  instructions: string | null;
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
  | { outcome: 'escalate'; reason: string; spent: AgentResult }
  | {
      outcome: 'access_denied';
      reason: string;
      spent: AgentResult;
      /** The role's tools aren't connected at all, so nothing ran (rather than a refusal). */
      notConnected?: boolean;
    }
  | { outcome: 'needs_decision'; decision: AgentDecision; spent: AgentResult }
  | { outcome: 'waiting'; waiting: AgentWaiting; spent: AgentResult }
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
/** Error type for an agent session that ended without finishing (refusal, budget, turn limit). */
export const AGENT_FAILED = 'AgentFailed';

/** Other tasks in the plan still have to produce what an agent needs. */
export interface AgentWaiting {
  summary: string;
  taskIds: string[];
  /** Finished tasks sent back to their owners with fixes; the agent waits on them too. */
  sendBack?: { taskId: string; fixes: string }[];
  what: string;
}

export interface AgentDecision {
  summary: string;
  question: string;
  options: string[];
  recommended: string;
}
