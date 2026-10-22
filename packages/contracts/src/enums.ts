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
]);
export type TaskState = z.infer<typeof TaskState>;

export const PhaseStatus = z.enum(['future', 'current', 'done']);
export type PhaseStatus = z.infer<typeof PhaseStatus>;

export const ProjectStatus = z.enum(['intake', 'running', 'paused', 'completed', 'cancelled']);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

export const Health = z.enum(['healthy', 'attention', 'blocked']);
export type Health = z.infer<typeof Health>;

export const EscalationType = z.enum(['blocker', 'decision', 'access', 'budget', 'risk', 'gate']);
export type EscalationType = z.infer<typeof EscalationType>;

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
