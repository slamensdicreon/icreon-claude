/**
 * The portfolio's own sections (design system §8): Team, Workbench, Activity and Scorecard across
 * every project, each the project page's data merged, with Cypher's line on top. Everything but
 * Activity comes from the read models; Activity reads each log's newest page and merges by time.
 */
import type {
  ActivityItem,
  PortfolioActivity,
  PortfolioActivityItem,
  PortfolioDocument,
  PortfolioRef,
  PortfolioScorecard,
  PortfolioTeam,
  PortfolioWorkbench,
  ScorecardCategory,
  ScorecardTotals,
  Voice,
} from '@lw/contracts';
import {
  missionControl,
  scorecard,
  team,
  toActivity,
  workbench,
  type ProjectState,
} from '@lw/domain';
import { enrichEscalation, withVoice } from './enrich';
import { projectRow, yoursOf, type ReadNewest } from './overview';
import { CountWord, countWord } from './voice';

const HOUR = 3_600_000;
const iso = (t: number) => new Date(t).toISOString();

export function refOf(s: ProjectState): PortfolioRef {
  const r = projectRow(
    s,
    yoursOf(s).map((x) => enrichEscalation(s, x)),
  );
  return {
    projectId: r.projectId,
    name: r.name,
    initials: r.initials,
    hue: r.hue,
    archived: r.archived,
    demo: r.demo,
  };
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const projectsWord = (n: number) => `${countWord(n)} ${plural(n, 'project', 'projects')}`;

// ---------------------------------------------------------------------------------------- Team

export function portfolioTeam(states: ProjectState[], now: number): PortfolioTeam {
  const projects = states.map((s) => {
    const mc = withVoice(missionControl(s), s, now);
    return { ...refOf(s), leads: mc.teamNow, agents: team(s).agents };
  });
  const active = projects.filter((p) => !p.archived);
  const people = active.flatMap((p) => p.agents);
  const working = people.filter((a) => a.state === 'active').length;
  const stuck = people.filter((a) => a.state === 'blocked' || a.state === 'waiting').length;
  return {
    at: iso(now),
    voice: teamVoice(working, stuck, active.length),
    working,
    stuck,
    projects,
  };
}

function teamVoice(working: number, stuck: number, projects: number): Voice {
  if (!projects) return { text: 'No project is running.', emphasis: null, closing: null };
  const where = projects === 1 ? 'on the one project' : `across ${projectsWord(projects)}`;
  const head = working
    ? `${CountWord(working)} ${plural(working, 'person is', 'people are')} working ${where}.`
    : `Nobody is working ${where} right now.`;
  if (!stuck) return { text: head, emphasis: null, closing: 'Nobody is stuck.' };
  const emphasis = `${CountWord(stuck)} ${plural(stuck, 'is', 'are')} waiting or blocked.`;
  return { text: `${head} ${emphasis}`, emphasis, closing: null };
}

// ------------------------------------------------------------------------------------ Workbench

export function portfolioWorkbench(states: ProjectState[], now: number): PortfolioWorkbench {
  const documents: PortfolioDocument[] = states
    .flatMap((s) => {
      const ref = refOf(s);
      return workbench(s).artifacts.map((a) => {
        const latest = a.versions.find((v) => v.version === a.latest) ?? a.versions[0];
        return {
          projectId: ref.projectId,
          project: ref.name,
          initials: ref.initials,
          hue: ref.hue,
          artifactId: a.artifactId,
          kind: a.kind,
          title: a.title,
          latest: a.latest,
          updatedAt: latest?.ts ?? null,
          approved: a.approved[0] ?? null,
        };
      });
    })
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  const today = documents.filter(
    (d) => d.updatedAt && now - Date.parse(d.updatedAt) < 24 * HOUR,
  ).length;
  const unapproved = documents.filter((d) => d.approved && d.approved.version < d.latest).length;
  const head = documents.length
    ? `Across ${projectsWord(states.length)} there ${plural(documents.length, 'is one document', `are ${countWord(documents.length)} documents`)}; ${countWord(today)} changed today.`
    : 'No documents yet.';
  const emphasis = unapproved
    ? `${CountWord(unapproved)} ${plural(unapproved, 'has', 'have')} moved past the approved version.`
    : null;
  return {
    at: iso(now),
    voice: { text: emphasis ? `${head} ${emphasis}` : head, emphasis, closing: null },
    documents,
  };
}

// ------------------------------------------------------------------------------------- Activity

/** Who acted, in words, for a row that isn't one project's page. */
function whoOf(s: ProjectState, i: ActivityItem): string {
  const a = i.agentId ? s.agents[i.agentId] : undefined;
  if (a) return a.tier === 'chief_of_staff' ? 'Cypher' : (a.persona ?? a.name);
  if (i.actorId === 'director') return 'You';
  if (i.actorId === 'chief-of-staff') return 'Cypher';
  return 'Tool server';
}

export async function portfolioActivity(
  states: ProjectState[],
  read: ReadNewest,
  now: number,
  q: { limit: number; severity?: string; project?: string },
): Promise<PortfolioActivity> {
  const severities = q.severity?.split(',');
  const chosen = q.project ? states.filter((s) => s.projectId === q.project) : states;
  const hourAgo = now - HOUR;
  let steps = 0;
  let failures = 0;
  const pages = await Promise.all(
    chosen.map(async (s) => {
      const ref = refOf(s);
      const rows: PortfolioActivityItem[] = [];
      // One page of the newest events: plenty for the merged view, bounded for the database.
      const events = await read(s.projectId, undefined, 500);
      for (const e of events) {
        const i = toActivity(s, e);
        if (i.toolLabel === null) continue;
        const t = Date.parse(i.ts);
        if (t >= hourAgo) {
          steps++;
          if (i.severity === 'failure') failures++;
        }
        if (severities && !severities.includes(i.severity)) continue;
        if (rows.length < q.limit)
          rows.push({
            ...i,
            projectId: ref.projectId,
            project: ref.name,
            initials: ref.initials,
            who: whoOf(s, i),
          });
      }
      return rows;
    }),
  );
  const items = pages
    .flat()
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, q.limit);
  const head = steps
    ? `In the last hour, ${countWord(steps)} ${plural(steps, 'step', 'steps')} across ${projectsWord(chosen.length)}.`
    : 'Nothing has happened in the last hour.';
  const emphasis = failures ? `${CountWord(failures)} failed.` : null;
  return {
    at: iso(now),
    voice: {
      text: emphasis ? `${head} ${emphasis}` : head,
      emphasis,
      closing: failures ? null : steps ? 'Nothing failed.' : null,
    },
    lastHour: { steps, failures },
    items,
  };
}

// ------------------------------------------------------------------------------------ Scorecard

const pct = (n: number, of: number) => (of ? Math.round((n / of) * 1000) / 10 : 0);

/** Every project's totals as one: sums, and the rates recomputed from the sums. */
export function sumTotals(cards: { totals: ScorecardTotals; categories: ScorecardCategory[] }[]) {
  const t = cards.map((c) => c.totals);
  const sum = (k: keyof ScorecardTotals) => t.reduce((n, x) => n + ((x[k] as number) ?? 0), 0);
  const cats = cards.flatMap((c) => c.categories);
  const settled = cats.reduce((n, c) => n + Object.values(c.settled).reduce((m, v) => m + v, 0), 0);
  const withRec = cats.reduce((n, c) => n + c.withRecommendation, 0);
  const taken = cats.reduce((n, c) => n + c.recommendedTaken, 0);
  const tasks = sum('tasks');
  const reviews = sum('reviews');
  const hours = t.map((x) => x.elapsedHours).filter((h): h is number => h !== null);
  const totals: ScorecardTotals = {
    tasks,
    done: sum('done'),
    cards: sum('cards'),
    cardsPerTask: tasks ? Math.round((sum('cards') / tasks) * 100) / 100 : 0,
    settledWithoutDirector: sum('settledWithoutDirector'),
    settledWithoutDirectorPct: pct(sum('settledWithoutDirector'), settled),
    recommendedTakenPct: withRec ? pct(taken, withRec) : null,
    reviews,
    rejections: sum('rejections'),
    rejectionRate: reviews ? pct(sum('rejections'), reviews) : null,
    repeats: sum('repeats'),
    waits: sum('waits'),
    reruns: sum('reruns'),
    capabilityGaps: sum('capabilityGaps'),
    tokens: sum('tokens'),
    usd: Math.round(sum('usd') * 100) / 100,
    elapsedHours: hours.length ? Math.round(hours.reduce((n, h) => n + h, 0) * 10) / 10 : null,
  };
  return totals;
}

function mergeCategories(cats: ScorecardCategory[]): ScorecardCategory[] {
  const by = new Map<string, ScorecardCategory>();
  for (const c of cats) {
    const m = by.get(c.category);
    if (!m) {
      by.set(c.category, { ...c, settled: { ...c.settled } });
      continue;
    }
    m.raised += c.raised;
    m.open += c.open;
    m.recommendedTaken += c.recommendedTaken;
    m.withRecommendation += c.withRecommendation;
    m.shadowAnswered += c.shadowAnswered;
    m.shadowAgreed += c.shadowAgreed;
    for (const [k, v] of Object.entries(c.settled))
      m.settled[k as keyof typeof m.settled] = (m.settled[k as keyof typeof m.settled] ?? 0) + v;
  }
  return [...by.values()].sort((a, b) => b.raised - a.raised);
}

export function portfolioScorecard(states: ProjectState[], now: number): PortfolioScorecard {
  const cards = states.map((s) => ({ s, ref: refOf(s), card: scorecard(s, now) }));
  const totals = sumTotals(cards.map((c) => c.card));
  const repeats = cards
    .flatMap(({ ref, card }) =>
      card.repeats.map((r) => ({ projectId: ref.projectId, project: ref.name, ...r })),
    )
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  const head = !totals.cards
    ? 'No cards yet, across every project.'
    : totals.settledWithoutDirector
      ? `Of the cards settled across ${projectsWord(states.length)}, ${Math.round(totals.settledWithoutDirectorPct)} percent were settled without you.`
      : `Nothing has been settled without you yet, across ${projectsWord(states.length)}.`;
  const emphasis =
    totals.cards && repeats[0] && repeats[0].count > 1
      ? `${repeats[0].title} came back ${countWord(repeats[0].count)} times in ${repeats[0].project}.`
      : null;
  return {
    at: iso(now),
    voice: {
      text: emphasis ? `${head} ${emphasis}` : head,
      emphasis,
      closing: totals.cards
        ? `${CountWord(totals.cards)} ${plural(totals.cards, 'card', 'cards')} over ${countWord(totals.tasks)} tasks.`
        : null,
    },
    totals,
    projects: cards.map(({ s, ref, card }) => ({ ...ref, status: s.status, totals: card.totals })),
    categories: mergeCategories(cards.flatMap((c) => c.card.categories)),
    repeats,
  };
}
