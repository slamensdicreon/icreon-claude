/**
 * GET /portfolio/overview: the Dashboard in both modes, from every project's read model and, for
 * what the read model doesn't keep (spend by day, today's events, deploys), a capped read of each
 * log's newest events.
 */
import type {
  EscalationType,
  EscalationView,
  LwEvent,
  PortfolioKpi,
  PortfolioOverview,
  PortfolioProject,
  PortfolioYours,
} from '@lw/contracts';
import {
  isLogEvent,
  localDate,
  localParts,
  missionControl,
  projectSummary,
  zonedTime,
  type ProjectState,
} from '@lw/domain';
import {
  acceptedAtOf,
  acceptedOf,
  attentionOf,
  currentPhaseOf,
  enrichEscalation,
  faceOf,
  firstNames,
  handledList,
  pausedOf,
  personOf,
  runningTasks,
  settledWithoutYou,
  startOfLocalDay,
  teamOf,
  workingAgents,
} from './enrich';
import {
  cardSubject,
  firstNameOf,
  lowerFirst,
  portfolioVoice,
  projectRead,
  usd,
  watchClause,
  workingWord,
  yoursNote,
} from './voice';

/** Reads a project's log newest first: a page of events before `before` (exclusive seq). */
export type ReadNewest = (
  projectId: string,
  before: number | undefined,
  limit: number,
) => Promise<LwEvent[]>;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Events read per page, and pages read per project at most: long logs stay cheap. */
const PAGE = 500;
const MAX_PAGES = 10;

const ARCHIVED = new Set(['completed', 'cancelled', 'archived']);
/** Portfolio queue order: Blocker, Access, Gate, Decision, then the rest. */
const TYPE_ORDER: Record<EscalationType, number> = {
  blocker: 0,
  access: 1,
  gate: 2,
  decision: 3,
  budget: 4,
  risk: 5,
};
const HEALTH_ORDER = { blocked: 0, attention: 1, healthy: 2 } as const;
/** The tool server deploys run on, and what it is called in a project's tool labels. */
const HOSTING = /^(hosting|vercel|netlify)$/i;

/** The open cards that are the Director's, clustered as Mission Control shows them. */
const yoursOf = (s: ProjectState) => missionControl(s).waitingOnYou;

const deadlineOf = (x: EscalationView) =>
  x.status === 'open' && x.deadline ? Date.parse(x.deadline) : null;

/** The zone most running projects keep (the Dashboard's date line), else the first project's. */
function dashboardZone(states: ProjectState[]): string {
  const pool = states.filter((s) => s.status === 'running');
  const count = new Map<string, number>();
  for (const s of pool.length ? pool : states)
    count.set(s.timezone, (count.get(s.timezone) ?? 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'America/New_York';
}

/** Local midnight on the Monday of `now`'s week. */
function weekStart(now: number, tz: string): number {
  const p = localParts(now, tz);
  const back = (p.weekday + 6) % 7;
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day - back));
  return zonedTime(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 0, tz);
}

/** The team owning the phase in front: most agents on its tasks, else the Leads active in it. */
function hueOf(s: ProjectState): PortfolioProject['hue'] {
  const phase = currentPhaseOf(s);
  const tally = new Map<string, number>();
  const add = (ws: string | null | undefined) => ws && tally.set(ws, (tally.get(ws) ?? 0) + 1);
  if (phase) {
    for (const t of Object.values(s.tasks))
      if (t.phase === phase.number && t.state !== 'cancelled') add(s.agents[t.agentId]?.workstream);
    if (!tally.size)
      for (const a of teamOf(s))
        if (a.tier === 'specialist' && a.activePhases.includes(phase.number)) add(a.workstream);
  }
  const top = [...tally].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (top === 'discovery' || top === 'engineering' || top === 'content' || top === 'quality')
    return top;
  return !phase || phase.number <= 2 ? 'discovery' : 'engineering';
}

type Activity = ProjectState['latest'][number];

/** A step's own words: the summary after the agent and the call ("Registered rendering Hero"). */
const stepWords = (item: Activity) => item.summary.split(' · ').at(-1) ?? item.summary;

/** Paths shortened to their last part: "createItem Renderings/Project/x/Hero" → "createItem Hero". */
const shortPaths = (text: string) => text.replace(/\S*\/(\S+)/g, '$1');

/**
 * What the team did, as a sentence with first names ("Emily registered rendering Hero",
 * "Kevin accepted SampleKitPromo"), or null when the row has no sentence in it (a bare call).
 */
function activitySentence(s: ProjectState, item: Activity): string | null {
  const names = firstNames(s);
  const agent = item.agentId ? s.agents[item.agentId] : undefined;
  const first = agent?.persona ? firstNameOf(agent.persona) : null;
  if (item.type === 'step.recorded') {
    const words = stepWords(item);
    if (first && /^[A-Z][a-z]+ed\b/.test(words)) return names(`${first} ${lowerFirst(words)}`);
    return null;
  }
  if (item.type === 'review.recorded') return names(item.summary);
  return null;
}

/** The newest row as the Everything table's "last" column: a sentence when there is one. */
function activityLine(s: ProjectState, item: Activity): string {
  const sentence = activitySentence(s, item);
  if (sentence) return sentence;
  if (item.type === 'step.recorded') {
    const agent = item.agentId ? s.agents[item.agentId] : undefined;
    const who = agent ? firstNameOf(personOf(agent)) : null;
    const words = shortPaths(stepWords(item));
    return who ? `${who}, ${item.toolLabel ?? 'tool'}: ${words}` : words;
  }
  return firstNames(s)(item.summary);
}

/** The newest progress the team made, as a sentence (never a failure or a bare call). */
function latestLine(s: ProjectState): string | null {
  for (const item of s.latest) {
    if (item.severity !== 'routine' && item.severity !== 'notable') continue;
    const line = activitySentence(s, item);
    if (line) return line;
  }
  return null;
}

function projectRow(s: ProjectState, yours: EscalationView[]): PortfolioProject {
  const summary = projectSummary(s);
  const accepted = acceptedOf(s);
  const archived = ARCHIVED.has(s.status);
  const phase = currentPhaseOf(s);
  const working = workingAgents(s);
  const open = yours.filter((x) => x.status === 'open');
  const gate = open.find((x) => x.type === 'gate' && x.gate);
  const stopping = open.find((x) => x.type === 'blocker' || x.type === 'access');
  const paused = pausedOf(s);
  const done = accepted && (archived || s.status === 'completed');
  const blocked = summary.health === 'blocked' || (paused && Boolean(stopping));
  const attention = summary.health === 'attention' ? attentionOf(s) : null;
  const phases = Object.values(s.phases).sort((a, b) => a.number - b.number);
  const lastPhase = phases.at(-1);

  const healthWord = done
    ? 'Accepted'
    : s.status === 'cancelled'
      ? 'Cancelled'
      : s.status === 'archived'
        ? 'Archived'
        : s.status === 'paused'
          ? 'Paused'
          : { healthy: 'Healthy', attention: 'Attention', blocked: 'Blocked' }[summary.health];
  const phaseLabel = done
    ? `Accepted at ${lastPhase?.shortName ?? lastPhase?.name ?? 'handover'}`
    : s.status === 'intake'
      ? 'Not started'
      : phase
        ? gate && gate.gate!.phase === phase.number
          ? `${phase.shortName}, at ${(gate.typeLabel ?? phase.gateLabel ?? gateName(s, phase.number)).split(':')[0]}`
          : `${phase.shortName}, phase ${phase.number}`
        : archived
          ? upperFirstWord(s.status)
          : 'Between phases';
  const latest = s.latest[0];
  const { read, tone } = projectRead({
    status: s.status,
    accepted,
    acceptedAt: acceptedAtOf(s),
    tz: s.timezone,
    health: summary.health,
    attention,
    yours,
    atGate: Boolean(gate),
    stoppedOn: stopping ? cardSubject(stopping) : null,
    working: working.length,
    paused,
    latest: latestLine(s),
  });
  const leads = teamOf(s).filter((a) => a.tier === 'lead');
  return {
    projectId: s.projectId,
    name: s.name,
    initials: s.initials,
    status: s.status,
    health: summary.health,
    healthWord,
    archived,
    demo: s.mode === 'demo',
    phaseLabel,
    phaseName: done ? (lastPhase?.shortName ?? null) : (phase?.shortName ?? null),
    percent: done ? 100 : Math.max(0, Math.min(100, phase?.percent ?? 0)),
    hue: done ? 'done' : blocked ? 'blocked' : hueOf(s),
    eye: yours.length
      ? 'needs-a-word'
      : runningTasks(s).some((t) => t.state === 'running')
        ? 'watching'
        : 'resting',
    yours: yours.length,
    spentUsd: s.spent.usd,
    budgetUsd: s.budgets.usd,
    lastEvent: latest ? { at: latest.ts, text: activityLine(s, latest) } : null,
    read,
    readTone: tone,
    faces: (working.length ? working : leads).slice(0, 5).map(faceOf),
    workingWord: archived ? 'resting' : workingWord(working.length, yours.length),
  };
}

/** "Gate 1": the Director's gates counted in phase order. */
function gateName(s: ProjectState, phase: number): string {
  const gates = Object.values(s.phases)
    .filter((p) => p.gate === 'director')
    .map((p) => p.number)
    .sort((a, b) => a - b);
  const i = gates.indexOf(phase);
  return i >= 0 ? `Gate ${i + 1}` : 'your gate';
}

const upperFirstWord = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** What a project's log says that its read model doesn't keep, from its newest events. */
interface LogFacts {
  /** Cumulative spend (USD) at each `budget.updated` this week, oldest first. */
  spend: { t: number; usd: number }[];
  /** Spend before the week began; null when the read stopped short of it. */
  baseline: number | null;
  /** Log events since local midnight, and how many were failures. */
  eventsToday: number;
  failuresToday: number;
  /** The read stopped (at its cap) before local midnight: today's count is a floor. */
  partialToday: boolean;
  deploys: PortfolioOverview['deploys'];
}

async function readLog(
  s: ProjectState,
  read: ReadNewest,
  bounds: { week: number; today: number; dayAgo: number },
): Promise<LogFacts> {
  const floor = Math.min(bounds.week, bounds.today, bounds.dayAgo);
  const facts: LogFacts = {
    spend: [],
    baseline: null,
    eventsToday: 0,
    failuresToday: 0,
    partialToday: true,
    deploys: [],
  };
  const hosting: Extract<LwEvent, { type: 'step.recorded' }>[] = [];
  let before: number | undefined;
  let exhausted = false;
  let pastFloor = false;
  for (
    let page = 0;
    page < MAX_PAGES && !exhausted && !(pastFloor && facts.baseline !== null);
    page++
  ) {
    const events = await read(s.projectId, before, PAGE);
    if (events.length < PAGE) exhausted = true;
    if (!events.length) break;
    for (const e of events) {
      const t = Date.parse(e.ts);
      if (t < floor) pastFloor = true;
      if (e.type === 'budget.updated') {
        if (t >= bounds.week) facts.spend.push({ t, usd: e.data.spent.usd });
        else if (facts.baseline === null) facts.baseline = e.data.spent.usd;
      }
      if (t >= bounds.today && isLogEvent(e)) {
        facts.eventsToday++;
        if (e.severity === 'failure') facts.failuresToday++;
      }
      if (
        t >= bounds.dayAgo &&
        e.type === 'step.recorded' &&
        (HOSTING.test(e.data.toolServer) || HOSTING.test(s.toolLabels[e.data.toolServer] ?? '')) &&
        /deploy|build|promote|release|preview|production/i.test(e.data.operation)
      )
        hosting.push(e);
    }
    before = events.at(-1)!.seq;
    if (before <= 1) exhausted = true;
  }
  if (pastFloor || exhausted) facts.partialToday = false;
  // A log read to its start has spent nothing before it.
  if (facts.baseline === null && exhausted) facts.baseline = 0;
  facts.spend.reverse();
  facts.deploys = deploysOf(s, hosting);
  return facts;
}

/** Hosting steps as deploys: one per numbered build or deploy (its newest step), newest first. */
function deploysOf(
  s: ProjectState,
  steps: Extract<LwEvent, { type: 'step.recorded' }>[],
): PortfolioOverview['deploys'] {
  const name = s.hosting?.project ?? s.target?.hosting?.split(/,\s*/).at(-1) ?? null;
  const seen = new Set<string>();
  const unnumbered = steps.filter((e) => !/\d+/.test(e.data.operation)).length;
  let ordinal = unnumbered;
  const out: PortfolioOverview['deploys'] = [];
  for (const e of steps) {
    const d = e.data;
    const n = /(\d+)(?!.*\d)/.exec(d.operation)?.[1] ?? String(ordinal--);
    if (seen.has(n)) continue;
    seen.add(n);
    const outcome = (d.outcome ?? '').toLowerCase();
    const state: 'ok' | 'waiting' | 'failed' =
      e.severity === 'failure' || d.resultCode >= 400 || /fail|error|refused|cancel/.test(outcome)
        ? 'failed'
        : /queue|wait|pending|building|running/.test(outcome) ||
            (d.resultCode === 0 && !/green|ready|ok|pass|live|success/.test(outcome))
          ? 'waiting'
          : 'ok';
    const kind = /prod/i.test(d.operation)
      ? 'production'
      : /preview/i.test(d.operation)
        ? 'preview'
        : /build/i.test(d.operation)
          ? 'build'
          : 'deploy';
    const why = d.note ? `, ${lowerFirst(d.note.split(/[.;]/)[0]!.trim())}` : '';
    out.push({
      projectId: s.projectId,
      id: `${s.initials || 'P'}-${n}`,
      what:
        state === 'ok'
          ? [name, kind].filter(Boolean).join(' ')
          : state === 'failed'
            ? `${kind} failed${why}`
            : `${kind} queued${why}`,
      at: e.ts,
      state,
    });
  }
  return out;
}

/** Cumulative spend at instant `t` (the last reading before it), from the baseline up. */
function spendAt(facts: LogFacts, t: number): number {
  let v = facts.baseline ?? facts.spend[0]?.usd ?? 0;
  for (const r of facts.spend) {
    if (r.t >= t) break;
    v = r.usd;
  }
  return v;
}

/**
 * Reading a project's log is the overview's one expensive step (up to MAX_PAGES pages), and the
 * Dashboard polls. A project whose log hasn't moved, read for the same day and week, gives the
 * same facts, so the API keeps them per project for a minute (the 24-hour deploy window drifts).
 */
export type LogCache = Map<
  string,
  { seq: number; week: number; today: number; at: number; facts: LogFacts }
>;
const CACHE_MS = 60_000;

async function cachedLog(
  s: ProjectState,
  read: ReadNewest,
  bounds: { week: number; today: number; dayAgo: number },
  now: number,
  cache: LogCache | undefined,
): Promise<LogFacts> {
  const hit = cache?.get(s.projectId);
  if (
    hit &&
    hit.seq === s.seq &&
    hit.week === bounds.week &&
    hit.today === bounds.today &&
    now - hit.at < CACHE_MS
  )
    return hit.facts;
  const facts = await readLog(s, read, bounds);
  cache?.set(s.projectId, { seq: s.seq, week: bounds.week, today: bounds.today, at: now, facts });
  return facts;
}

export async function portfolioOverview(
  states: ProjectState[],
  read: ReadNewest,
  now: number,
  cache?: LogCache,
): Promise<PortfolioOverview> {
  const tz = dashboardZone(states);
  const week = weekStart(now, tz);
  const today = startOfLocalDay(now, tz);
  const dayAgo = now - DAY;

  const rows = states.map((s) => {
    const yours = yoursOf(s).map((x) => enrichEscalation(s, x));
    return { s, yours, row: projectRow(s, yours) };
  });
  const running = rows.filter((r) => r.s.status === 'running');
  const logs = await Promise.all(
    states.map((s) => cachedLog(s, read, { week, today, dayAgo }, now, cache)),
  );

  // ---- Yours, in clock order, then type, then age.
  const yours: PortfolioYours[] = rows
    .flatMap(({ s, yours: ys }) =>
      ys.map((escalation) => ({
        projectId: s.projectId,
        project: s.name,
        projectInitials: s.initials,
        escalation,
      })),
    )
    .sort((a, b) => {
      const x = a.escalation;
      const y = b.escalation;
      const deferred = Number(x.status === 'deferred') - Number(y.status === 'deferred');
      if (deferred) return deferred;
      const dx = deadlineOf(x);
      const dy = deadlineOf(y);
      const cx = dx !== null && dx > now ? dx : Infinity;
      const cy = dy !== null && dy > now ? dy : Infinity;
      if (cx !== cy) return cx < cy ? -1 : 1;
      return TYPE_ORDER[x.type] - TYPE_ORDER[y.type] || x.raisedAt.localeCompare(y.raisedAt);
    });
  const deadlines = yours
    .map((y) => deadlineOf(y.escalation))
    .filter((d): d is number => d !== null);

  // ---- Projects: what needs the Director, then health, then name; archived last.
  const projects = rows
    .map((r) => r.row)
    .sort(
      (a, b) =>
        Number(a.archived) - Number(b.archived) ||
        b.yours - a.yours ||
        HEALTH_ORDER[a.health] - HEALTH_ORDER[b.health] ||
        a.name.localeCompare(b.name),
    );

  // ---- People.
  const team = running.flatMap((r) => teamOf(r.s).map((a) => ({ a, s: r.s })));
  const working = team.filter(({ a }) => a.state === 'active');
  const load = working
    .filter(({ a }) => a.tokensThisTask > 0)
    .sort((x, y) => y.a.tokensThisTask - x.a.tokensThisTask)
    .slice(0, 5)
    .map(({ a, s }) => ({
      agent: faceOf(a),
      projectId: s.projectId,
      project: s.name,
      tokens: a.tokensThisTask,
    }));

  // ---- Spend this week, by working day.
  const days: PortfolioOverview['spendByDay']['days'] = [];
  const todayDate = localDate(now, tz);
  const dayStart = (i: number) => {
    const p = localParts(week + 12 * HOUR, tz);
    const d = new Date(Date.UTC(p.year, p.month - 1, p.day + i));
    return zonedTime(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 0, tz);
  };
  for (let i = 0; i < 5; i++) {
    const from = dayStart(i);
    const to = dayStart(i + 1);
    const date = localDate(from + 12 * HOUR, tz);
    const usdSpent =
      date > todayDate
        ? null
        : round2(
            logs.reduce(
              (sum, f) => sum + Math.max(0, spendAt(f, Math.min(to, now + 1)) - spendAt(f, from)),
              0,
            ),
          );
    days.push({ label: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'][i]!, date, usd: usdSpent });
  }
  const weekUsd = round2(
    logs.reduce((sum, f) => sum + Math.max(0, spendAt(f, now + 1) - spendAt(f, week)), 0),
  );
  const runningBudget = running.reduce((sum, r) => sum + r.s.budgets.usd, 0);
  const runningSpent = running.reduce((sum, r) => sum + r.s.spent.usd, 0);

  // ---- Cards raised and settled by the Leads, hour by hour over the last day.
  const all = states.flatMap((s) => Object.values(s.escalations));
  const raisedTimes = all.map((x) => Date.parse(x.raisedAt)).filter((t) => t > dayAgo && t <= now);
  const settledTimes = all
    .filter((x) => x.resolvedAt && (x.resolution?.by === 'lead' || x.resolution?.by === 'rule'))
    .map((x) => Date.parse(x.resolvedAt!))
    .filter((t) => t > dayAgo && t <= now);
  const points = Array.from({ length: 25 }, (_, i) => {
    const at = dayAgo + i * HOUR;
    return {
      at: new Date(at).toISOString(),
      raised: raisedTimes.filter((t) => t <= at).length,
      settled: settledTimes.filter((t) => t <= at).length,
    };
  });

  // ---- Handled without the Director, the last day.
  const settled = rows
    .flatMap(({ s }) =>
      settledWithoutYou(s)
        .filter((x) => Date.parse(x.resolvedAt!) > dayAgo)
        .map((x) => ({ s, x, project: s.name })),
    )
    .sort((a, b) => b.x.resolvedAt!.localeCompare(a.x.resolvedAt!));
  const handled = handledList(settled, now, tz, 4);

  // ---- KPIs.
  const eventsToday = logs.reduce((n, f) => n + f.eventsToday, 0);
  const failures = logs.reduce((n, f) => n + f.failuresToday, 0);
  const partial = logs.some((f) => f.partialToday);
  const tasksRunning = running.reduce((n, r) => n + runningTasks(r.s).length, 0);
  const kpis: PortfolioKpi[] = [
    {
      key: 'yours',
      label: 'Yours',
      value: String(yours.length),
      note: yours.length ? yoursNote(deadlines, now, tz) : 'Nothing waits on you',
      tone: yours.length ? 'yours' : 'normal',
    },
    {
      key: 'running',
      label: 'Running',
      value: String(running.length),
      note: `${working.length} of ${team.length} agents working`,
      tone: 'normal',
    },
    {
      key: 'spend',
      label: 'Spend this week',
      value: usd(weekUsd),
      note: running.length
        ? `${usd(runningSpent)} of ${usd(runningBudget)} overall`
        : 'Nothing is running',
      tone: 'normal',
    },
    {
      key: 'events',
      label: 'Events today',
      value: `${eventsToday.toLocaleString('en-US')}${partial ? '+' : ''}`,
      note: `${tasksRunning} running · ${failures} ${failures === 1 ? 'failure' : 'failures'}`,
      tone: 'normal',
    },
  ];

  // ---- The voice line.
  const voice = portfolioVoice({
    now,
    tz,
    projects: states.length,
    running: running.length,
    yours: yours.map((y) => ({ deadline: deadlineOf(y.escalation) })),
    watching: running
      .filter((r) => !r.yours.length && r.row.health === 'attention')
      .map((r) => ({ name: r.s.name, why: watchClause(attentionOf(r.s) ?? 'retry') })),
  });

  return {
    at: new Date(now).toISOString(),
    timezone: tz,
    voice,
    counts: {
      projects: states.length,
      running: running.length,
      archived: projects.filter((p) => p.archived).length,
      agents: team.length,
      working: working.length,
    },
    kpis,
    yours,
    projects,
    handled,
    deploys: logs
      .flatMap((f) => f.deploys)
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 5),
    load,
    spendByDay: { weekUsd, budgetUsd: runningBudget, days },
    escalations: {
      raised: raisedTimes.length,
      settledByLeads: settledTimes.length,
      points,
    },
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
