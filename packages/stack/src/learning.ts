import type { RuleDraftInput } from '@lw/agent-runtime';
import type { DecisionCategory, EscalationView, RuleView } from '@lw/contracts';
import {
  cardCategory,
  chosenOptionId,
  LOCKED_CATEGORIES,
  problemOf,
  taskNames,
  type ProjectState,
} from '@lw/domain';
import type { RuleStore } from '@lw/events';
import { runRetrospective, type RetrospectiveDeps } from './retrospective';

export type RuleDrafter = (input: RuleDraftInput) => Promise<{ when: string; then: string }>;

/**
 * Harvest: a project's answered cards grouped by cause and answer, each group seen at least twice
 * drafted into a proposed rule with its cards as evidence. Nothing applies until the Director
 * approves it (Rules, in the menu). Cards already behind a rule are left out; running it again
 * adds only new groups.
 */
export async function harvestRules(
  deps: { rules: RuleStore; drafter?: RuleDrafter | null },
  s: ProjectState,
): Promise<{ proposed: RuleView[]; groups: number }> {
  const names = (y: EscalationView) =>
    taskNames(y.sourceTaskId ? s.tasks[y.sourceTaskId] : undefined);
  const groups = new Map<
    string,
    { cards: EscalationView[]; answer: string; category: DecisionCategory }
  >();
  for (const y of Object.values(s.escalations)) {
    if (y.gate) continue;
    const category = cardCategory(y);
    if (LOCKED_CATEGORIES.includes(category)) continue;
    const chosen = chosenOptionId(y);
    const answer = y.options.find((o) => o.id === chosen)?.label;
    if (!answer) continue;
    const key = [category, problemOf(y.title, names(y)), answer].join('\n');
    const g = groups.get(key) ?? { cards: [], answer, category };
    g.cards.push(y);
    groups.set(key, g);
  }
  const covered = new Set(
    (await deps.rules.list())
      .filter((r) => r.status !== 'retired')
      .flatMap((r) => r.sources.map((x) => x.escalationId)),
  );
  // A card already behind a rule is left out; the rest of its group still counts.
  const worth = [...groups.values()]
    .map((g) => ({ ...g, cards: g.cards.filter((c) => !covered.has(c.escalationId)) }))
    .filter((g) => g.cards.length >= 2)
    .sort((a, b) => b.cards.length - a.cards.length)
    .slice(0, 20);
  const proposed: RuleView[] = [];
  for (const g of worth) {
    const [first, ...rest] = g.cards;
    const t = first!.sourceTaskId ? s.tasks[first!.sourceTaskId] : undefined;
    let drafted = { when: first!.title.replace(/[?.]$/, '').toLowerCase(), then: g.answer };
    if (deps.drafter)
      drafted = await deps
        .drafter({
          card: {
            title: first!.title,
            context: first!.context,
            options: first!.options.map((o) => o.label),
          },
          answer: g.answer,
          notes: first!.resolution?.notes ?? null,
          role: t?.role ?? null,
          task: t?.title ?? null,
          similar: rest.slice(0, 8).map((y) => ({ title: y.title, answer: g.answer })),
        })
        .catch(() => drafted);
    proposed.push(
      await deps.rules.create({
        ...drafted,
        category: g.category,
        scope: s.playbook
          ? { kind: 'playbook', id: s.playbook.id }
          : { kind: 'project', id: s.projectId },
        sources: g.cards.slice(0, 20).map((y) => ({
          projectId: s.projectId,
          escalationId: y.escalationId,
          title: y.title,
          answer: g.answer,
        })),
        author: 'cypher',
        status: 'proposed',
      }),
    );
  }
  return { proposed, groups: groups.size };
}

/**
 * Learning during the run, not only at a phase's end: every few cards settled on a live project,
 * its answered cards are harvested into proposed rules and the current phase's retrospective
 * proposes lessons. Proposals wait for the Director's approval (Rules; Lessons learned), so a long
 * phase stops repeating the same card before it ends. Runs one project at a time. Returns the
 * unsubscribe.
 */
export function learnAsCardsSettle(
  deps: RetrospectiveDeps & { rules?: RuleStore; drafter?: RuleDrafter | null; every?: number },
  log: (message: string, err?: unknown) => void = console.log,
): () => void {
  const every = deps.every ?? 8;
  const settled = new Map<string, number>();
  const running = new Map<string, Promise<void>>();
  return deps.store.subscribe((e) => {
    if (e.type !== 'escalation.updated' || e.data.status !== 'resolved') return;
    const s = deps.projections.get(e.projectId);
    if (!s || s.mode !== 'live' || !s.intake) return;
    const n = (settled.get(e.projectId) ?? 0) + 1;
    settled.set(e.projectId, n % every);
    if (n < every) return;
    const prior = running.get(e.projectId) ?? Promise.resolve();
    const next = prior.then(async () => {
      await deps.projections.catchUp(e.projectId);
      const now = deps.projections.get(e.projectId);
      if (!now) return;
      const harvested = deps.rules
        ? await harvestRules({ rules: deps.rules, drafter: deps.drafter }, now)
        : { proposed: [] };
      const active = Object.entries(now.phases)
        .filter(([, p]) => p.status === 'current')
        .map(([k]) => Number(k));
      let lessons = 0;
      for (const phase of active)
        lessons += (await runRetrospective(deps, e.projectId, phase)).proposed.length;
      log(
        `Learning on ${e.projectId}: ${harvested.proposed.length} rule(s) and ${lessons} lesson(s) proposed after ${every} settled cards`,
      );
    });
    running.set(
      e.projectId,
      next.catch((err: unknown) => log(`Learning on ${e.projectId} failed`, err)),
    );
  });
}
