import { z } from 'zod';
import {
  AgentState,
  AgentTier,
  Breakpoint,
  CosPresence,
  DecisionCategory,
  EscalationType,
  EscalationStatus,
  Health,
  PhaseStatus,
  ProjectStatus,
  ScopeKind,
  Severity,
  TaskState,
  Workstream,
} from './enums';
import {
  Budgets,
  CosMessageKind,
  EscalationCard,
  MessageLink,
  MessageSection,
  MetricKey,
  BuildRepo,
  HostingState,
  IntakeFacts,
  ProjectSource,
  ProjectTarget,
  Resolution,
  Spend,
  StatusCard,
  TaskContract,
} from './events';

/**
 * Every snapshot carries the `seq` it reflects. Fetch the snapshot, then open the SSE stream with
 * `?after=<seq>` and apply events on top. No gap, no duplicate.
 */
const Seq = z.number().int().nonnegative();

export const PhaseView = z.object({
  number: z.number().int(),
  name: z.string(),
  shortName: z.string(),
  status: PhaseStatus,
  gate: z.enum(['none', 'director']),
  gateLabel: z.string().nullable(),
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
  /** While set, the choice can be undone (POST …/undo) and has not taken effect yet. */
  undoUntil: z.iso.datetime().nullable(),
  /**
   * Open cards with the same cause on sibling tasks (same template, options and problem), shown
   * as this one card; answering it with `all` answers each of them.
   */
  group: z
    .object({
      escalationIds: z.array(z.string()),
      taskIds: z.array(z.string()),
      taskTitles: z.array(z.string()),
    })
    .optional(),
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
  /** What is paused below the project level, in words for the status strip. */
  holds: z.array(z.object({ kind: ScopeKind, id: z.string(), label: z.string() })),
  /** The live site being migrated, as given at intake. */
  sourceUrl: z.string().nullable(),
  initials: z.string(),
  subtitle: z.string().nullable(),
  timezone: z.string(),
  source: ProjectSource,
  target: ProjectTarget.nullable(),
  /** A scripted demo project: nothing it shows is real work. */
  demo: z.boolean(),
  /** What intake recorded (live projects only). */
  intake: IntakeFacts.nullable(),
  /** The client's brief, by question. */
  brief: z.array(z.object({ key: z.string(), label: z.string(), answer: z.string() })),
  /** The playbook the project runs. */
  playbook: z.object({ id: z.string(), version: z.string() }).nullable(),
  /** Where the new site is built, once created. */
  buildRepo: BuildRepo.nullable(),
  /** The head on our Vercel team, once created. */
  hosting: HostingState.nullable(),
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
  /** Carbon icon name, when the project's stat cards set one. */
  icon: z.string().nullable().default(null),
  /** The line under a stat card ("Registered in SitecoreAI"). */
  note: z.string().nullable().default(null),
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
  /** Who acted when not an agent step: "director", "chief-of-staff", "system". */
  actorId: z.string(),
  /** Tool column in words ("Authoring API", "Review", "Planner", "Control"). */
  toolLabel: z.string().nullable(),
  /** Result column in words ("200", "green", "pass, 1 warning", "reject"). */
  outcome: z.string().nullable(),
  /** Explanation under warnings and failures. */
  note: z.string().nullable(),
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
  /** The project's stat cards, in order (a subset of `metrics`, labelled for this project). */
  stats: z.array(MetricView),
  latest: z.array(ActivityItem).max(4),
  /** One line under the page title ("Phase 4, Components, runs with phase 5 in parallel."). */
  subtitle: z.string(),
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
  outcome: z.string().nullable().default(null),
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
  persona: z.string().nullable(),
  description: z.string(),
  /** What the role does on this project specifically, when it differs from the description. */
  projectNote: z.string().nullable(),
  step: z.object({ n: z.number().int(), of: z.number().int() }).nullable(),
  tokensProject: z.number().int(),
  /** "Opus-class", "Sonnet-class", "Haiku-class". */
  modelClass: z.string(),
  /** What it picks up next and when, from the forecast. */
  next: z.object({ title: z.string(), when: z.string(), taskId: z.string().nullable() }).nullable(),
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
  kind: z.enum(['work', 'placeholder', 'checkpoint']),
  group: z.string().nullable(),
  state: TaskState,
  attempt: z.number().int(),
  dependsOn: z.array(z.string()),
  startedAt: z.iso.datetime().nullable(),
  endedAt: z.iso.datetime().nullable(),
  /** Set when blocked: the escalation it waits on. */
  escalationId: z.string().nullable(),
  lastReason: z.string().nullable(),
  /** The roster agent that runs this task. */
  agentId: z.string(),
  groupTitle: z.string().nullable(),
  itemKeys: z.array(z.string()),
  estimateHours: z.number().nullable(),
  contract: TaskContract.nullable(),
  /** Window a Lead planned, if any. The schedule adds the forecast. */
  plannedStart: z.iso.datetime().nullable(),
  plannedEnd: z.iso.datetime().nullable(),
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
  label: z.string().nullable(),
  rows: z.array(z.object({ label: z.string(), value: z.string() })),
  bullets: z.array(z.string()),
  note: z.string().nullable(),
  links: z.array(MessageLink),
  status: StatusCard.nullable(),
  needs: z.array(z.object({ escalationId: z.string(), type: EscalationType, title: z.string() })),
  upNext: z.array(
    z.object({
      taskId: z.string(),
      title: z.string(),
      agentId: z.string(),
      start: z.iso.datetime(),
      state: TaskState,
    }),
  ),
  /** For a Director question asked from a card. */
  about: z.string().nullable(),
  /** For a directive ack, once its window closed. */
  settled: z.object({ outcome: z.enum(['applied', 'stopped']), summary: z.string() }).nullable(),
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
  /** "D-07". */
  ref: z.string(),
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
  initials: true,
  subtitle: true,
  demo: true,
});
export type ProjectListItem = z.infer<typeof ProjectListItem>;

/** One project on the Dashboard: where it stands, what it costs, and where it lives. */
export const PortfolioItem = ProjectListItem.extend({
  healthReason: z.string().nullable(),
  playbook: z.object({ id: z.string(), version: z.string() }).nullable(),
  /** Phases in the project's plan, and how many are done. */
  phases: z.object({ total: z.number().int(), done: z.number().int() }),
  budgets: Budgets,
  spent: Spend,
  createdAt: z.iso.datetime().nullable(),
  startedAt: z.iso.datetime().nullable(),
  /** The newest thing that happened on the project. */
  lastActivityAt: z.iso.datetime().nullable(),
  sourceUrl: z.string().nullable(),
  /** The new site, as deployed. */
  liveUrl: z.string().nullable(),
  /** Open capability gaps: tasks waiting on tools engineering hasn't built. */
  capabilityGaps: z.number().int(),
});
export type PortfolioItem = z.infer<typeof PortfolioItem>;

/** Who settled a card. `lead` and `rule` arrive with Lead triage. */
export const SettledBy = z.enum(['director', 'chief_of_staff', 'default', 'lead', 'rule']);
export type SettledBy = z.infer<typeof SettledBy>;

/** Cards of one category: how many, who settled them, and how often the recommendation held. */
export const ScorecardCategory = z.object({
  category: DecisionCategory,
  raised: z.number().int(),
  open: z.number().int(),
  settled: z.record(SettledBy, z.number().int()),
  /** Settled cards whose answer was the option the agent recommended. */
  recommendedTaken: z.number().int(),
  /** Settled cards that had a recommended option. */
  withRecommendation: z.number().int(),
});
export type ScorecardCategory = z.infer<typeof ScorecardCategory>;

/** One phase's work: tasks, cards, reviews, waits, re-runs and spend. */
export const ScorecardPhase = z.object({
  phase: z.number().int(),
  name: z.string(),
  tasks: z.number().int(),
  done: z.number().int(),
  cards: z.number().int(),
  reviews: z.number().int(),
  rejections: z.number().int(),
  waits: z.number().int(),
  reruns: z.number().int(),
  tokens: z.number().int(),
});
export type ScorecardPhase = z.infer<typeof ScorecardPhase>;

/** The headline numbers: what the scorecard compares across projects. */
export const ScorecardTotals = z.object({
  tasks: z.number().int(),
  done: z.number().int(),
  cards: z.number().int(),
  cardsPerTask: z.number(),
  /** Settled by anyone but the Director (default, Chief of Staff, Lead, rule). */
  settledWithoutDirector: z.number().int(),
  settledWithoutDirectorPct: z.number(),
  /** Of settled cards with a recommendation, the share where it was taken. */
  recommendedTakenPct: z.number().nullable(),
  reviews: z.number().int(),
  rejections: z.number().int(),
  rejectionRate: z.number().nullable(),
  /** Cards beyond the first in a group with the same cause. */
  repeats: z.number().int(),
  waits: z.number().int(),
  reruns: z.number().int(),
  capabilityGaps: z.number().int(),
  tokens: z.number().int(),
  usd: z.number(),
  /** From start to the last finished task, or now while running. */
  elapsedHours: z.number().nullable(),
});
export type ScorecardTotals = z.infer<typeof ScorecardTotals>;

/** GET /projects/:id/scorecard — how the project's work went, from its event log. */
export const Scorecard = z.object({
  projectId: z.string(),
  name: z.string(),
  status: ProjectStatus,
  playbook: z.object({ id: z.string(), version: z.string() }).nullable(),
  totals: ScorecardTotals,
  categories: z.array(ScorecardCategory),
  phases: z.array(ScorecardPhase),
  /** The causes that came back most: one row per group of same-cause cards. */
  repeats: z.array(
    z.object({
      category: DecisionCategory,
      title: z.string(),
      count: z.number().int(),
    }),
  ),
});
export type Scorecard = z.infer<typeof Scorecard>;

/** GET /playbooks/:id/scorecard — every project on a playbook, side by side. */
export const PlaybookScorecard = z.object({
  playbookId: z.string(),
  projects: z.array(
    z.object({
      projectId: z.string(),
      name: z.string(),
      status: ProjectStatus,
      version: z.string().nullable(),
      totals: ScorecardTotals,
    }),
  ),
});
export type PlaybookScorecard = z.infer<typeof PlaybookScorecard>;

/** A service the system runs on, as last seen. */
export const ServiceHealth = z.object({
  key: z.string(),
  label: z.string(),
  status: z.enum(['ok', 'degraded', 'down', 'unknown']),
  detail: z.string(),
  checkedAt: z.iso.datetime().nullable(),
});
export type ServiceHealth = z.infer<typeof ServiceHealth>;

/** Health across services and projects, for the Dashboard. */
export const PortfolioDiagnostics = z.object({
  services: z.array(ServiceHealth),
  projects: z.array(
    z.object({
      projectId: z.string(),
      name: z.string(),
      status: ProjectStatus,
      /** The orchestrator's state: running, stalled on a failed step, or ended. */
      orchestrator: z.object({
        status: z.enum(['ok', 'stalled', 'ended', 'unknown']),
        detail: z.string(),
      }),
      attention: z.array(z.string()),
    }),
  ),
});
export type PortfolioDiagnostics = z.infer<typeof PortfolioDiagnostics>;

export const ArtifactVersionView = z.object({
  version: z.number().int().positive(),
  ts: z.iso.datetime(),
  ref: z.string().nullable(),
  format: z.enum(['markdown', 'json', 'png', 'binary']).nullable(),
  producer: z.string(),
});
export type ArtifactVersionView = z.infer<typeof ArtifactVersionView>;

export const ArtifactView = z.object({
  artifactId: z.string(),
  kind: z.string(),
  title: z.string(),
  /** Tab label ("Blueprint", "PR 12"). */
  shortTitle: z.string(),
  /** Versions a Director gate approved, newest first. */
  approved: z.array(
    z.object({ version: z.number().int(), at: z.iso.datetime(), gate: z.string() }),
  ),
  latest: z.number().int().positive(),
  versions: z.array(ArtifactVersionView),
});
export type ArtifactView = z.infer<typeof ArtifactView>;

/** Workbench: every artifact by kind, newest version first within each. */
export const WorkbenchSnapshot = z.object({
  seq: z.number().int().nonnegative(),
  artifacts: z.array(ArtifactView),
});
export type WorkbenchSnapshot = z.infer<typeof WorkbenchSnapshot>;

// ---------------------------------------------------------------------------
// Schedule: the Plan surface's Today, Engagement and list views
// ---------------------------------------------------------------------------

export const ScheduledTask = z.object({
  taskId: z.string(),
  title: z.string(),
  agentId: z.string(),
  workstream: Workstream.nullable(),
  phase: z.number().int(),
  state: TaskState,
  dependsOn: z.array(z.string()),
  start: z.iso.datetime(),
  end: z.iso.datetime(),
  /** actual = from task events; planned = a Lead's window; forecast = the scheduler's estimate. */
  basis: z.enum(['actual', 'planned', 'forecast']),
});
export type ScheduledTask = z.infer<typeof ScheduledTask>;

export const ScheduleActivity = z.object({
  key: z.string(),
  title: z.string(),
  agentId: z.string(),
  start: z.iso.datetime(),
  end: z.iso.datetime(),
  state: TaskState,
  taskIds: z.array(z.string()),
});
export type ScheduleActivity = z.infer<typeof ScheduleActivity>;

export const ScheduleSnapshot = z.object({
  seq: Seq,
  timezone: z.string(),
  now: z.iso.datetime(),
  /** Local calendar day the Today view shows, and its 8 AM–8 PM span. */
  today: z.object({
    date: z.string(),
    label: z.string(),
    from: z.iso.datetime(),
    to: z.iso.datetime(),
  }),
  tasks: z.array(ScheduledTask),
  /** Working days the engagement spans. */
  days: z.array(
    z.object({ date: z.string(), label: z.string(), weekStart: z.boolean(), today: z.boolean() }),
  ),
  phases: z.array(
    z.object({
      phase: z.number().int(),
      name: z.string(),
      state: z.enum(['done', 'running', 'planned']),
      start: z.iso.datetime().nullable(),
      end: z.iso.datetime().nullable(),
      /** When the phase's Director gate is (or was) due. */
      gateAt: z.iso.datetime().nullable(),
      gateLabel: z.string().nullable(),
      activities: z.array(ScheduleActivity),
    }),
  ),
  /** Engagement end as forecast, and when Gate 2 lands. */
  finishAt: z.iso.datetime().nullable(),
});
export type ScheduleSnapshot = z.infer<typeof ScheduleSnapshot>;

// ---------------------------------------------------------------------------
// Site preview
// ---------------------------------------------------------------------------

export const PreviewPage = z.object({
  pageKey: z.string(),
  name: z.string(),
  path: z.string(),
  template: z.string().nullable(),
  layout: z.string().nullable(),
  pilot: z.boolean(),
  migrated: z.boolean(),
  parity: z.number().nullable(),
  visual: z.number().nullable(),
  shots: z.object({
    source: z.partialRecord(Breakpoint, z.string()),
    target: z.partialRecord(Breakpoint, z.string()),
  }),
  pageBuilderUrl: z.string().nullable(),
  previewUrl: z.string().nullable(),
});
export type PreviewPage = z.infer<typeof PreviewPage>;

export const PreviewPane = z.object({
  label: z.string(),
  url: z.string().nullable(),
  deployment: z.string().nullable(),
});

export const PreviewSnapshot = z.object({
  seq: Seq,
  source: PreviewPane.nullable(),
  target: PreviewPane.nullable(),
  pages: z.array(PreviewPage),
});
export type PreviewSnapshot = z.infer<typeof PreviewSnapshot>;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const CredentialView = z.object({
  credentialId: z.string(),
  system: z.string(),
  scope: z.string(),
  provided: z.boolean(),
  /** Last four characters of the stored value. */
  hint: z.string().nullable().default(null),
  verifiedAt: z.iso.datetime().nullable(),
  ok: z.boolean().nullable(),
  detail: z.string().nullable(),
  expiresAt: z.iso.datetime().nullable(),
});
export type CredentialView = z.infer<typeof CredentialView>;

export const PolicyRow = z.object({
  type: EscalationType,
  /** "20 min", or null when the type has no default and waits. */
  defaultAfterMinutes: z.number().int().nullable(),
  /** What happens without a default ("Pauses that path", "Pauses dispatch", "Proceeds; logged"). */
  behaviour: z.string(),
  notifies: z.string(),
});
export type PolicyRow = z.infer<typeof PolicyRow>;

export const SettingsSnapshot = z.object({
  seq: Seq,
  timezone: z.string(),
  credentials: z.array(CredentialView),
  budgets: Budgets,
  spent: Spend,
  gates: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      kind: z.enum(['director', 'optional']),
      /** Director gates: where they stand. */
      state: z.enum(['approved', 'waiting', 'future']).nullable(),
      phase: z.number().int().nullable(),
      at: z.iso.datetime().nullable(),
      /** Optional reviews: on or off. */
      enabled: z.boolean().nullable(),
    }),
  ),
  escalationPolicy: z.array(PolicyRow),
  conventions: z.object({
    entries: z.array(z.object({ key: z.string(), value: z.string() })),
    lockedAt: z.iso.datetime().nullable(),
  }),
  /** What rolling back the current phase would undo, in words; null when nothing would. */
  rollback: z.object({ phase: z.number().int(), name: z.string(), detail: z.string() }).nullable(),
  /** What agents' tools couldn't do: open gaps first (tasks waiting on them), then closed ones. */
  capabilityGaps: z
    .array(
      z.object({
        key: z.string(),
        capability: z.string(),
        firstAt: z.iso.datetime(),
        closedAt: z.iso.datetime().nullable(),
        tasks: z.array(
          z.object({
            taskId: z.string(),
            title: z.string(),
            agentId: z.string(),
            summary: z.string(),
          }),
        ),
      }),
    )
    .default([]),
});
export type SettingsSnapshot = z.infer<typeof SettingsSnapshot>;

// ---------------------------------------------------------------------------
// Blueprint, as the Workbench shows it
// ---------------------------------------------------------------------------

export const BlueprintRow = z.object({
  key: z.string(),
  name: z.string(),
  source: z.string(),
  fields: z.string(),
  params: z.string(),
  placeholders: z.string(),
  variants: z.string(),
  status: z.enum(['done', 'in_progress', 'planned', 'dropped', 'merged']),
  /** Changed since the approved version, and what it was. */
  changed: z.boolean(),
  was: z.string().nullable(),
});
export type BlueprintRow = z.infer<typeof BlueprintRow>;

export const BlueprintSnapshot = z.object({
  seq: Seq,
  version: z.number().int(),
  approvedVersion: z.number().int().nullable(),
  approvedAt: z.iso.datetime().nullable(),
  /** Decisions that changed it after approval ("D-07"). */
  updatedBy: z.array(z.string()),
  collections: z.array(
    z.object({
      name: z.string(),
      /** What "done" is called in this collection ("registered", "migrated"). */
      doneLabel: z.string(),
      rows: z.array(BlueprintRow),
    }),
  ),
});
export type BlueprintSnapshot = z.infer<typeof BlueprintSnapshot>;

// ---------------------------------------------------------------------------
// "Since you were away"
// ---------------------------------------------------------------------------

export const SinceSummary = z.object({
  fromSeq: z.number().int(),
  toSeq: z.number().int(),
  minutes: z.number().int(),
  raised: z.number().int(),
  resolved: z.number().int(),
  phase: z.object({ name: z.string(), percent: z.number() }).nullable(),
  usd: z.number(),
  events: z.number().int(),
});
export type SinceSummary = z.infer<typeof SinceSummary>;

/** A saved connection: one tenant's shared facts and credentials, reused by its projects. */
export const ConnectionView = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.string(),
  /** The shared target facts (CM host, site collection, languages). */
  target: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  credentials: z.array(
    z.object({
      credentialId: z.string(),
      system: z.string(),
      /** The last few characters, to recognize it; never the secret. */
      hint: z.string().nullable(),
      checkedAt: z.iso.datetime().nullable(),
      ok: z.boolean().nullable(),
      detail: z.string().nullable(),
    }),
  ),
  createdAt: z.iso.datetime(),
  createdFrom: z.object({ projectId: z.string(), name: z.string() }).nullable(),
  projects: z.array(z.object({ id: z.string(), name: z.string(), status: ProjectStatus })),
});
export type ConnectionView = z.infer<typeof ConnectionView>;

/**
 * GET /projects/:id/remix — a new project's intake, prefilled from an existing one: its playbook,
 * connection, brief, budgets and the target facts it shares; the per-site fields stay to fill.
 */
export const RemixDraft = z.object({
  playbookId: z.string(),
  from: z.object({ projectId: z.string(), name: z.string() }),
  connectionId: z.string().nullable(),
  client: z.string(),
  timezone: z.string(),
  budgets: z.object({ usd: z.number(), tokens: z.number(), hours: z.number() }),
  brief: z.record(z.string(), z.string()),
  target: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  /** Credentials the connection provides: the wizard doesn't ask for them. */
  providedCredentials: z.array(z.string()),
});
export type RemixDraft = z.infer<typeof RemixDraft>;

/**
 * A new project's intake for the wizard to open with, prefilled: a remix of an existing project,
 * or a project Cypher drafted from a brief. Nothing is created until the Director clicks Create.
 */
export const ProjectDraft = RemixDraft.extend({
  from: z.object({ projectId: z.string(), name: z.string() }).nullable(),
  name: z.string(),
  sourceUrl: z.string().nullable(),
  repo: z.string().nullable(),
  branch: z.string(),
});
export type ProjectDraft = z.infer<typeof ProjectDraft>;

/** Something Cypher proposes for the Director to confirm: a project to create, opened in the wizard. */
export const CypherProposal = z.object({
  kind: z.enum(['new', 'remix']),
  /** Why this playbook (or this project to remix), in a sentence or two. */
  reason: z.string(),
  /** What the brief asks for that the playbook won't do. */
  notCovered: z.array(z.string()),
  draft: ProjectDraft,
});
export type CypherProposal = z.infer<typeof CypherProposal>;

/** One turn of the portfolio conversation with Cypher. */
export const CypherMessage = z.object({
  id: z.string(),
  role: z.enum(['director', 'cypher']),
  body: z.string(),
  at: z.iso.datetime(),
  proposals: z.array(CypherProposal).default([]),
  /** Projects the answer is about, to open. */
  projects: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
});
export type CypherMessage = z.infer<typeof CypherMessage>;

/** GET /cypher — the portfolio conversation, oldest first. */
export const CypherConversation = z.object({
  /** False when no model is configured: Cypher can't answer. */
  available: z.boolean(),
  messages: z.array(CypherMessage),
});
export type CypherConversation = z.infer<typeof CypherConversation>;
