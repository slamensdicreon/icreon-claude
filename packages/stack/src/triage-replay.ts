import type { Triage, TriageInput } from '@lw/agent-runtime';
import {
  DECISION_CATEGORY_LABEL,
  type AutonomyLevel,
  type DecisionCategory,
  type EscalationView,
} from '@lw/contracts';
import { cardCategory, LOCKED_CATEGORIES, type ProjectState } from '@lw/domain';
import type {
  EventStore,
  IntegrationStore,
  KnowledgeStore,
  Projections,
  RuleStore,
} from '@lw/events';
import type { Playbook } from '@lw/playbook-sdk';
import type { BlobStore } from '@lw/tool-gateway';
import { ArtifactLibrary } from '@lw/tool-workspace';
import { leadTriageInput, type LeadTriageDeps } from './lead-triage';

/** One card replayed: the answer taken then, and what today's Lead says with what was known. */
export interface ReplayCase {
  escalationId: string;
  title: string;
  category: DecisionCategory;
  raisedAt: string;
  taken: { optionId: string; label: string; notes: string | null };
  lead: {
    decision: 'answer' | 'forward';
    optionId: string | null;
    label: string | null;
    reasoning: string;
  };
  /** agree: the Lead chose the option taken; differ: another option; forwarded: it passed it up. */
  verdict: 'agree' | 'differ' | 'forwarded' | 'failed';
  /** The Lead's answer when it saw the card live, in shadow: for comparison with today's. */
  shadow: { optionId: string | null; agreed: boolean } | null;
  usd: number;
}

export interface ReplaySummary {
  cases: number;
  usd: number;
  byCategory: {
    category: DecisionCategory;
    label: string;
    /** The level the playbook gives the category now. */
    level: AutonomyLevel;
    replayed: number;
    agree: number;
    differ: number;
    forwarded: number;
    failed: number;
    /** Of the cards the Lead answered, how many it answered as the Director did. */
    accuracy: number | null;
  }[];
}

/**
 * The cards worth replaying: answered by the Director with one of the card's options (not left to
 * a deadline, not a gate), raised by a task, in a category a Lead may settle. Oldest first.
 */
export function replayableCards(s: ProjectState): EscalationView[] {
  return Object.values(s.escalations)
    .filter(
      (y) =>
        !y.gate &&
        y.status === 'resolved' &&
        y.resolution?.by === 'director' &&
        !!y.resolution.optionId &&
        y.options.some((o) => o.id === y.resolution!.optionId) &&
        !!y.sourceTaskId &&
        !!s.tasks[y.sourceTaskId] &&
        !LOCKED_CATEGORIES.includes(cardCategory(y)),
    )
    .sort((a, b) => a.raisedAt.localeCompare(b.raisedAt));
}

/**
 * Asks today's Lead a card the Director answered, showing it only what was known when the card was
 * raised (see `KnownAt`), and compares its answer with the one taken. Proof, before a project runs
 * unattended, that a category can be left to the Leads.
 */
export async function replayCard(
  deps: LeadTriageDeps & { triage: (input: TriageInput) => Promise<Triage> },
  s: ProjectState,
  y: EscalationView,
): Promise<ReplayCase> {
  const category = cardCategory(y);
  const taken = y.options.find((o) => o.id === y.resolution!.optionId)!;
  const base = {
    escalationId: y.escalationId,
    title: y.title,
    category,
    raisedAt: y.raisedAt,
    taken: { optionId: taken.id, label: taken.label, notes: y.resolution?.notes ?? null },
    shadow:
      y.triage?.mode === 'shadow'
        ? { optionId: y.triage.optionId, agreed: y.triage.optionId === taken.id }
        : null,
  };
  const t = s.tasks[y.sourceTaskId!]!;
  try {
    const built = await leadTriageInput(
      deps,
      s,
      {
        projectId: s.projectId,
        taskId: t.taskId,
        role: t.role,
        category,
        card: {
          title: y.title,
          context: y.context,
          impact: y.impact,
          options: y.options.map((o) => ({ id: o.id, label: o.label, recommended: o.recommended })),
        },
        previous: [],
      },
      { at: y.raisedAt },
    );
    if (!built) throw new Error('no Lead for the role');
    const r = await deps.triage(built.input);
    const chosen = r.decision === 'answer' ? y.options.find((o) => o.id === r.optionId) : undefined;
    return {
      ...base,
      lead: {
        decision: r.decision,
        optionId: chosen?.id ?? null,
        label: chosen?.label ?? null,
        reasoning: r.reasoning,
      },
      verdict:
        r.decision === 'forward' ? 'forwarded' : chosen?.id === taken.id ? 'agree' : 'differ',
      usd: r.usd,
    };
  } catch (err) {
    return {
      ...base,
      lead: { decision: 'forward', optionId: null, label: null, reasoning: (err as Error).message },
      verdict: 'failed',
      usd: 0,
    };
  }
}

/** Agreement by category, with the level the playbook gives each now. */
export function summarizeReplay(
  cases: ReplayCase[],
  levels: Partial<Record<DecisionCategory, AutonomyLevel>>,
): ReplaySummary {
  const by = new Map<DecisionCategory, ReplayCase[]>();
  for (const c of cases) by.set(c.category, [...(by.get(c.category) ?? []), c]);
  return {
    cases: cases.length,
    usd: Number(cases.reduce((n, c) => n + c.usd, 0).toFixed(4)),
    byCategory: [...by.entries()]
      .map(([category, list]) => {
        const n = (v: ReplayCase['verdict']) => list.filter((c) => c.verdict === v).length;
        const answered = n('agree') + n('differ');
        return {
          category,
          label: DECISION_CATEGORY_LABEL[category],
          level: LOCKED_CATEGORIES.includes(category) ? 'ask' : (levels[category] ?? 'ask'),
          replayed: list.length,
          agree: n('agree'),
          differ: n('differ'),
          forwarded: n('forwarded'),
          failed: n('failed'),
          accuracy: answered ? Number((n('agree') / answered).toFixed(2)) : null,
        };
      })
      .sort((a, b) => b.replayed - a.replayed),
  };
}

/** Runs `fn` over `items`, `limit` at a time, in order. */
export async function inBatches<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>) {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit)
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  return out;
}

/**
 * Replays a project's cards in batches (a request each, so no single one runs long) and keeps the
 * results, so a replay can be stopped, resumed and read back. Built on the event log's artifacts,
 * the rules and the lessons, with the playbook the project is pinned to.
 */
export function triageReplayer(deps: {
  projections: Projections;
  store: EventStore;
  blobs: BlobStore;
  playbookFor: (projectId: string) => Playbook;
  rules?: RuleStore | null;
  knowledge?: KnowledgeStore | null;
  triage: (input: TriageInput) => Promise<Triage>;
  results: IntegrationStore;
}) {
  const library = new ArtifactLibrary(deps.store, deps.blobs);
  const key = (projectId: string) => `triage-replay:${projectId}`;
  const stored = async (projectId: string) =>
    (await deps.results.get<{ cases: ReplayCase[] }>(key(projectId)))?.cases ?? [];
  const summary = async (projectId: string, cases: ReplayCase[]) =>
    summarizeReplay(cases, deps.playbookFor(projectId).manifest.defaults.autonomy);
  return {
    /** The next `limit` cards not replayed yet (or all again, with `fresh`). */
    async run(projectId: string, opts: { limit: number; fresh?: boolean; concurrency?: number }) {
      await deps.projections.catchUp(projectId);
      const s = deps.projections.get(projectId);
      if (!s) return null;
      const before = opts.fresh ? [] : await stored(projectId);
      const done = new Set(before.map((c) => c.escalationId));
      const todo = replayableCards(s).filter((y) => !done.has(y.escalationId));
      const batch = todo.slice(0, opts.limit);
      const playbook = deps.playbookFor(projectId);
      const ran = await inBatches(batch, opts.concurrency ?? 4, (y) =>
        replayCard({ ...deps, library, playbook }, s, y),
      );
      const cases = [...before, ...ran];
      await deps.results.put(key(projectId), { cases });
      return {
        replayed: ran,
        remaining: todo.length - batch.length,
        summary: await summary(projectId, cases),
      };
    },
    async results(projectId: string) {
      const cases = await stored(projectId);
      return { cases, summary: await summary(projectId, cases) };
    },
  };
}
