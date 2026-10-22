import { z } from 'zod';
import {
  AgentState,
  AgentTier,
  CosPresence,
  EscalationStatus,
  Health,
  PhaseStatus,
  ProjectStatus,
  Severity,
  TaskState,
  Workstream,
} from './enums';
import {
  Budgets,
  CosMessageKind,
  EscalationCard,
  MessageSection,
  MetricKey,
  Resolution,
  Spend,
} from './events';

/**
 * Every snapshot carries the `seq` it reflects. Fetch the snapshot, then open the SSE stream with
 * `?after=<seq>` and apply events on top. No gap, no duplicate.
 */
const Seq = z.number().int().nonnegative();

export const PhaseView = z.object({
  number: z.number().int(),
  name: z.string(),
  status: PhaseStatus,
  gate: z.enum(['none', 'director']),
  exitCriteria: z.string(),
  /** null for future phases: the stepper never shows a percent it hasn't measured. */
  percent: z.number().min(0).max(100).nullable(),
  tasksRunning: z.number().int(),
  tasksQueued: z.number().int(),
  tasksDone: z.number().int(),
  tasksTotal: z.number().int(),
});
export type PhaseView = z.infer<typeof PhaseView>;

export const EscalationView = EscalationCard.extend({
  status: EscalationStatus,
  raisedAt: z.iso.datetime(),
  deferredUntil: z.iso.datetime().nullable(),
  resolution: Resolution.nullable(),
  resolvedAt: z.iso.datetime().nullable(),
});
export type EscalationView = z.infer<typeof EscalationView>;

export const ProjectSummary = z.object({
  id: z.string(),
  name: z.string(),
  client: z.string(),
  status: ProjectStatus,
  health: Health,
  /** Why health is not green, in words ("Blocker open: Media upload 403"). */
  healthReason: z.string().nullable(),
  currentPhase: z
    .object({ number: z.number().int(), name: z.string(), percent: z.number() })
    .nullable(),
  nextGate: z.object({ phase: z.number().int(), name: z.string() }).nullable(),
  waitingCount: z.number().int(),
  hasOpenBlocker: z.boolean(),
  startedAt: z.iso.datetime().nullable(),
  budgets: Budgets,
  spent: Spend,
  presence: CosPresence,
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;

export const LeadRow = z.object({
  agentId: z.string(),
  name: z.string(),
  workstream: Workstream,
  active: z.number().int(),
  blocked: z.number().int(),
  waiting: z.number().int(),
  done: z.number().int(),
});
export type LeadRow = z.infer<typeof LeadRow>;

export const MetricView = z.object({
  key: MetricKey,
  label: z.string(),
  /** null = not yet measured. */
  value: z.number().nullable(),
  total: z.number().nullable(),
  unit: z.enum(['count', 'percent']),
});
export type MetricView = z.infer<typeof MetricView>;

export const ActivityItem = z.object({
  seq: z.number().int(),
  ts: z.iso.datetime(),
  type: z.string(),
  severity: Severity,
  phase: z.number().int().nullable(),
  agentId: z.string().nullable(),
  taskId: z.string().nullable(),
  toolServer: z.string().nullable(),
  operation: z.string().nullable(),
  resultCode: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  tokens: z.number().int().nullable(),
  summary: z.string(),
});
export type ActivityItem = z.infer<typeof ActivityItem>;

export const MissionControlSnapshot = z.object({
  seq: Seq,
  project: ProjectSummary,
  /** Open and deferred escalations, Blocker → Decision → Access → Budget → Risk, then by age. */
  waitingOnYou: z.array(EscalationView),
  phases: z.array(PhaseView),
  teamNow: z.array(LeadRow),
  metrics: z.array(MetricView),
  latest: z.array(ActivityItem).max(3),
});
export type MissionControlSnapshot = z.infer<typeof MissionControlSnapshot>;

export const StepView = z.object({
  stepId: z.string(),
  ts: z.iso.datetime(),
  toolServer: z.string(),
  operation: z.string(),
  resultCode: z.number().int(),
  durationMs: z.number().int(),
  summary: z.string(),
});
export type StepView = z.infer<typeof StepView>;

export const AgentView = z.object({
  agentId: z.string(),
  role: z.string(),
  name: z.string(),
  tier: AgentTier,
  reportsTo: z.string().nullable(),
  workstream: Workstream.nullable(),
  model: z.string(),
  activePhases: z.array(z.number().int()),
  state: AgentState,
  now: z.string().nullable(),
  taskId: z.string().nullable(),
  tokensThisTask: z.number().int(),
  since: z.iso.datetime().nullable(),
});
export type AgentView = z.infer<typeof AgentView>;

export const AgentDetail = AgentView.extend({ lastSteps: z.array(StepView).max(3) });
export type AgentDetail = z.infer<typeof AgentDetail>;

export const TeamSnapshot = z.object({ seq: Seq, agents: z.array(AgentView) });
export type TeamSnapshot = z.infer<typeof TeamSnapshot>;

export const TaskView = z.object({
  taskId: z.string(),
  phase: z.number().int(),
  workstream: Workstream.nullable(),
  role: z.string(),
  title: z.string(),
  state: TaskState,
  attempt: z.number().int(),
  dependsOn: z.array(z.string()),
  startedAt: z.iso.datetime().nullable(),
  endedAt: z.iso.datetime().nullable(),
  /** Set when blocked: the escalation it waits on. */
  escalationId: z.string().nullable(),
  lastReason: z.string().nullable(),
});
export type TaskView = z.infer<typeof TaskView>;

export const PlanSnapshot = z.object({
  seq: Seq,
  phases: z.array(PhaseView),
  tasks: z.array(TaskView),
});
export type PlanSnapshot = z.infer<typeof PlanSnapshot>;

export const ActivityPage = z.object({
  items: z.array(ActivityItem),
  /** Pass as `before` to page further back; null at the start of the log. */
  nextBefore: z.number().int().nullable(),
});
export type ActivityPage = z.infer<typeof ActivityPage>;

export const ConversationItem = z.object({
  messageId: z.string(),
  seq: z.number().int(),
  ts: z.iso.datetime(),
  from: z.enum(['director', 'chief_of_staff']),
  kind: CosMessageKind.or(z.literal('director')),
  title: z.string().nullable(),
  body: z.string(),
  sections: z.array(MessageSection),
  proceedsAt: z.iso.datetime().nullable(),
  directiveId: z.string().nullable(),
});
export type ConversationItem = z.infer<typeof ConversationItem>;

export const ConversationSnapshot = z.object({
  seq: Seq,
  presence: CosPresence,
  items: z.array(ConversationItem),
  queue: z.array(EscalationView),
});
export type ConversationSnapshot = z.infer<typeof ConversationSnapshot>;

export const DecisionView = z.object({
  decisionId: z.string(),
  ts: z.iso.datetime(),
  question: z.string(),
  answer: z.string(),
  rationale: z.string(),
  decidedBy: z.enum(['director', 'chief_of_staff', 'default']),
  scopeKey: z.string(),
  escalationId: z.string().nullable(),
});
export type DecisionView = z.infer<typeof DecisionView>;

export const ProjectListItem = ProjectSummary.pick({
  id: true,
  name: true,
  client: true,
  status: true,
  health: true,
  waitingCount: true,
  hasOpenBlocker: true,
  currentPhase: true,
});
export type ProjectListItem = z.infer<typeof ProjectListItem>;
