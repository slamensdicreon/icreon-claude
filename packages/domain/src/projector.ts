import type {
  ActivityItem,
  AgentDetail,
  AgentView,
  ArtifactView,
  Budgets,
  ConversationItem,
  ConversationSnapshot,
  CosPresence,
  CredentialView,
  BuildRepo,
  IntakeFacts,
  DecisionView,
  EscalationView,
  LeadRow,
  LwEvent,
  MetricKey,
  MetricView,
  MissionControlSnapshot,
  PhaseDef,
  PhaseStatus,
  PhaseView,
  PlanSnapshot,
  PreviewPage,
  PreviewSnapshot,
  ProjectListItem,
  ProjectSource,
  ProjectStatus,
  ProjectSummary,
  ProjectTarget,
  RosterEntry,
  ScopeKind,
  SettingKey,
  Spend,
  StatCard,
  StepView,
  TaskView,
  TeamSnapshot,
  WorkbenchSnapshot,
} from '@lw/contracts';
import { isLogEvent, toActivityItem } from './describe';
import { compareEscalations, UNRESOLVED } from './escalations';
import { computeHealth } from './health';
import { nextForAgents } from './schedule';
import { ACTIVE_TASK_STATES } from './task-fsm';

/**
 * Read model for one project, built by folding its events in `seq` order. Every snapshot the API
 * serves is a pure function of this state (and, for forecasts, the current time), so the
 * simulator, the real orchestrator, and a replay after a restart all produce identical views.
 */
export interface ProjectState {
  projectId: string;
  seq: number;
  name: string;
  client: string;
  initials: string;
  subtitle: string | null;
  timezone: string;
  source: ProjectSource;
  target: ProjectTarget | null;
  statCards: StatCard[];
  toolLabels: Record<string, string>;
  status: ProjectStatus;
  budgets: Budgets;
  spent: Spend;
  createdAt: string | null;
  startedAt: string | null;
  presence: CosPresence;
  phases: Record<number, PhaseDef & { status: PhaseStatus; enteredAt: string | null }>;
  /** When each Director gate was approved, by phase. */
  gateApprovals: Record<number, string>;
  agents: Record<string, AgentRecord>;
  tasks: Record<string, TaskView>;
  escalations: Record<string, EscalationView>;
  decisions: DecisionView[];
  conversation: ConversationItem[];
  metrics: Record<MetricKey, MetricView>;
  latest: ActivityItem[];
  holds: Record<string, { kind: ScopeKind; id: string; label: string }>;
  artifacts: Record<string, ArtifactView>;
  sourceUrl: string | null;
  pages: Record<string, PreviewPage>;
  preview: Pick<PreviewSnapshot, 'source' | 'target'>;
  /** The vault reference stays in the read model for re-verification; views never show it. */
  credentials: Record<string, CredentialView & { reference: string | null }>;
  settings: Partial<Record<SettingKey, unknown>>;
  /** live: a real engagement from the wizard. demo: scripted. */
  mode: 'live' | 'demo';
  intake: IntakeFacts | null;
  buildRepo: BuildRepo | null;
  conventions: { key: string; value: string }[];
}

type AgentRecord = Omit<AgentView, 'modelClass' | 'next'> & { lastSteps: StepView[] };

const METRIC_LABELS: Record<MetricKey, { label: string; unit: 'count' | 'percent' }> = {
  components_registered: { label: 'Components registered', unit: 'count' },
  pages_migrated: { label: 'Pages migrated', unit: 'count' },
  media_uploaded: { label: 'Media uploaded', unit: 'count' },
  qa_pass: { label: 'QA pass', unit: 'percent' },
  parity: { label: 'Content parity', unit: 'percent' },
  source_mapped: { label: 'Source mapped', unit: 'count' },
};

/** Steps too low-level for "Latest from the team" (builds, model turns). */
const NOT_LATEST_SERVERS = new Set(['sandbox', 'model']);

export function createProjectState(projectId: string): ProjectState {
  const metrics = {} as Record<MetricKey, MetricView>;
  for (const [key, { label, unit }] of Object.entries(METRIC_LABELS)) {
    metrics[key as MetricKey] = {
      key: key as MetricKey,
      label,
      unit,
      value: null,
      total: null,
      icon: null,
      note: null,
    };
  }
  return {
    projectId,
    seq: 0,
    name: '',
    client: '',
    initials: '',
    subtitle: null,
    timezone: 'America/New_York',
    source: { repo: null, url: null, framework: null, label: null },
    target: null,
    statCards: [],
    toolLabels: {},
    status: 'intake',
    budgets: { tokens: 1, usd: 1, hours: 1 },
    spent: { tokens: 0, usd: 0, hours: 0 },
    createdAt: null,
    startedAt: null,
    presence: 'listening',
    phases: {},
    gateApprovals: {},
    agents: {},
    tasks: {},
    escalations: {},
    decisions: [],
    conversation: [],
    metrics,
    latest: [],
    holds: {},
    artifacts: {},
    sourceUrl: null,
    pages: {},
    preview: { source: null, target: null },
    credentials: {},
    mode: 'live',
    intake: null,
    buildRepo: null,
    settings: {},
    conventions: [],
  };
}

export class SeqGapError extends Error {}

const initialsOf = (name: string) =>
  name
    .split(/[\s&]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

const SHORT_TITLE: Record<string, string> = {
  blueprint: 'Blueprint',
  platform_notes: 'Platform Notes',
  handover_pack: 'Handover pack',
};

function shortTitle(kind: string, title: string, artifactId: string): string {
  if (SHORT_TITLE[kind]) return SHORT_TITLE[kind]!;
  if (kind === 'pull_request') {
    const n = /^(\d+)\b/.exec(title)?.[1] ?? /(\d+)$/.exec(artifactId)?.[1];
    return n ? `PR ${n}` : title;
  }
  return title.replace(/ (inventory|report)$/i, '').replace(/^(.)/, (c) => c.toUpperCase());
}

/** Applies one event in place. Events must arrive in order with no gaps. */
export function applyEvent(s: ProjectState, e: LwEvent): void {
  if (e.projectId !== s.projectId)
    throw new Error(`Event for ${e.projectId} applied to ${s.projectId}`);
  if (e.seq !== s.seq + 1) throw new SeqGapError(`Expected seq ${s.seq + 1}, got ${e.seq}`);
  s.seq = e.seq;

  switch (e.type) {
    case 'project.created': {
      const d = e.data;
      s.name = d.name;
      s.client = d.client;
      s.createdAt = e.ts;
      s.budgets = d.budgets;
      s.sourceUrl = d.site.sourceUrl ?? d.source.url;
      s.initials = d.initials ?? initialsOf(d.name);
      s.subtitle = d.subtitle;
      s.timezone = d.timezone;
      s.source = { ...d.source, url: d.source.url ?? d.site.sourceUrl };
      s.target = d.target;
      s.statCards = d.stats;
      s.toolLabels = d.toolLabels;
      s.mode = d.mode;
      s.intake = d.intake;
      for (const p of d.phases) s.phases[p.number] = { ...p, status: 'future', enteredAt: null };
      for (const r of d.roster) s.agents[r.agentId] = newAgent(r);
      if (s.source.label || s.source.url)
        s.preview.source = {
          label: s.source.label ?? s.source.url!,
          url: s.source.url,
          deployment: null,
        };
      break;
    }
    case 'project.updated': {
      const d = e.data;
      if (d.subtitle !== undefined) s.subtitle = d.subtitle;
      if (d.target !== undefined) s.target = d.target;
      if (d.stats !== undefined) s.statCards = d.stats;
      if (d.timezone !== undefined) s.timezone = d.timezone;
      if (d.buildRepo !== undefined) s.buildRepo = d.buildRepo;
      if (d.sourceUrl !== undefined) {
        s.sourceUrl = d.sourceUrl;
        s.source = { ...s.source, url: d.sourceUrl };
      }
      break;
    }
    case 'project.status':
      s.status = e.data.status;
      if (e.data.status === 'running' && !s.startedAt) s.startedAt = e.ts;
      break;
    case 'phase.entered': {
      const p = s.phases[e.data.phase];
      if (p) Object.assign(p, { status: 'current', enteredAt: p.enteredAt ?? e.ts });
      break;
    }
    case 'phase.exited': {
      const p = s.phases[e.data.phase];
      if (p) p.status = 'done';
      break;
    }
    case 'task.planned': {
      const prior = s.tasks[e.data.taskId];
      s.tasks[e.data.taskId] = {
        ...e.data,
        agentId: e.data.role,
        state: prior?.state ?? 'planned',
        attempt: prior?.attempt ?? 0,
        startedAt: prior?.startedAt ?? null,
        endedAt: prior?.endedAt ?? null,
        escalationId: prior?.escalationId ?? null,
        lastReason: prior?.lastReason ?? null,
        plannedStart: prior?.plannedStart ?? null,
        plannedEnd: prior?.plannedEnd ?? null,
      };
      break;
    }
    case 'task.scheduled': {
      const t = s.tasks[e.data.taskId];
      if (t) Object.assign(t, { plannedStart: e.data.start, plannedEnd: e.data.end });
      break;
    }
    case 'task.state': {
      const t = s.tasks[e.data.taskId];
      if (!t) break;
      t.state = e.data.to;
      t.attempt = e.data.attempt;
      t.lastReason = e.data.reason;
      if (e.data.to === 'running' && !t.startedAt) t.startedAt = e.ts;
      if (e.data.to === 'running') t.escalationId = null;
      if (['done', 'cancelled', 'rolled_back'].includes(e.data.to)) t.endedAt = e.ts;
      if (e.data.to === 'ready' && e.data.from === 'rolled_back') {
        t.startedAt = null;
        t.endedAt = null;
      }
      // A placeholder replaced by the Blueprint's real tasks leaves the plan entirely.
      if (t.kind === 'placeholder' && e.data.to === 'cancelled') delete s.tasks[e.data.taskId];
      break;
    }
    case 'agent.state': {
      const a = s.agents[e.data.agentId];
      if (!a) break;
      if (a.taskId !== e.data.taskId) a.tokensThisTask = 0;
      a.state = e.data.state;
      a.now = e.data.now;
      a.taskId = e.data.taskId;
      a.step = e.data.step;
      a.since = e.ts;
      break;
    }
    case 'agent.noted': {
      const a = s.agents[e.data.agentId];
      if (a) a.projectNote = e.data.note;
      break;
    }
    case 'step.recorded': {
      const a = s.agents[e.data.agentId];
      if (a) {
        a.tokensThisTask += e.data.tokens;
        a.tokensProject += e.data.tokens;
        a.lastSteps = [
          {
            stepId: e.data.stepId,
            ts: e.ts,
            toolServer: s.toolLabels[e.data.toolServer] ?? e.data.toolServer,
            operation: e.data.operation,
            resultCode: e.data.resultCode,
            durationMs: e.data.durationMs,
            summary: e.data.summary,
            outcome: e.data.outcome,
          },
          ...a.lastSteps,
        ].slice(0, 3);
      }
      break;
    }
    case 'review.recorded': {
      const a = s.agents[e.data.reviewerId];
      if (a) a.tokensProject += e.data.tokens;
      if (a)
        a.lastSteps = [
          {
            stepId: `review-${e.seq}`,
            ts: e.ts,
            toolServer: 'Review',
            operation: `${e.data.verdict} ${e.data.subject}`,
            resultCode: e.data.verdict === 'accept' ? 200 : 409,
            durationMs: 0,
            summary: e.data.note ?? '',
            outcome: e.data.verdict === 'accept' ? 'ok' : 'reject',
          },
          ...a.lastSteps,
        ].slice(0, 3);
      break;
    }
    case 'plan.changed': {
      const a = s.agents[e.actor.id];
      if (a) a.tokensProject += e.data.tokens;
      break;
    }
    case 'escalation.raised': {
      s.escalations[e.data.escalationId] = {
        ...e.data,
        status: 'open',
        raisedAt: e.ts,
        deferredUntil: null,
        resolution: null,
        resolvedAt: null,
        undoUntil: null,
      };
      const t = e.data.sourceTaskId ? s.tasks[e.data.sourceTaskId] : undefined;
      if (t) t.escalationId = e.data.escalationId;
      break;
    }
    case 'escalation.updated': {
      const x = s.escalations[e.data.escalationId];
      if (!x) break;
      x.status = e.data.status;
      x.deferredUntil = e.data.deferredUntil;
      x.undoUntil = e.data.undoUntil;
      // Re-opened by an Undo: the earlier choice no longer stands.
      x.resolution = e.data.status === 'open' ? null : (e.data.resolution ?? x.resolution);
      x.resolvedAt = UNRESOLVED.has(e.data.status) ? null : e.ts;
      if (x.type === 'gate' && x.gate && e.data.status === 'resolved') {
        if (x.resolution?.optionId === 'approve') {
          s.gateApprovals[x.gate.phase] = e.ts;
          const a = s.artifacts[x.gate.artifactId];
          if (a)
            a.approved = [
              { version: x.gate.artifactVersion, at: e.ts, gate: x.typeLabel ?? x.title },
              ...a.approved,
            ];
        }
      }
      break;
    }
    case 'decision.recorded':
      s.decisions.push({
        ...e.data,
        ts: e.ts,
        ref: e.data.ref ?? `D-${String(s.decisions.length + 1).padStart(2, '0')}`,
      });
      break;
    case 'cos.message':
      s.conversation.push({
        messageId: e.data.messageId,
        seq: e.seq,
        ts: e.ts,
        from: 'chief_of_staff',
        kind: e.data.kind,
        title: e.data.title,
        body: e.data.body,
        sections: e.data.sections,
        proceedsAt: e.data.proceedsAt,
        directiveId: e.data.directiveId,
        label: e.data.label,
        rows: e.data.rows,
        bullets: e.data.bullets,
        note: e.data.note,
        links: e.data.links,
        status: e.data.status,
        needs: e.data.needs,
        upNext: e.data.upNext,
        about: null,
        settled: null,
      });
      break;
    case 'directive.settled': {
      const m = s.conversation.find(
        (c) => c.kind === 'directive_ack' && c.directiveId === e.data.directiveId,
      );
      if (m) m.settled = { outcome: e.data.outcome, summary: e.data.summary };
      break;
    }
    case 'director.message':
      s.conversation.push({
        messageId: e.data.messageId,
        seq: e.seq,
        ts: e.ts,
        from: 'director',
        kind: 'director',
        title: null,
        body: e.data.body,
        sections: [],
        proceedsAt: null,
        directiveId: null,
        label: null,
        rows: [],
        bullets: [],
        note: null,
        links: [],
        status: null,
        needs: [],
        upNext: [],
        about: e.data.about,
        settled: null,
      });
      break;
    case 'cos.presence':
      s.presence = e.data.presence;
      break;
    case 'metric.updated':
      s.metrics[e.data.key] = { ...s.metrics[e.data.key], ...e.data };
      break;
    case 'budget.updated':
      s.spent = e.data.spent;
      break;
    case 'control.hold': {
      const key = `${e.data.scope.kind}:${e.data.scope.id}`;
      if (e.data.held && e.data.scope.kind !== 'project')
        s.holds[key] = { ...e.data.scope, label: e.data.label };
      else delete s.holds[key];
      break;
    }
    case 'artifact.versioned': {
      const a = (s.artifacts[e.data.artifactId] ??= {
        artifactId: e.data.artifactId,
        kind: e.data.kind,
        title: e.data.title,
        shortTitle: e.data.shortTitle ?? shortTitle(e.data.kind, e.data.title, e.data.artifactId),
        latest: e.data.version,
        versions: [],
        approved: [],
      });
      a.title = e.data.title;
      a.shortTitle = e.data.shortTitle ?? shortTitle(e.data.kind, e.data.title, e.data.artifactId);
      a.latest = Math.max(a.latest, e.data.version);
      a.versions = [
        {
          version: e.data.version,
          ts: e.ts,
          ref: e.data.ref,
          format: e.data.format,
          producer: e.actor.id,
        },
        ...a.versions.filter((v) => v.version !== e.data.version),
      ].sort((x, y) => y.version - x.version);
      break;
    }
    case 'page.updated': {
      const d = e.data;
      const prior = s.pages[d.pageKey];
      const p: PreviewPage = (s.pages[d.pageKey] = prior ?? {
        pageKey: d.pageKey,
        name: d.name ?? d.pageKey,
        path: d.path ?? `/${d.pageKey}`,
        template: null,
        layout: null,
        pilot: false,
        migrated: false,
        parity: null,
        visual: null,
        shots: { source: {}, target: {} },
        pageBuilderUrl: null,
        previewUrl: null,
      });
      if (d.name !== undefined) p.name = d.name;
      if (d.path !== undefined) p.path = d.path;
      if (d.template !== undefined) p.template = d.template;
      if (d.layout !== undefined) p.layout = d.layout;
      if (d.pilot !== undefined) p.pilot = d.pilot;
      if (d.migrated !== undefined) p.migrated = d.migrated;
      if (d.parity !== undefined) p.parity = d.parity;
      if (d.visual !== undefined) p.visual = d.visual;
      if (d.shots?.source) p.shots.source = { ...p.shots.source, ...d.shots.source };
      if (d.shots?.target) p.shots.target = { ...p.shots.target, ...d.shots.target };
      if (d.pageBuilderUrl !== undefined) p.pageBuilderUrl = d.pageBuilderUrl;
      if (d.previewUrl !== undefined) p.previewUrl = d.previewUrl;
      break;
    }
    case 'preview.deployed':
      s.preview[e.data.side] = {
        label: e.data.label,
        url: e.data.url,
        deployment: e.data.deployment,
      };
      break;
    case 'credential.registered':
      s.credentials[e.data.credentialId] = {
        credentialId: e.data.credentialId,
        system: e.data.system,
        scope: e.data.scope,
        provided: e.data.reference !== null,
        reference: e.data.reference,
        hint: e.data.hint,
        verifiedAt: null,
        ok: null,
        detail: e.data.reference === null ? 'Not provided' : null,
        expiresAt: e.data.expiresAt,
      };
      break;
    case 'credential.verified': {
      const c = s.credentials[e.data.credentialId];
      if (c)
        Object.assign(c, {
          verifiedAt: e.ts,
          ok: e.data.ok,
          detail: e.data.detail,
          expiresAt: e.data.expiresAt ?? c.expiresAt,
        });
      break;
    }
    case 'settings.changed':
      s.settings[e.data.key] = e.data.value;
      break;
    case 'conventions.recorded':
      s.conventions = e.data.entries;
      break;
    case 'tool.health':
      break;
  }

  if (isLogEvent(e)) {
    const item = toActivity(s, e);
    if (!(item.toolServer && NOT_LATEST_SERVERS.has(item.toolServer)))
      s.latest = [item, ...s.latest].slice(0, 4);
  }
}

function newAgent(r: RosterEntry): AgentRecord {
  return {
    ...r,
    persona: r.persona ?? null,
    description: r.description ?? '',
    state: r.tier === 'specialist' ? 'inactive' : 'idle',
    now: null,
    taskId: null,
    tokensThisTask: 0,
    tokensProject: 0,
    since: null,
    projectNote: null,
    step: null,
    lastSteps: [],
  };
}

export function toActivity(s: ProjectState, e: LwEvent): ActivityItem {
  return toActivityItem(e, (taskId) => s.tasks[taskId]?.phase ?? null, {
    agentName: (agentId) => s.agents[agentId]?.name ?? agentId,
    taskTitle: (taskId) => s.tasks[taskId]?.title ?? taskId,
    toolLabel: (server) => s.toolLabels[server] ?? server,
    escalation: (id) => s.escalations[id] ?? null,
    decisionRef: () => s.decisions.at(-1)?.ref ?? null,
  });
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export function phaseViews(s: ProjectState): PhaseView[] {
  const tasks = Object.values(s.tasks);
  return Object.values(s.phases)
    .sort((a, b) => a.number - b.number)
    .map((p) => {
      const mine = tasks.filter((t) => t.phase === p.number && t.state !== 'cancelled');
      const done = mine.filter((t) => t.state === 'done').length;
      const percent =
        p.status === 'future'
          ? null
          : p.status === 'done'
            ? 100
            : mine.length
              ? Math.round((done / mine.length) * 100)
              : 0;
      return {
        number: p.number,
        name: p.name,
        shortName: p.shortName ?? p.name,
        status: p.status,
        gate: p.gate,
        gateLabel: p.gateLabel,
        exitCriteria: p.exitCriteria,
        percent,
        tasksRunning: mine.filter((t) => ACTIVE_TASK_STATES.has(t.state)).length,
        tasksQueued: mine.filter(
          (t) => t.state === 'planned' || t.state === 'ready' || t.state === 'waiting',
        ).length,
        tasksDone: done,
        tasksTotal: mine.length,
      };
    });
}

function unresolvedEscalations(s: ProjectState): EscalationView[] {
  return Object.values(s.escalations)
    .filter((x) => UNRESOLVED.has(x.status))
    .sort(compareEscalations);
}

/** Escalations that stop work: Blockers, and Access problems (a tool the team can't reach). */
const STOPPING = new Set(['blocker', 'access']);

export function projectSummary(s: ProjectState): ProjectSummary {
  const phases = phaseViews(s);
  const current = phases.filter((p) => p.status === 'current');
  const lead = current[0] ?? null;
  const nextGate = phases.find((p) => p.gate === 'director' && p.status !== 'done') ?? null;
  const open = Object.values(s.escalations).filter((x) => x.status === 'open');
  const openBlockers = open.filter((x) => STOPPING.has(x.type));
  const { health, reason } =
    s.status === 'completed' || s.status === 'archived'
      ? { health: 'healthy' as const, reason: null }
      : computeHealth({
          openBlockers,
          tasks: Object.values(s.tasks),
          budgets: s.budgets,
          spent: s.spent,
        });
  return {
    id: s.projectId,
    name: s.name,
    client: s.client,
    status: s.status,
    health,
    healthReason: reason,
    currentPhase: lead
      ? { number: lead.number, name: lead.shortName, percent: lead.percent ?? 0 }
      : null,
    nextGate: nextGate ? { phase: nextGate.number, name: nextGate.shortName } : null,
    waitingCount: open.length,
    hasOpenBlocker: openBlockers.length > 0,
    startedAt: s.startedAt,
    budgets: s.budgets,
    spent: s.spent,
    presence: s.presence,
    holds: Object.values(s.holds),
    sourceUrl: s.sourceUrl,
    initials: s.initials,
    subtitle: s.subtitle,
    timezone: s.timezone,
    source: s.source,
    target: s.target,
    demo: s.mode === 'demo',
    intake: s.intake,
    buildRepo: s.buildRepo,
  };
}

export function projectListItem(s: ProjectState): ProjectListItem {
  const p = projectSummary(s);
  return {
    id: p.id,
    name: p.name,
    client: p.client,
    status: p.status,
    health: p.health,
    waitingCount: p.waitingCount,
    hasOpenBlocker: p.hasOpenBlocker,
    currentPhase: p.currentPhase,
    initials: p.initials,
    subtitle: p.subtitle,
    demo: p.demo,
  };
}

function leadRows(s: ProjectState): LeadRow[] {
  const agents = Object.values(s.agents);
  return agents
    .filter((a) => a.tier === 'lead' && a.workstream)
    .map((lead) => {
      const team = agents.filter((a) => a.reportsTo === lead.agentId);
      const count = (st: AgentView['state']) => team.filter((a) => a.state === st).length;
      return {
        agentId: lead.agentId,
        name: lead.name,
        workstream: lead.workstream!,
        active: count('active'),
        blocked: count('blocked'),
        waiting: count('waiting'),
        done: count('done'),
      };
    });
}

/** "Phase 4, Components, runs with phase 5 in parallel. Next gate: Acceptance." */
export function missionSubtitle(s: ProjectState): string {
  const phases = phaseViews(s);
  const current = phases.filter((p) => p.status === 'current');
  if (s.status === 'completed') return 'Engagement complete. Handover delivered.';
  if (s.status === 'archived') return 'Archived. Read-only.';
  if (!current.length) return 'Not started yet.';
  const [first, ...rest] = current;
  const head = `Phase ${first!.number}, ${first!.shortName}${
    rest.length ? `, runs with phase ${rest.map((p) => p.number).join(' and ')} in parallel` : ''
  }.`;
  const gateWaiting = Object.values(s.escalations).find(
    (x) => x.type === 'gate' && x.status === 'open' && x.gate,
  );
  if (gateWaiting) return `${head} ${gateWaiting.typeLabel ?? 'The gate'} waits on your approval.`;
  const gate = phases.find((p) => p.gate === 'director' && p.status !== 'done');
  return gate ? `${head} Next gate: ${gate.shortName}.` : head;
}

function stats(s: ProjectState): MetricView[] {
  if (!s.statCards.length) return Object.values(s.metrics);
  return s.statCards.map((c) => ({
    ...s.metrics[c.metric],
    label: c.label,
    icon: c.icon,
    note: c.note,
  }));
}

export function missionControl(s: ProjectState): MissionControlSnapshot {
  return {
    seq: s.seq,
    project: projectSummary(s),
    waitingOnYou: unresolvedEscalations(s),
    phases: phaseViews(s),
    teamNow: leadRows(s),
    metrics: Object.values(s.metrics),
    stats: stats(s),
    latest: s.latest,
    subtitle: missionSubtitle(s),
  };
}

/** "claude-opus-5-5" → "Opus-class". */
export function modelClass(model: string): string {
  const family = /(opus|sonnet|haiku|fable)/i.exec(model)?.[1];
  return family ? `${family[0]!.toUpperCase()}${family.slice(1).toLowerCase()}-class` : model;
}

function agentView(
  { lastSteps: _steps, ...a }: AgentRecord,
  next: AgentView['next'] | undefined,
): AgentView {
  return { ...a, modelClass: modelClass(a.model), next: next ?? null };
}

export function team(s: ProjectState, now = Date.now()): TeamSnapshot {
  const next = nextForAgents(s, now);
  return {
    seq: s.seq,
    agents: Object.values(s.agents).map((a) => agentView(a, next.get(a.agentId))),
  };
}

export function agentDetail(
  s: ProjectState,
  agentId: string,
  now = Date.now(),
): AgentDetail | null {
  const a = s.agents[agentId];
  return a ? { ...agentView(a, nextForAgents(s, now).get(agentId)), lastSteps: a.lastSteps } : null;
}

export function plan(s: ProjectState): PlanSnapshot {
  return { seq: s.seq, phases: phaseViews(s), tasks: Object.values(s.tasks) };
}

/** The dock: messages, and the queue (open, deferred, and choices still inside their undo window). */
export function conversation(s: ProjectState, now = Date.now()): ConversationSnapshot {
  const undoable = Object.values(s.escalations).filter(
    (x) => !UNRESOLVED.has(x.status) && x.undoUntil && Date.parse(x.undoUntil) > now,
  );
  return {
    seq: s.seq,
    presence: s.presence,
    items: s.conversation,
    queue: [...unresolvedEscalations(s), ...undoable],
  };
}

export function decisions(s: ProjectState): DecisionView[] {
  return s.decisions;
}

const KIND_ORDER = [
  'blueprint',
  'inventory',
  'platform_notes',
  'report',
  'handover_pack',
  'pull_request',
  'screenshot',
  'video',
];

export function workbench(s: ProjectState): WorkbenchSnapshot {
  const order = Object.keys(s.artifacts);
  const artifacts = Object.values(s.artifacts).sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      order.indexOf(a.artifactId) - order.indexOf(b.artifactId),
  );
  return { seq: s.seq, artifacts };
}

export function preview(s: ProjectState): PreviewSnapshot {
  return { seq: s.seq, ...s.preview, pages: Object.values(s.pages) };
}
