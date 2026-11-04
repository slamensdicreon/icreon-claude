import type { KnowledgeEntry } from '@lw/contracts';
import type { ProjectState } from '@lw/domain';
import type { KnowledgeContext, KnowledgeStore } from '@lw/events';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Decisions already taken on the project that bear on a card: those about its task, or about any
 * task the card names (a page waiting on "Port Form to Content SDK" gets the decisions on Form),
 * newest first. Deadline defaults are left out: nobody decided them. A Lead that sees these
 * doesn't answer "wait for the Form port" when the Director made the form theirs.
 */
export function relevantDecisions(
  state: Pick<ProjectState, 'tasks' | 'decisions'>,
  taskId: string,
  card: { title: string; context: string },
  limit = 12,
): string[] {
  const text = `${card.title}\n${card.context}`.toLowerCase();
  const named = Object.values(state.tasks).filter(
    (t) => t.taskId === taskId || (t.title.length > 6 && text.includes(t.title.toLowerCase())),
  );
  const titles = named.map((t) => t.title.toLowerCase());
  const keys = [...new Set(named.flatMap((t) => [t.taskId, ...t.itemKeys]))]
    .filter((k) => k.length > 2)
    .map((k) => new RegExp(`(^|[^a-z0-9-])${escape(k.toLowerCase())}([^a-z0-9-]|$)`));
  return state.decisions
    .filter((d) => d.decidedBy !== 'default')
    .filter((d) => {
      const hay = `${d.question}\n${d.answer}\n${d.rationale}\n${d.scopeKey}`.toLowerCase();
      return titles.some((t) => hay.includes(t)) || keys.some((k) => k.test(hay));
    })
    .slice(-limit)
    .reverse()
    .map(
      (d) =>
        `${d.ref} (${d.decidedBy}): ${clip(d.question, 160)} → ${clip(d.answer, 160)}${d.rationale ? `. ${clip(d.rationale, 400)}` : ''}`,
    );
}

/** The team's lessons that bear on a card's question, for the role that asked it. */
export async function relevantLessons(
  knowledge: KnowledgeStore,
  ctx: Omit<KnowledgeContext, 'text' | 'templateId' | 'docs'>,
  card: { title: string; context: string },
  limit = 6,
): Promise<string[]> {
  const found: KnowledgeEntry[] = await knowledge
    .retrieve(
      { ...ctx, templateId: null, docs: [], text: `${card.title} ${clip(card.context, 600)}` },
      limit,
    )
    .catch(() => []);
  return found.map((e) => `${e.ref}: ${e.title}. ${clip(e.text, 500)}`);
}
