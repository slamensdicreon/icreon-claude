/**
 * Cypher's fields on a project's read model: faces, recommendations, reads and the voice line.
 * Pure functions of the read model and the clock; the sentences themselves come from ./voice.
 */
import type {
  EscalationView,
  Face,
  HandledItem,
  LeadRow,
  MissionControlSnapshot,
  ReadTone,
} from '@lw/contracts';
import {
  ACTIVE_TASK_STATES,
  BUDGET_SOFT,
  budgetUsage,
  chosenOptionId,
  isInSecondRetry,
  localParts,
  phaseViews,
  projectSummary,
  zonedTime,
  type ProjectState,
} from '@lw/domain';
import {
  cardSubject,
  choiceWords,
  firstNameOf,
  handledLine,
  handledSummary,
  initialsOf,
  leadRead,
  missionVoice,
  recommendationFor,
  upperFirst,
} from './voice';

type Agent = ProjectState['agents'][string];

/** The person an agent is shown as ("Emily Chen"), or its role's name when it has no persona. */
export const personOf = (a: Pick<Agent, 'persona' | 'name'>) => a.persona ?? a.name;

export function faceOf(a: Agent): Face {
  const name = personOf(a);
  return {
    agentId: a.agentId,
    name,
    firstName: firstNameOf(name),
    initials: initialsOf(name),
    workstream: a.workstream,
    working: a.state === 'active',
  };
}

/** The team without the Chief of Staff (Cypher itself). */
export const teamOf = (s: ProjectState) =>
  Object.values(s.agents).filter((a) => a.tier !== 'chief_of_staff');

export const workingAgents = (s: ProjectState) => teamOf(s).filter((a) => a.state === 'active');

const agentOfTask = (s: ProjectState, taskId: string | null | undefined): Agent | undefined => {
  const t = taskId ? s.tasks[taskId] : undefined;
  if (!t) return undefined;
  return s.agents[t.agentId] ?? Object.values(s.agents).find((a) => a.role === t.agentId);
};

/**
 * Rewrites role names and full persona names to first names: "Rendering Registrar is blocked"
 * → "Carlos is blocked", "the Solution Architect" → "Aisha".
 */
export function firstNames(s: ProjectState): (text: string) => string {
  const pairs: [RegExp, string][] = [];
  for (const a of Object.values(s.agents)) {
    if (!a.persona || a.tier === 'chief_of_staff') continue;
    const first = firstNameOf(a.persona);
    const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pairs.push([new RegExp(`\\b${esc(a.persona)}\\b`, 'g'), first]);
    // The role as the roster names it, and as its id reads ("rendering-registrar" →
    // "Rendering Registrar"): a card's text may use either.
    const roleNames = new Set(
      [a.name, a.role, a.agentId]
        .filter(Boolean)
        .map((n) => (n.includes('-') ? n.split('-').map(upperFirst).join(' ') : n))
        .filter((n) => n !== a.persona && /\s/.test(n)),
    );
    for (const n of roleNames)
      pairs.push([new RegExp(`(?:\\b[Tt]he\\s+)?\\b${esc(n)}\\b`, 'g'), first]);
  }
  // Longer names first, so "Content Lead" isn't eaten by a shorter overlap.
  pairs.sort((x, y) => y[0].source.length - x[0].source.length);
  return (text) => pairs.reduce((t, [re, first]) => t.replace(re, first), text);
}

/** Who raised a card: the agent on its source task, else the Lead whose triage forwarded it. */
export function raisedByOf(s: ProjectState, x: EscalationView): Face | null {
  const a = agentOfTask(s, x.sourceTaskId) ?? (x.triage ? s.agents[x.triage.leadId] : undefined);
  return a ? faceOf(a) : null;
}

/** Everyone a card names: its raiser, the agent on its task, its triage Lead, agents in its evidence. */
function peopleOf(s: ProjectState, x: EscalationView): Set<string> {
  const ids = new Set<string>();
  const t = agentOfTask(s, x.sourceTaskId);
  if (t) ids.add(t.agentId);
  if (x.triage) ids.add(x.triage.leadId);
  for (const e of x.evidence) if (e.kind === 'agent' && s.agents[e.ref]) ids.add(e.ref);
  for (const a of Object.values(s.agents))
    if (a.taskId && s.tasks[a.taskId]?.escalationId === x.escalationId) ids.add(a.agentId);
  return ids;
}

/** A card with Cypher's verdict and who raised it. */
export function enrichEscalation(s: ProjectState, x: EscalationView): EscalationView {
  const artifact = x.gate ? s.artifacts[x.gate.artifactId] : undefined;
  return {
    ...x,
    recommendation: recommendationFor({
      ...x,
      artifact: artifact ? `${artifact.shortTitle} v${x.gate!.artifactVersion}` : null,
      names: firstNames(s),
    }),
    raisedBy: raisedByOf(s, x),
  };
}

/** Why health is attention: a task on its second retry, or spend past the soft limit. */
export function attentionOf(s: ProjectState): 'retry' | 'budget' | null {
  if (Object.values(s.tasks).some((t) => isInSecondRetry(t.state, t.attempt))) return 'retry';
  return budgetUsage(s.budgets, s.spent).max > BUDGET_SOFT ? 'budget' : null;
}

/** Every phase is done: the engagement was accepted. */
export const acceptedOf = (s: ProjectState) => {
  const phases = Object.values(s.phases);
  return (
    s.status === 'completed' || (phases.length > 0 && phases.every((p) => p.status === 'done'))
  );
};

/** When it was accepted: its last gate's approval, else its last activity. */
export function acceptedAtOf(s: ProjectState): number | null {
  const approvals = Object.values(s.gateApprovals).map(Date.parse);
  if (approvals.length) return Math.max(...approvals);
  return s.latest[0] ? Date.parse(s.latest[0].ts) : null;
}

/** The phase in front: the lowest current one. */
export function currentPhaseOf(s: ProjectState) {
  return phaseViews(s).find((p) => p.status === 'current') ?? null;
}

/** Paused by the Director, or something in it is held. */
export const pausedOf = (s: ProjectState) =>
  s.status === 'paused' || Object.keys(s.holds).length > 0;

// ---------------------------------------------------------------------------
// Handled without the Director
// ---------------------------------------------------------------------------

const SETTLED_WITHOUT_YOU = new Set(['lead', 'rule', 'default', 'chief_of_staff']);

/** Cards settled without the Director (by a Lead, a rule, a default or Cypher), newest first. */
export function settledWithoutYou(s: ProjectState): EscalationView[] {
  return Object.values(s.escalations)
    .filter(
      (x) =>
        x.resolvedAt &&
        (x.status === 'expired' ||
          (x.status === 'resolved' &&
            x.resolution &&
            SETTLED_WITHOUT_YOU.has(x.resolution.by) &&
            !x.resolution.supersededBy)),
    )
    .sort((a, b) => b.resolvedAt!.localeCompare(a.resolvedAt!));
}

/** One settled card as a sentence. */
export function handledItem(
  s: ProjectState,
  x: EscalationView,
  opts: { project?: string } = {},
): HandledItem {
  const by = x.status === 'expired' ? 'default' : (x.resolution!.by as 'lead' | 'rule' | 'default');
  const leadId =
    x.triage?.leadId ??
    (by === 'lead' || by === 'rule' ? agentOfTask(s, x.sourceTaskId)?.reportsTo : null);
  const lead = leadId ? s.agents[leadId] : undefined;
  const optionId = chosenOptionId(x);
  const label = x.options.find((o) => o.id === optionId)?.label;
  return {
    text: firstNames(s)(
      handledLine({
        by,
        who: lead ? firstNameOf(personOf(lead)) : null,
        subject: cardSubject(x),
        choice: choiceWords(label),
        project: opts.project ?? null,
      }),
    ),
    at: x.resolvedAt,
    when: null,
  };
}

/**
 * The last few things settled without the Director, newest first, with a line that sums up the
 * Leads' day when they settled several.
 */
export function handledList(
  entries: { s: ProjectState; x: EscalationView; project?: string }[],
  now: number,
  tz: string,
  max: number,
): HandledItem[] {
  const midnight = startOfLocalDay(now, tz);
  const byLeads = entries.filter(
    (e) =>
      (e.x.resolution?.by === 'lead' || e.x.resolution?.by === 'rule') &&
      e.x.status === 'resolved' &&
      Date.parse(e.x.resolvedAt!) >= midnight,
  );
  const summary =
    byLeads.length >= 3
      ? handledSummary(
          byLeads.length,
          Math.min(...byLeads.map((e) => Date.parse(e.x.resolvedAt!))),
          now,
          tz,
        )
      : null;
  const lines = entries
    .slice(0, summary ? max - 1 : max)
    .map((e) => handledItem(e.s, e.x, { project: e.project }));
  return summary ? [...lines, summary] : lines;
}

/** Local midnight of `t`'s day in `tz`. */
export function startOfLocalDay(t: number, tz: string): number {
  const p = localParts(t, tz);
  return zonedTime(p.year, p.month, p.day, 0, tz);
}

// ---------------------------------------------------------------------------
// Mission Control
// ---------------------------------------------------------------------------

/** A Lead's row with their face, their reports and Cypher's line on the team. */
function leadRowVoice(
  s: ProjectState,
  row: LeadRow,
  open: EscalationView[],
  people: Map<string, Set<string>>,
): LeadRow {
  const lead = s.agents[row.agentId];
  if (!lead) return row;
  const team = Object.values(s.agents).filter((a) => a.reportsTo === lead.agentId);
  const ids = new Set([lead.agentId, ...team.map((a) => a.agentId)]);
  const names = (a: Agent) => firstNameOf(personOf(a));
  const cardsNaming = (agentId: string) =>
    open.filter((x) => people.get(x.escalationId)?.has(agentId));
  const next = Math.min(
    ...team.flatMap((a) => a.activePhases.filter((n) => s.phases[n]?.status === 'future')),
    Number.POSITIVE_INFINITY,
  );
  const nextPhase = Number.isFinite(next) && s.phases[next] ? s.phases[next]! : null;
  const { read, tone } = leadRead({
    workstream: row.workstream,
    leadDone: lead.state === 'done' || acceptedOf(s),
    active: team.filter((a) => a.state === 'active').length,
    stuck: team
      .filter((a) => a.state === 'blocked')
      .map((a) => {
        const card = cardsNaming(a.agentId)[0];
        return { first: names(a), on: card ? cardSubject(card) : null };
      }),
    waiting: team
      .filter((a) => a.state === 'waiting')
      .map((a) => ({ first: names(a), onYou: cardsNaming(a.agentId).length > 0 })),
    cards: open.filter((x) => [...(people.get(x.escalationId) ?? [])].some((id) => ids.has(id))),
    nextPhase: nextPhase ? { name: nextPhase.shortName ?? nextPhase.name, number: next } : null,
  });
  return {
    ...row,
    face: faceOf(lead),
    read,
    readTone: tone as ReadTone,
    reports: team.map(faceOf),
  };
}

/** Who is waiting on the Director's answer: a waiting or blocked agent a card names. */
function waiterOf(s: ProjectState, open: EscalationView[], people: Map<string, Set<string>>) {
  for (const x of open) {
    const ids = people.get(x.escalationId) ?? new Set();
    const a = teamOf(s).find(
      (m) => ids.has(m.agentId) && (m.state === 'waiting' || m.state === 'blocked'),
    );
    if (a) return firstNameOf(personOf(a));
  }
  return null;
}

/**
 * Mission Control with Cypher's fields: the voice line, what was handled without the Director,
 * a verdict and a raiser on every card, and a face, a line and the reports on every Lead.
 */
export function withVoice(
  mc: MissionControlSnapshot,
  s: ProjectState,
  now: number,
): MissionControlSnapshot {
  const waitingOnYou = mc.waitingOnYou.map((x) => enrichEscalation(s, x));
  const open = waitingOnYou.filter((x) => x.status === 'open' || x.status === 'deferred');
  const people = new Map(open.map((x) => [x.escalationId, peopleOf(s, x)]));
  const phase = currentPhaseOf(s);
  const tz = s.timezone;
  const voice = missionVoice({
    now,
    tz,
    status: s.status,
    accepted: acceptedOf(s),
    acceptedAt: acceptedAtOf(s),
    phase: phase ? { name: phase.shortName, percent: phase.percent ?? 0 } : null,
    atGate: open.some((x) => x.status === 'open' && x.gate?.phase === phase?.number),
    yours: open.map((x) => ({
      type: x.type,
      deadline: x.status === 'open' && x.deadline ? Date.parse(x.deadline) : null,
    })),
    waiter: waiterOf(s, open, people),
    attention: projectSummary(s).health === 'attention' ? attentionOf(s) : null,
    paused: pausedOf(s),
  });
  const handled = handledList(
    settledWithoutYou(s).map((x) => ({ s, x })),
    now,
    tz,
    4,
  );
  return {
    ...mc,
    waitingOnYou,
    teamNow: mc.teamNow.map((row) => leadRowVoice(s, row, open, people)),
    voice,
    handled,
  };
}

/** Tasks running now (running or validating). */
export const runningTasks = (s: ProjectState) =>
  Object.values(s.tasks).filter((t) => ACTIVE_TASK_STATES.has(t.state));
