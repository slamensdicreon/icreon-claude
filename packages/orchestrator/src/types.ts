// Types shared by workflows, activities and the client. Workflow-safe: no Node imports.
import type { Budgets, EscalationType, MetricKey, NewEvent, TaskState } from '@lw/contracts';
import type { Blueprint, PlannedTask } from '@lw/plan';
import type { Playbook } from '@lw/playbook-sdk';

export const TASK_QUEUE = 'launchworks-orchestration';

export interface ProjectPolicy {
  concurrency: number;
  budgets: Budgets;
  /** Optional gates switched on in Settings, e.g. `pilot-slice-review`. */
  enabledGates: string[];
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
  | { outcome: 'access_denied'; reason: string; spent: AgentResult }
  | { outcome: 'needs_decision'; decision: AgentDecision; spent: AgentResult }
  | { outcome: 'cancelled'; spent: AgentResult }
);

/** Error type an agent activity throws when a target system refuses its credential. */
export const ACCESS_DENIED = 'AccessDenied';
/** Error type for an agent that cannot continue without a Director decision. Details: AgentDecision. */
export const NEEDS_DECISION = 'NeedsDecision';
/** Error type for an agent session that ended without finishing (refusal, budget, turn limit). */
export const AGENT_FAILED = 'AgentFailed';

export interface AgentDecision {
  summary: string;
  question: string;
  options: string[];
  recommended: string;
}
