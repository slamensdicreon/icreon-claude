import { z } from 'zod';
import {
  AgentState,
  AgentTier,
  CosPresence,
  EscalationStatus,
  EscalationType,
  ProjectStatus,
  Severity,
  TaskState,
  Workstream,
} from './enums';

/** Who caused an event. Sub-agents appear here, but never as speakers in the conversation. */
export const Actor = z.object({
  kind: z.enum(['director', 'chief_of_staff', 'agent', 'system']),
  id: z.string(),
});
export type Actor = z.infer<typeof Actor>;

export const Subject = z.object({
  kind: z.enum([
    'project',
    'phase',
    'task',
    'agent',
    'escalation',
    'artifact',
    'step',
    'gate',
    'message',
    'metric',
    'tool',
  ]),
  id: z.string(),
});
export type Subject = z.infer<typeof Subject>;

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

export const PhaseDef = z.object({
  number: z.number().int().min(0),
  name: z.string(),
  /** Hard gates wait on the Director. */
  gate: z.enum(['none', 'director']).default('none'),
  exitCriteria: z.string(),
});
export type PhaseDef = z.infer<typeof PhaseDef>;

export const RosterEntry = z.object({
  agentId: z.string(),
  role: z.string(),
  name: z.string(),
  tier: AgentTier,
  reportsTo: z.string().nullable(),
  workstream: Workstream.nullable(),
  activePhases: z.array(z.number().int()),
  model: z.string(),
});
export type RosterEntry = z.infer<typeof RosterEntry>;

export const Budgets = z.object({
  tokens: z.number().int().positive(),
  usd: z.number().positive(),
  hours: z.number().positive(),
});
export type Budgets = z.infer<typeof Budgets>;

export const Spend = z.object({
  tokens: z.number().int().nonnegative(),
  usd: z.number().nonnegative(),
  hours: z.number().nonnegative(),
});
export type Spend = z.infer<typeof Spend>;

export const EscalationOption = z.object({
  id: z.string(),
  label: z.string(),
  recommended: z.boolean().default(false),
});
export type EscalationOption = z.infer<typeof EscalationOption>;

export const EvidenceLink = z.object({
  kind: z.enum(['artifact', 'log', 'page_builder', 'delivery_host', 'pull_request']),
  label: z.string(),
  ref: z.string(),
});
export type EvidenceLink = z.infer<typeof EvidenceLink>;

/** Escalation card, as specified in design spec §5. Gate approvals are escalations of type `gate`. */
export const EscalationCard = z.object({
  escalationId: z.string(),
  type: EscalationType,
  title: z.string().max(60),
  context: z.string(),
  impact: z.string(),
  options: z.array(EscalationOption).min(1).max(4),
  defaultOptionId: z.string().nullable(),
  deadline: z.iso.datetime().nullable(),
  evidence: z.array(EvidenceLink).max(3).default([]),
  sourceTaskId: z.string().nullable(),
  /** Set for gate escalations. */
  gate: z
    .object({
      phase: z.number().int(),
      artifactId: z.string(),
      artifactVersion: z.number().int(),
      requiresConfirmation: z.boolean(),
    })
    .nullable()
    .default(null),
});
export type EscalationCard = z.infer<typeof EscalationCard>;

export const Resolution = z.object({
  optionId: z.string().nullable(),
  notes: z.string().nullable().default(null),
  by: z.enum(['director', 'default', 'chief_of_staff']),
  supersededBy: z.string().nullable().default(null),
});
export type Resolution = z.infer<typeof Resolution>;

export const MetricKey = z.enum([
  'components_registered',
  'pages_migrated',
  'media_uploaded',
  'qa_pass',
  'parity',
]);
export type MetricKey = z.infer<typeof MetricKey>;

export const CosMessageKind = z.enum([
  'text',
  'phase_brief_entry',
  'phase_brief_exit',
  'status',
  'digest',
  'directive_ack',
]);
export type CosMessageKind = z.infer<typeof CosMessageKind>;

/** Structured message sections (briefs, status answers) render as headed blocks, not prose. */
export const MessageSection = z.object({ heading: z.string(), lines: z.array(z.string()) });
export type MessageSection = z.infer<typeof MessageSection>;

// ---------------------------------------------------------------------------
// Event union
// ---------------------------------------------------------------------------

const ev = <T extends string, D extends z.ZodType>(type: T, data: D) =>
  z.object({ type: z.literal(type), data });

export const EventBody = z.discriminatedUnion('type', [
  ev(
    'project.created',
    z.object({
      name: z.string(),
      client: z.string(),
      playbook: z.object({ id: z.string(), version: z.string() }),
      budgets: Budgets,
      phases: z.array(PhaseDef),
      roster: z.array(RosterEntry),
    }),
  ),
  ev('project.status', z.object({ status: ProjectStatus })),
  ev('phase.entered', z.object({ phase: z.number().int() })),
  ev('phase.exited', z.object({ phase: z.number().int() })),
  ev(
    'task.planned',
    z.object({
      taskId: z.string(),
      phase: z.number().int(),
      workstream: Workstream.nullable(),
      role: z.string(),
      title: z.string(),
      dependsOn: z.array(z.string()).default([]),
    }),
  ),
  ev(
    'task.state',
    z.object({
      taskId: z.string(),
      from: TaskState,
      to: TaskState,
      attempt: z.number().int().min(0),
      reason: z.string().nullable().default(null),
    }),
  ),
  ev(
    'agent.state',
    z.object({
      agentId: z.string(),
      state: AgentState,
      /** One line, e.g. "Registering PromoCard, step 3 of 5". Waiting says what it waits for. */
      now: z.string().nullable(),
      taskId: z.string().nullable(),
    }),
  ),
  ev(
    'step.recorded',
    z.object({
      stepId: z.string(),
      agentId: z.string(),
      taskId: z.string(),
      toolServer: z.string(),
      operation: z.string(),
      resultCode: z.number().int(),
      durationMs: z.number().int().nonnegative(),
      tokens: z.number().int().nonnegative().default(0),
      summary: z.string(),
    }),
  ),
  ev('escalation.raised', EscalationCard),
  ev(
    'escalation.updated',
    z.object({
      escalationId: z.string(),
      status: EscalationStatus,
      deferredUntil: z.iso.datetime().nullable().default(null),
      resolution: Resolution.nullable().default(null),
    }),
  ),
  ev(
    'decision.recorded',
    z.object({
      decisionId: z.string(),
      question: z.string(),
      answer: z.string(),
      rationale: z.string(),
      decidedBy: z.enum(['director', 'chief_of_staff', 'default']),
      scopeKey: z.string(),
      escalationId: z.string().nullable(),
    }),
  ),
  ev(
    'cos.message',
    z.object({
      messageId: z.string(),
      kind: CosMessageKind,
      title: z.string().nullable().default(null),
      body: z.string(),
      sections: z.array(MessageSection).default([]),
      /** Directive acks carry the stop window. */
      proceedsAt: z.iso.datetime().nullable().default(null),
      directiveId: z.string().nullable().default(null),
    }),
  ),
  ev('director.message', z.object({ messageId: z.string(), body: z.string() })),
  ev('cos.presence', z.object({ presence: CosPresence })),
  ev(
    'artifact.versioned',
    z.object({
      artifactId: z.string(),
      kind: z.enum([
        'blueprint',
        'platform_notes',
        'inventory',
        'report',
        'handover_pack',
        'screenshot',
        'video',
        'pull_request',
      ]),
      title: z.string(),
      version: z.number().int().positive(),
    }),
  ),
  ev(
    'metric.updated',
    z.object({
      key: MetricKey,
      /** null = not yet measured. The UI must say so in words, never show 0. */
      value: z.number().nullable(),
      total: z.number().nullable(),
      unit: z.enum(['count', 'percent']),
    }),
  ),
  ev('budget.updated', z.object({ spent: Spend })),
  ev(
    'tool.health',
    z.object({
      server: z.string(),
      status: z.enum(['ok', 'degraded', 'unreachable']),
      since: z.iso.datetime(),
    }),
  ),
]);
export type EventBody = z.infer<typeof EventBody>;
export type EventType = EventBody['type'];

export const EventMeta = z.object({
  id: z.string(),
  projectId: z.string(),
  /** Per-project, gap-free, starts at 1. SSE `id:` and the resume cursor. */
  seq: z.number().int().positive(),
  ts: z.iso.datetime(),
  actor: Actor,
  subject: Subject,
  severity: Severity,
});
export type EventMeta = z.infer<typeof EventMeta>;

export const LwEvent = z.intersection(EventMeta, EventBody);
export type LwEvent = EventMeta & EventBody;

/** An event before the store assigns id, seq and ts. */
export type NewEvent = Omit<EventMeta, 'id' | 'seq' | 'ts' | 'projectId'> & EventBody;

export type EventOf<T extends EventType> = EventMeta & Extract<EventBody, { type: T }>;
