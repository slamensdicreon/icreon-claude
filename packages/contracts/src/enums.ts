import { z } from 'zod';

/** Agent states, as named in the design spec (§11 "Agent and task states"). */
export const AgentState = z.enum([
  'inactive', // specialist not instantiated in the current phase ("not in this phase")
  'idle',
  'active',
  'waiting',
  'blocked',
  'failed',
  'done',
  'paused', // held by the Director; resumes where it stopped
]);
export type AgentState = z.infer<typeof AgentState>;

/** Task states (requirements §9, plus `paused` so the UI can tell it apart from `blocked`). */
export const TaskState = z.enum([
  'planned',
  'ready',
  'running',
  'validating',
  'done',
  'rejected',
  'blocked',
  'paused',
  'cancelled',
  'rolled_back',
  'waiting', // waits on a decision or a consult; not a failure
]);
export type TaskState = z.infer<typeof TaskState>;

export const PhaseStatus = z.enum(['future', 'current', 'done']);
export type PhaseStatus = z.infer<typeof PhaseStatus>;

export const ProjectStatus = z.enum([
  'intake',
  'running',
  'paused',
  'completed',
  'cancelled',
  'archived',
]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

export const Health = z.enum(['healthy', 'attention', 'blocked']);
export type Health = z.infer<typeof Health>;

export const EscalationType = z.enum(['blocker', 'decision', 'access', 'budget', 'risk', 'gate']);
export type EscalationType = z.infer<typeof EscalationType>;

/**
 * What a card asks about, which decides who may answer it (Settings → Autonomy): media sources,
 * tool problems, retries after rejections, who owns missing work, naming and structure, content
 * within the Blueprint, access, scope, and releases, gates and budget.
 */
export const DecisionCategory = z.enum([
  'media',
  'tool',
  'retry',
  'ownership',
  'naming',
  'content',
  'access',
  'scope',
  'release',
  'other',
]);
export type DecisionCategory = z.infer<typeof DecisionCategory>;

/**
 * Who may settle a category of card. agents: the agent proceeds with its recommendation (logged).
 * lead: the task's Lead answers; the card reaches the Director only if the Lead forwards it.
 * shadow: the Lead answers for the record, and the card still goes to the Director, so the two
 * can be compared before the Lead is trusted with it. ask: always the Director.
 */
export const AutonomyLevel = z.enum(['agents', 'lead', 'shadow', 'ask']);
export type AutonomyLevel = z.infer<typeof AutonomyLevel>;

export const DECISION_CATEGORY_LABEL: Record<DecisionCategory, string> = {
  media: 'Media sources',
  tool: 'Tool problems',
  retry: 'Retries after rejection',
  ownership: 'Ownership and missing work',
  naming: 'Naming and structure',
  content: 'Content within the Blueprint',
  access: 'Access and permissions',
  scope: 'Scope',
  release: 'Releases, gates and budget',
  other: 'Other',
};

export const EscalationStatus = z.enum(['open', 'deferred', 'expired', 'resolved', 'superseded']);
export type EscalationStatus = z.infer<typeof EscalationStatus>;

export const Workstream = z.enum(['discovery', 'engineering', 'content', 'quality']);
export type Workstream = z.infer<typeof Workstream>;

export const AgentTier = z.enum(['chief_of_staff', 'lead', 'specialist']);
export type AgentTier = z.infer<typeof AgentTier>;

export const Severity = z.enum(['routine', 'notable', 'warning', 'failure']);
export type Severity = z.infer<typeof Severity>;

export const CosPresence = z.enum(['listening', 'thinking', 'briefing']);
export type CosPresence = z.infer<typeof CosPresence>;

export const ControlVerb = z.enum(['pause', 'resume', 'cancel']);
export type ControlVerb = z.infer<typeof ControlVerb>;

export const ScopeKind = z.enum(['project', 'phase', 'workstream', 'task', 'agent']);
export type ScopeKind = z.infer<typeof ScopeKind>;

/** Breakpoints every visual comparison and screenshot uses. */
export const Breakpoint = z.enum(['desktop', 'tablet', 'phone']);
export type Breakpoint = z.infer<typeof Breakpoint>;
