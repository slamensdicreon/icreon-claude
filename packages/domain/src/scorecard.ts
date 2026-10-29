import type {
  DecisionCategory,
  EscalationView,
  Scorecard,
  ScorecardCategory,
  ScorecardPhase,
  SettledBy,
} from '@lw/contracts';
import { DecisionCategory as Categories } from '@lw/contracts';
import { categoryOf } from './categories';
import { problemOf } from './clusters';
import type { ProjectState } from './projector';

const pct = (n: number, of: number) => (of ? Math.round((n / of) * 1000) / 10 : 0);
const NOBODY: Record<SettledBy, number> = {
  director: 0,
  chief_of_staff: 0,
  default: 0,
  lead: 0,
  rule: 0,
};

/** Who settled a card, or null while it waits (or was replaced by another card). */
function settledBy(x: EscalationView): SettledBy | null {
  if (x.status === 'expired') return 'default';
  if (x.status !== 'resolved' || !x.resolution) return null;
  return x.resolution.by;
}

/** A card's category: recorded on it once triage tags cards, else read from its words. */
export function cardCategory(x: EscalationView): DecisionCategory {
  return (x as EscalationView & { category?: DecisionCategory }).category ?? categoryOf(x);
}

/**
 * How a project's work went, from its events alone: cards by category and who settled them,
 * reviews and rejections, waits, re-runs, repeats of the same cause, and spend. Pure, so a
 * finished project's whole history gives its numbers at once.
 */
export function scorecard(s: ProjectState, now: number = Date.now()): Scorecard {
  const work = Object.values(s.tasks).filter((t) => t.kind === 'work');
  const cards = Object.values(s.escalations);
  const ledger = (id: string) => s.ledger[id];

  const byCategory = new Map<DecisionCategory, ScorecardCategory>(
    Categories.options.map((c) => [
      c,
      {
        category: c,
        raised: 0,
        open: 0,
        settled: { ...NOBODY },
        recommendedTaken: 0,
        withRecommendation: 0,
      },
    ]),
  );
  // Same cause: same type, same task group (or task), and the same problem in words.
  const causes = new Map<string, { category: DecisionCategory; title: string; count: number }>();
  for (const x of cards) {
    const category = cardCategory(x);
    const row = byCategory.get(category)!;
    row.raised++;
    if (x.status === 'open' || x.status === 'deferred') row.open++;
    const by = settledBy(x);
    if (by) {
      row.settled[by]++;
      const rec = x.options.find((o) => o.recommended);
      const chosen = x.status === 'expired' ? x.defaultOptionId : x.resolution?.optionId;
      if (rec && chosen) {
        row.withRecommendation++;
        if (chosen === rec.id) row.recommendedTaken++;
      }
    }
    if (x.gate) continue;
    const task = x.sourceTaskId ? s.tasks[x.sourceTaskId] : undefined;
    const names = task ? [task.title, task.taskId, ...task.itemKeys] : [];
    const key = [x.type, task?.group ?? task?.taskId ?? '', problemOf(x.title, names)].join('\n');
    const c = causes.get(key) ?? { category, title: x.title, count: 0 };
    c.count++;
    causes.set(key, c);
  }

  const phases: ScorecardPhase[] = Object.values(s.phases)
    .sort((a, b) => a.number - b.number)
    .map((p) => {
      const tasks = work.filter((t) => t.phase === p.number);
      const ids = new Set(tasks.map((t) => t.taskId));
      const sum = (k: 'reviews' | 'rejections' | 'waits' | 'reruns' | 'tokens') =>
        tasks.reduce((n, t) => n + (ledger(t.taskId)?.[k] ?? 0), 0);
      return {
        phase: p.number,
        name: p.name,
        tasks: tasks.length,
        done: tasks.filter((t) => t.state === 'done').length,
        cards: cards.filter((x) => x.sourceTaskId && ids.has(x.sourceTaskId)).length,
        reviews: sum('reviews'),
        rejections: sum('rejections'),
        waits: sum('waits'),
        reruns: sum('reruns'),
        tokens: sum('tokens'),
      };
    })
    .filter((p) => p.tasks > 0);

  const categories = [...byCategory.values()].filter((c) => c.raised > 0);
  const settledAll = categories.reduce(
    (n, c) => n + Object.values(c.settled).reduce((a, b) => a + b, 0),
    0,
  );
  const byDirector = categories.reduce((n, c) => n + c.settled.director, 0);
  const withRec = categories.reduce((n, c) => n + c.withRecommendation, 0);
  const recTaken = categories.reduce((n, c) => n + c.recommendedTaken, 0);
  const total = (k: 'reviews' | 'rejections' | 'waits' | 'reruns' | 'tokens') =>
    Object.values(s.ledger).reduce((n, l) => n + l[k], 0);
  const reviews = total('reviews');
  const rejections = total('rejections');
  const ends = work.map((t) => t.endedAt).filter((t): t is string => Boolean(t));
  const running = s.status === 'running' || s.status === 'paused';
  const end = running ? now : ends.length ? Math.max(...ends.map((t) => Date.parse(t))) : null;
  const started = s.startedAt ? Date.parse(s.startedAt) : null;
  const repeats = [...causes.values()].filter((c) => c.count > 1).sort((a, b) => b.count - a.count);

  return {
    projectId: s.projectId,
    name: s.name,
    status: s.status,
    playbook: s.playbook,
    totals: {
      tasks: work.length,
      done: work.filter((t) => t.state === 'done').length,
      cards: cards.length,
      cardsPerTask: work.length ? Math.round((cards.length / work.length) * 100) / 100 : 0,
      settledWithoutDirector: settledAll - byDirector,
      settledWithoutDirectorPct: pct(settledAll - byDirector, settledAll),
      recommendedTakenPct: withRec ? pct(recTaken, withRec) : null,
      reviews,
      rejections,
      rejectionRate: reviews ? pct(rejections, reviews) : null,
      repeats: repeats.reduce((n, c) => n + c.count - 1, 0),
      waits: total('waits'),
      reruns: total('reruns'),
      capabilityGaps: Object.keys(s.capabilityGaps).length,
      tokens: total('tokens'),
      usd: Math.round(s.spent.usd * 100) / 100,
      elapsedHours: started && end ? Math.round(((end - started) / 3_600_000) * 10) / 10 : null,
    },
    categories,
    phases,
    repeats: repeats.slice(0, 8),
  };
}
