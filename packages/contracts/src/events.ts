import { z } from 'zod';
import {
  AgentState,
  AgentTier,
  Breakpoint,
  CosPresence,
  DecisionCategory,
  EscalationStatus,
  EscalationType,
  ProjectStatus,
  ScopeKind,
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
  /** One word for the strip and stepper ("Components"). */
  shortName: z.string().nullable().default(null),
  /** Hard gates wait on the Director. */
  gate: z.enum(['none', 'director']).default('none'),
  gateLabel: z.string().nullable().default(null),
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
  /** The person this role is shown as ("Emily Chen"); the Chief of Staff's is "Cypher". */
  persona: z.string().nullable().default(null),
  /** What the role does, in plain words for the Director (Team cards, inspector). */
  description: z.string().default(''),
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
  /** Letter shown on the card and typed as a shortcut (A, B, C). Defaults to the position. */
  key: z.string().max(2).nullable().default(null),
});
export type EscalationOption = z.infer<typeof EscalationOption>;

/**
 * Where an evidence chip (or any jump link) goes. `ref` by kind: artifact id, agent id, activity
 * filter text, preview page path, settings section, or an absolute URL for external systems.
 */
export const LinkTarget = z.object({
  kind: z.enum([
    'artifact',
    'agent',
    'task',
    'activity',
    'preview',
    'settings',
    'surface',
    'decision',
    'external',
    // Earlier names, kept so old events still parse.
    'log',
    'page_builder',
    'delivery_host',
    'pull_request',
  ]),
  ref: z.string(),
});
export type LinkTarget = z.infer<typeof LinkTarget>;

export const EvidenceLink = LinkTarget.extend({ label: z.string() });
export type EvidenceLink = z.infer<typeof EvidenceLink>;

/** Escalation card, as specified in design spec §5. Gate approvals are escalations of type `gate`. */
/** What a Lead made of a card before it reached the Director. */
export const LeadTriage = z.object({
  leadId: z.string(),
  /**
   * shadow: the Lead answered, for comparison; forwarded: the Lead passed it on; decided: the
   * Lead settled it (the card is resolved by the Lead or a rule).
   */
  mode: z.enum(['shadow', 'forwarded', 'decided']),
  /** The option the Lead chose; null when forwarded. */
  optionId: z.string().nullable(),
  reasoning: z.string(),
  /** Rules the Lead applied. */
  ruleIds: z.array(z.string()).default([]),
});
export type LeadTriage = z.infer<typeof LeadTriage>;

export const EscalationCard = z.object({
  escalationId: z.string(),
  type: EscalationType,
  title: z.string().max(120),
  context: z.string(),
  impact: z.string(),
  options: z.array(EscalationOption).min(1).max(4),
  defaultOptionId: z.string().nullable(),
  deadline: z.iso.datetime().nullable(),
  evidence: z.array(EvidenceLink).max(4).default([]),
  sourceTaskId: z.string().nullable(),
  /** Overrides the type's label on the card ("Gate 1", "Review"). */
  typeLabel: z.string().nullable().default(null),
  /** For escalations without a default: what happens meanwhile ("Batch 2 continues meanwhile"). */
  waitNote: z.string().nullable().default(null),
  /** Whether a choice can be undone during the undo window. */
  reversible: z.boolean().default(true),
  /** What the card asks about; read from its words when absent (cards raised before triage). */
  category: DecisionCategory.nullable().default(null),
  /** The Lead's answer when triage saw the card first: in shadow, or why it was forwarded. */
  triage: LeadTriage.nullable().default(null),
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
/** An escalation card before defaults apply (what raisers write). */
export type EscalationCardInput = z.input<typeof EscalationCard>;

export const Resolution = z.object({
  optionId: z.string().nullable(),
  notes: z.string().nullable().default(null),
  by: z.enum(['director', 'default', 'chief_of_staff', 'lead', 'rule']),
  supersededBy: z.string().nullable().default(null),
});
export type Resolution = z.infer<typeof Resolution>;

export const MetricKey = z.enum([
  'components_registered',
  'pages_migrated',
  'media_uploaded',
  'qa_pass',
  'parity',
  'source_mapped',
]);
export type MetricKey = z.infer<typeof MetricKey>;

export const CosMessageKind = z.enum([
  'text',
  'brief',
  'status',
  'needs',
  'next',
  'digest',
  'directive_ack',
  // Earlier names for briefs, kept so old events still parse.
  'phase_brief_entry',
  'phase_brief_exit',
]);
export type CosMessageKind = z.infer<typeof CosMessageKind>;

/** Structured message sections (briefs, status answers) render as headed blocks, not prose. */
export const MessageSection = z.object({ heading: z.string(), lines: z.array(z.string()) });
export type MessageSection = z.infer<typeof MessageSection>;

/** A button under a message or inside an embed ("Open Blueprint"). */
export const MessageLink = z.object({ label: z.string(), target: LinkTarget });
export type MessageLink = z.infer<typeof MessageLink>;

/** The status card Cypher answers "Status" with. Numbers as of the message, in words. */
export const StatusCard = z.object({
  phase: z.string(),
  percent: z.number(),
  blockers: z.array(z.string()),
  waiting: z.number().int(),
  headline: z.object({ label: z.string(), value: z.string(), sub: z.string().nullable() }),
  nextGate: z.string(),
  cost: z.string(),
  elapsed: z.string(),
});
export type StatusCard = z.infer<typeof StatusCard>;

export const ProjectSource = z.object({
  repo: z.string().nullable(),
  url: z.string().nullable(),
  /** "Vite 7, React 19", "Next.js 16". */
  framework: z.string().nullable(),
  /** How the source pane is labelled ("Vite build of ansell-main"). */
  label: z.string().nullable(),
});
export type ProjectSource = z.infer<typeof ProjectSource>;

/**
 * How a project names its target, as its platform pack describes it (`pack.describe`). The pack
 * decides what the two names mean: a SitecoreAI site collection and site, an Optimizely
 * application and its type prefix.
 */
export const ProjectTarget = z.object({
  /** The platform's container for the site (SitecoreAI: site collection). */
  collection: z.string().nullable(),
  site: z.string().nullable(),
  /** Hosting project for the head ("Vercel, ansell-website"). */
  hosting: z.string().nullable(),
});
export type ProjectTarget = z.infer<typeof ProjectTarget>;

/**
 * The repository the new site is built in: in our GitHub organization while we build, moved to the
 * client's at handover. Created from the platform pack's starter; agents work on `launchworks/*`
 * branches.
 */
export const BuildRepo = z.object({
  /** "owner/name" */
  repo: z.string(),
  branch: z.string(),
  /** The GitHub App installation on the organization that holds it. */
  installationId: z.number().int(),
  url: z.string().url(),
  /** The template it was created from ("Sitecore/xmcloud-starter-js"). */
  template: z.string(),
  /** Where the Next.js app lives in it ("examples/basic-nextjs"). */
  appPath: z.string(),
});
export type BuildRepo = z.infer<typeof BuildRepo>;

/** The project's head on our Vercel team: the stable preview of the site and its editing host. */
export const HostingState = z.object({
  provider: z.literal('vercel'),
  /** The Vercel project's name. */
  project: z.string(),
  /** Its production URL, once a production deployment is ready. */
  url: z.string().nullable(),
});
export type HostingState = z.infer<typeof HostingState>;

/** A value the wizard collects for a playbook's target: text, or a list (languages). */
export const IntakeValue = z.union([z.string(), z.array(z.string())]);
export type IntakeValue = z.infer<typeof IntakeValue>;

/**
 * Intake records from before playbooks declared their own intake held SitecoreAI's fields at the
 * top level. Read them as SitecoreAI targets; the event log itself is never rewritten.
 */
export function normalizeIntake(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || 'target' in raw) return raw;
  const r = raw as Record<string, unknown>;
  const hosting = r.hosting as { project?: string } | undefined;
  return {
    platform: 'sitecoreai',
    repo: r.repo ?? null,
    branch: r.branch ?? null,
    target: {
      cmHost: r.cmHost,
      siteCollection: r.siteCollection,
      site: r.site,
      languages: r.languages,
      ...(hosting?.project ? { hostingProject: hosting.project } : {}),
    },
  };
}

/**
 * What intake recorded about a live project: the platform pack it targets, the source repository
 * (when the playbook takes one) and the target values the playbook's intake declares. Only the
 * platform pack interprets `target`.
 */
export const IntakeFacts = z.preprocess(
  normalizeIntake,
  z.object({
    platform: z.string(),
    repo: z.string().nullable(),
    branch: z.string().nullable(),
    target: z.record(z.string(), IntakeValue),
    /** The saved connection whose tenant facts and secrets the project uses, if any. */
    connectionId: z.string().nullable().default(null),
  }),
);
export type IntakeFacts = z.infer<typeof IntakeFacts>;

export const StatCard = z.object({
  metric: MetricKey,
  label: z.string(),
  /** Carbon icon name. */
  icon: z.string(),
  note: z.string(),
});
export type StatCard = z.infer<typeof StatCard>;

/** The task contract the inspector shows (from the playbook template, filled per item). */
export const TaskContract = z.object({
  inputs: z.string(),
  outputs: z.string(),
  acceptance: z.string(),
  rollback: z.string(),
  maxAttempts: z.number().int().positive().default(3),
});
export type TaskContract = z.infer<typeof TaskContract>;

export const SettingKey = z.enum([
  'gates.pilotReview',
  'gates.publishReview',
  'escalationPolicy',
  'notifications',
  'autonomy',
]);
export type SettingKey = z.infer<typeof SettingKey>;

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
      /** Site definition from intake: where the source content lives. */
      site: z.object({ sourceUrl: z.string().url().nullable() }).default({ sourceUrl: null }),
      /** Two letters for the project switcher. */
      initials: z.string().max(3).nullable().default(null),
      /** One line under the name ("ansell-main to SitecoreAI"). */
      subtitle: z.string().nullable().default(null),
      /** IANA zone every time is shown in, and the working day is counted in. */
      timezone: z.string().default('America/New_York'),
      source: ProjectSource.default({ repo: null, url: null, framework: null, label: null }),
      target: ProjectTarget.nullable().default(null),
      /** Mission Control stat cards, in order. Empty: the playbook's defaults. */
      stats: z.array(StatCard).default([]),
      /** Display names for tool servers in Activity ("sitecore-authoring" → "Authoring API"). */
      toolLabels: z.record(z.string(), z.string()).default({}),
      /** live: a real engagement from the wizard. demo: a scripted project; nothing is built. */
      mode: z.enum(['live', 'demo']).default('live'),
      /** The brief: the client's answers, by question, with each question's label. */
      brief: z
        .array(z.object({ key: z.string(), label: z.string(), answer: z.string() }))
        .default([]),
      intake: IntakeFacts.nullable().default(null),
    }),
  ),
  /** Settings changed after intake: subtitle, target, stats, time zone. */
  ev(
    'project.updated',
    z.object({
      subtitle: z.string().nullable().optional(),
      target: ProjectTarget.nullable().optional(),
      stats: z.array(StatCard).optional(),
      timezone: z.string().optional(),
      /** The live site being migrated; the crawl and QA tools may only reach its host. */
      sourceUrl: z.string().url().nullable().optional(),
      buildRepo: BuildRepo.optional(),
      hosting: HostingState.optional(),
      /** Budgets the Director changed after start. */
      budgets: Budgets.optional(),
      /** Intake target values changed in Settings before Start, merged over intake's. */
      intakeTarget: z.record(z.string(), IntakeValue).optional(),
      /** The brief, answered or revised after intake. */
      brief: z
        .array(z.object({ key: z.string(), label: z.string(), answer: z.string() }))
        .optional(),
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
      /** `placeholder` stands for a forEach template until the Blueprint expands it. */
      kind: z.enum(['work', 'placeholder', 'checkpoint']).default('work'),
      /** Template the task came from; the Plan view groups many same-template bars into one. */
      group: z.string().nullable().default(null),
      /** Engagement-view row this task rolls up into ("Pilot slice and batch 1"). */
      groupTitle: z.string().nullable().default(null),
      /** Blueprint item keys this task works on (one for forEach tasks). */
      itemKeys: z.array(z.string()).default([]),
      /** Expected effort in working hours, for the forecast. */
      estimateHours: z.number().positive().nullable().default(null),
      /** The task's contract, as the inspector shows it. */
      contract: TaskContract.nullable().default(null),
    }),
  ),
  /** A planned window set by a Lead (or the simulator); the forecast keeps it when it can. */
  ev(
    'task.scheduled',
    z.object({ taskId: z.string(), start: z.iso.datetime(), end: z.iso.datetime() }),
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
      /** Progress through the task's own plan ("step 3 of 5"), when the agent reports it. */
      step: z.object({ n: z.number().int(), of: z.number().int() }).nullable().default(null),
    }),
  ),
  /** An agent's tools can't do a step its task needs: the task waits for engineering to add it. */
  ev(
    'capability.gap',
    z.object({
      taskId: z.string(),
      agentId: z.string(),
      /** The missing operation, in the agent's words ("create personalization variants"). */
      capability: z.string(),
      summary: z.string(),
    }),
  ),
  /** What a role does on this project specifically ("reads data/corpus.ts instead of crawling"). */
  ev('agent.noted', z.object({ agentId: z.string(), note: z.string() })),
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
      /** sha256 of the canonical request, for the audit trail; null for model-only steps. */
      requestHash: z.string().nullable().default(null),
      /** Result in the tool's own words when a code says too little ("green", "pass, 1 warning"). */
      outcome: z.string().nullable().default(null),
      /** Why a warning or failure matters, shown under the row. */
      note: z.string().nullable().default(null),
    }),
  ),
  /** A Lead accepting or rejecting a specialist's output. */
  ev(
    'review.recorded',
    z.object({
      reviewerId: z.string(),
      agentId: z.string(),
      taskId: z.string().nullable(),
      verdict: z.enum(['accept', 'reject']),
      subject: z.string(),
      note: z.string().nullable().default(null),
      /** Model tokens the review took. */
      tokens: z.number().int().nonnegative().default(0),
      /** The automated checks as they stood at this review. */
      checks: z
        .array(z.object({ id: z.string(), status: z.enum(['pass', 'fail', 'pending']) }))
        .default([]),
      /** What a rejection stood on (failed-check, missing-work, outside-task), when the Lead said. */
      grounds: z.string().nullable().default(null),
    }),
  ),
  /** The Chief of Staff changing the plan ("close pilot slice, open batch 2"). */
  ev(
    'plan.changed',
    z.object({
      summary: z.string(),
      taskIds: z.array(z.string()).default([]),
      tokens: z.number().int().nonnegative().default(0),
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
      /** Set while a reversible choice can still be undone; its effect applies at this time. */
      undoUntil: z.iso.datetime().nullable().default(null),
    }),
  ),
  ev(
    'decision.recorded',
    z.object({
      decisionId: z.string(),
      question: z.string(),
      answer: z.string(),
      rationale: z.string(),
      decidedBy: z.enum(['director', 'chief_of_staff', 'default', 'lead', 'rule']),
      scopeKey: z.string(),
      escalationId: z.string().nullable(),
      /** Display id, "D-07". Assigned in order when absent. */
      ref: z.string().nullable().default(null),
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
      /** Brief embeds: the label over the title ("Phase 4 brief"), labelled rows, bullets. */
      label: z.string().nullable().default(null),
      rows: z.array(z.object({ label: z.string(), value: z.string() })).default([]),
      bullets: z.array(z.string()).default([]),
      /** The highlighted line at the foot of a brief. */
      note: z.string().nullable().default(null),
      links: z.array(MessageLink).default([]),
      status: StatusCard.nullable().default(null),
      /** "What needs me?": the open items, as of the message. */
      needs: z
        .array(z.object({ escalationId: z.string(), type: EscalationType, title: z.string() }))
        .default([]),
      /** "What is next?": the next activities, as of the message. */
      upNext: z
        .array(
          z.object({
            taskId: z.string(),
            title: z.string(),
            agentId: z.string(),
            start: z.iso.datetime(),
            state: TaskState,
          }),
        )
        .default([]),
    }),
  ),
  /** A directive's stop window closed: applied, or stopped by the Director. */
  ev(
    'directive.settled',
    z.object({
      directiveId: z.string(),
      outcome: z.enum(['applied', 'stopped']),
      summary: z.string(),
    }),
  ),
  ev(
    'director.message',
    z.object({
      messageId: z.string(),
      body: z.string(),
      /** Set when asked from an escalation card ("Ask a question"). */
      about: z.string().nullable().default(null),
    }),
  ),
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
      /** Where this version's content lives (`blob://…`); null when only announced. */
      ref: z.string().nullable().default(null),
      /** Workbench tab label ("Components", "PR 12"); derived from the title when absent. */
      shortTitle: z.string().nullable().default(null),
      format: z.enum(['markdown', 'json', 'png', 'binary']).nullable().default(null),
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
  /** A pause placed or lifted on part of the project ("Paused: phase 6"). */
  ev(
    'control.hold',
    z.object({
      scope: z.object({ kind: ScopeKind, id: z.string() }),
      held: z.boolean(),
      label: z.string(),
    }),
  ),
  /** One page (or section) of the site in Site preview. Absent fields are unchanged. */
  ev(
    'page.updated',
    z.object({
      pageKey: z.string(),
      name: z.string().optional(),
      path: z.string().optional(),
      template: z.string().nullable().optional(),
      layout: z.string().nullable().optional(),
      pilot: z.boolean().optional(),
      migrated: z.boolean().optional(),
      /** 0–100. Content parity (text, links, media) and visual match. */
      parity: z.number().min(0).max(100).nullable().optional(),
      visual: z.number().min(0).max(100).nullable().optional(),
      shots: z
        .object({
          source: z.partialRecord(Breakpoint, z.string()).optional(),
          target: z.partialRecord(Breakpoint, z.string()).optional(),
        })
        .optional(),
      pageBuilderUrl: z.string().nullable().optional(),
      previewUrl: z.string().nullable().optional(),
    }),
  ),
  /** What each Site preview pane shows ("Vite build of ansell-main", "preview deploy 6"). */
  ev(
    'preview.deployed',
    z.object({
      side: z.enum(['source', 'target']),
      label: z.string(),
      url: z.string().nullable().default(null),
      deployment: z.string().nullable().default(null),
    }),
  ),
  /** A credential the project uses, by reference only. Secrets never enter the log. */
  ev(
    'credential.registered',
    z.object({
      credentialId: z.string(),
      system: z.string(),
      scope: z.string(),
      /** Vault path; null when the client has not provided it yet. */
      reference: z.string().nullable(),
      /** The value's last four characters, so people can tell which one is stored. */
      hint: z.string().nullable().default(null),
      expiresAt: z.iso.datetime().nullable().default(null),
    }),
  ),
  ev(
    'credential.verified',
    z.object({
      credentialId: z.string(),
      ok: z.boolean(),
      detail: z.string(),
      expiresAt: z.iso.datetime().nullable().default(null),
    }),
  ),
  /** A project setting changed (optional gates, escalation policy). */
  ev('settings.changed', z.object({ key: SettingKey, value: z.json() })),
  /** Project conventions (naming, grid, languages…), recorded with the Blueprint. */
  ev(
    'conventions.recorded',
    z.object({ entries: z.array(z.object({ key: z.string(), value: z.string() })) }),
  ),
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

/** An event before the store assigns id, seq and ts. Defaulted fields may be omitted. */
export type NewEvent = Omit<EventMeta, 'id' | 'seq' | 'ts' | 'projectId'> &
  z.input<typeof EventBody> & {
    /**
     * Backdated timestamp. Only for seeding or importing history (the simulator's demo
     * projects); everything live is stamped by the store.
     */
    at?: string;
  };

export type EventOf<T extends EventType> = EventMeta & Extract<EventBody, { type: T }>;
