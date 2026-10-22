import type {
  ActivityItem,
  AgentDetail,
  ArtifactView,
  AgentView,
  Budgets,
  ConversationItem,
  ConversationSnapshot,
  CosPresence,
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
  ProjectListItem,
  ProjectStatus,
  ProjectSummary,
  RosterEntry,
  ScopeKind,
  Spend,
  StepView,
  TaskView,
  TeamSnapshot,
  WorkbenchSnapshot,
} from '@lw/contracts';
import { toActivityItem } from './describe';
import { compareEscalations, UNRESOLVED } from './escalations';
import { computeHealth } from './health';
import { ACTIVE_TASK_STATES } from './task-fsm';

/**
 * Read model for one project, built by folding its events in `seq` order. Every snapshot the API
 * serves is a pure function of this state, so the simulator, the real orchestrator, and a replay
 * after a restart all produce identical views.
 */
export interface ProjectState {
  projectId: string;
  seq: number;
  name: string;
  client: string;
  status: ProjectStatus;
  budgets: Budgets;
  spent: Spend;
  startedAt: string | null;
  presence: CosPresence;
  phases: Record<number, PhaseDef & { status: PhaseStatus; enteredAt: string | null }>;
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
}

interface AgentRecord extends AgentView {
  lastSteps: StepView[];
}

const METRIC_LABELS: Record<MetricKey, { label: string; unit: 'count' | 'percent' }> = {
  components_registered: { label: 'Components registered', unit: 'count' },
  pages_migrated: { label: 'Pages migrated', unit: 'count' },
  media_uploaded: { label: 'Media uploaded', unit: 'count' },
  qa_pass: { label: 'QA pass', unit: 'percent' },
  parity: { label: 'Content parity', unit: 'percent' },
};

/** Types that never appear in "Latest from the team": they have their own surfaces. */
const NOT_LATEST = new Set<LwEvent['type']>([
  'cos.message',
  'director.message',
  'cos.presence',
  'escalation.raised',
  'escalation.updated',
  'decision.recorded',
  'metric.updated',
  'budget.updated',
  'agent.state',
  'task.planned',
  'control.hold',
]);

export function createProjectState(projectId: string): ProjectState {
  const metrics = {} as Record<MetricKey, MetricView>;
  for (const [key, { label, unit }] of Object.entries(METRIC_LABELS)) {
    metrics[key as MetricKey] = { key: key as MetricKey, label, unit, value: null, total: null };
  }
  return {
    projectId,
    seq: 0,
    name: '',
    client: '',
    status: 'intake',
    budgets: { tokens: 1, usd: 1, hours: 1 },
    spent: { tokens: 0, usd: 0, hours: 0 },
    startedAt: null,
    presence: 'listening',
    phases: {},
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
  };
}

export class SeqGapError extends Error {}

/** Applies one event in place. Events must arrive in order with no gaps. */
export function applyEvent(s: ProjectState, e: LwEvent): void {
  if (e.projectId !== s.projectId)
    throw new Error(`Event for ${e.projectId} applied to ${s.projectId}`);
  if (e.seq !== s.seq + 1) throw new SeqGapError(`Expected seq ${s.seq + 1}, got ${e.seq}`);
  s.seq = e.seq;

  switch (e.type) {
    case 'project.created': {
      s.name = e.data.name;
      s.client = e.data.client;
      s.budgets = e.data.budgets;
      s.sourceUrl = e.data.site.sourceUrl;
      for (const p of e.data.phases)
        s.phases[p.number] = { ...p, status: 'future', enteredAt: null };
      for (const r of e.data.roster) s.agents[r.agentId] = newAgent(r);
      break;
    }
    case 'project.status':
      s.status = e.data.status;
      if (e.data.status === 'running' && !s.startedAt) s.startedAt = e.ts;
      break;
    case 'phase.entered': {
      const p = s.phases[e.data.phase];
      if (p) Object.assign(p, { status: 'current', enteredAt: e.ts });
      break;
    }
    case 'phase.exited': {
      const p = s.phases[e.data.phase];
      if (p) p.status = 'done';
      break;
    }
    case 'task.planned':
      s.tasks[e.data.taskId] = {
        ...e.data,
        state: 'planned',
        attempt: 0,
        startedAt: null,
        endedAt: null,
        escalationId: null,
        lastReason: null,
      };
      break;
    case 'task.state': {
      const t = s.tasks[e.data.taskId];
      if (!t) break;
      t.state = e.data.to;
      t.attempt = e.data.attempt;
      t.lastReason = e.data.reason;
      if (e.data.to === 'running' && !t.startedAt) t.startedAt = e.ts;
      if (e.data.to === 'running') t.escalationId = null;
      if (['done', 'cancelled', 'rolled_back'].includes(e.data.to)) t.endedAt = e.ts;
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
      a.since = e.ts;
      break;
    }
    case 'step.recorded': {
      const a = s.agents[e.data.agentId];
      if (a) {
        a.tokensThisTask += e.data.tokens;
        a.lastSteps = [
          {
            stepId: e.data.stepId,
            ts: e.ts,
            toolServer: e.data.toolServer,
            operation: e.data.operation,
            resultCode: e.data.resultCode,
            durationMs: e.data.durationMs,
            summary: e.data.summary,
          },
          ...a.lastSteps,
        ].slice(0, 3);
      }
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
      break;
    }
    case 'decision.recorded':
      s.decisions.push({ ...e.data, ts: e.ts });
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
      });
      break;
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
        latest: e.data.version,
        versions: [],
      });
      a.title = e.data.title;
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
      ];
      break;
    }
    case 'tool.health':
      break;
  }

  if (e.severity !== 'routine' && !NOT_LATEST.has(e.type)) {
    s.latest = [toActivity(s, e), ...s.latest].slice(0, 3);
  }
}

function newAgent(r: RosterEntry): AgentRecord {
  return {
    ...r,
    state: r.tier === 'specialist' ? 'inactive' : 'idle',
    now: null,
    taskId: null,
    tokensThisTask: 0,
    since: null,
    lastSteps: [],
  };
}

export function toActivity(s: ProjectState, e: LwEvent): ActivityItem {
  return toActivityItem(e, (taskId) => s.tasks[taskId]?.phase ?? null, {
    agentName: (agentId) => s.agents[agentId]?.name ?? agentId,
    taskTitle: (taskId) => s.tasks[taskId]?.title ?? taskId,
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
        status: p.status,
        gate: p.gate,
        exitCriteria: p.exitCriteria,
        percent,
        tasksRunning: mine.filter((t) => ACTIVE_TASK_STATES.has(t.state)).length,
        tasksQueued: mine.filter((t) => t.state === 'planned' || t.state === 'ready').length,
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

export function projectSummary(s: ProjectState): ProjectSummary {
  const phases = phaseViews(s);
  const current = phases.find((p) => p.status === 'current') ?? null;
  const nextGate = phases.find((p) => p.gate === 'director' && p.status !== 'done') ?? null;
  const open = Object.values(s.escalations).filter((x) => x.status === 'open');
  const openBlockers = open.filter((x) => x.type === 'blocker');
  const { health, reason } =
    s.status === 'completed'
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
    currentPhase: current
      ? { number: current.number, name: current.name, percent: current.percent ?? 0 }
      : null,
    nextGate: nextGate ? { phase: nextGate.number, name: nextGate.name } : null,
    waitingCount: open.length,
    hasOpenBlocker: openBlockers.length > 0,
    startedAt: s.startedAt,
    budgets: s.budgets,
    spent: s.spent,
    presence: s.presence,
    holds: Object.values(s.holds),
    sourceUrl: s.sourceUrl,
  };
}

export function projectListItem(s: ProjectState): ProjectListItem {
  const { id, name, client, status, health, waitingCount, hasOpenBlocker, currentPhase } =
    projectSummary(s);
  return { id, name, client, status, health, waitingCount, hasOpenBlocker, currentPhase };
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

export function missionControl(s: ProjectState): MissionControlSnapshot {
  return {
    seq: s.seq,
    project: projectSummary(s),
    waitingOnYou: unresolvedEscalations(s),
    phases: phaseViews(s),
    teamNow: leadRows(s),
    metrics: Object.values(s.metrics),
    latest: s.latest,
  };
}

function agentView({ lastSteps: _steps, ...a }: AgentRecord): AgentView {
  return a;
}

export function team(s: ProjectState): TeamSnapshot {
  return { seq: s.seq, agents: Object.values(s.agents).map(agentView) };
}

export function agentDetail(s: ProjectState, agentId: string): AgentDetail | null {
  const a = s.agents[agentId];
  return a ? { ...agentView(a), lastSteps: a.lastSteps } : null;
}

export function plan(s: ProjectState): PlanSnapshot {
  return { seq: s.seq, phases: phaseViews(s), tasks: Object.values(s.tasks) };
}

export function conversation(s: ProjectState): ConversationSnapshot {
  return {
    seq: s.seq,
    presence: s.presence,
    items: s.conversation,
    queue: unresolvedEscalations(s),
  };
}

export function decisions(s: ProjectState): DecisionView[] {
  return s.decisions;
}

const KIND_ORDER = [
  'blueprint',
  'platform_notes',
  'inventory',
  'report',
  'handover_pack',
  'pull_request',
  'screenshot',
  'video',
];

export function workbench(s: ProjectState): WorkbenchSnapshot {
  const artifacts = Object.values(s.artifacts).sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.title.localeCompare(b.title),
  );
  return { seq: s.seq, artifacts };
}
