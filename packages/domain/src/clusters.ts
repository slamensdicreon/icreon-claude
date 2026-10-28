import type { EscalationView, TaskView } from '@lw/contracts';

/** Card types a batch of sibling tasks can raise for one cause. Gates, budget and risk stand alone. */
const GROUPABLE = new Set(['access', 'blocker', 'decision']);

/**
 * A card's text without its particulars: the task's and item's names, URLs and paths, IDs,
 * numbers and quoted text. Two cards with the same problem on different items read the same.
 */
export function problemOf(text: string, names: string[]): string {
  let t = text;
  for (const n of [...names].sort((a, b) => b.length - a.length))
    if (n.length > 2) t = t.split(n).join(' ');
  return t
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\S*[/\\]\S*/g, ' ')
    .replace(/["“”`][^"“”`]*["“”`]/g, ' ')
    .replace(/\{?\b[0-9a-f]{8}(-?[0-9a-f]{4}){3}-?[0-9a-f]{12}\b\}?/gi, ' ')
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/gi, ' ')
    .replace(/\d+/g, '#')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Same type, same task template, same options and the same problem: one cause. */
export function clusterKey(x: EscalationView, task: TaskView | undefined): string | null {
  if (x.status !== 'open' || x.gate || !GROUPABLE.has(x.type) || !task?.group) return null;
  const names = [task.title, task.taskId, ...task.itemKeys];
  return [
    x.type,
    task.group,
    x.options.map((o) => `${o.id}:${o.label}`).join('|'),
    problemOf(x.title, names),
    problemOf(x.context, names),
  ].join('\n');
}

export interface CardGroup {
  /** Every card in the group, oldest first; the first stands for the rest. */
  escalationIds: string[];
  taskIds: string[];
  /** The tasks' titles, for the card. */
  taskTitles: string[];
}

/** Open cards that share a cause, by escalation id (each member maps to its group). */
export function cardGroups(
  escalations: Iterable<EscalationView>,
  tasks: Record<string, TaskView>,
): Map<string, CardGroup> {
  const byKey = new Map<string, EscalationView[]>();
  for (const x of escalations) {
    const key = clusterKey(x, x.sourceTaskId ? tasks[x.sourceTaskId] : undefined);
    if (key) byKey.set(key, [...(byKey.get(key) ?? []), x]);
  }
  const out = new Map<string, CardGroup>();
  for (const members of byKey.values()) {
    if (members.length < 2) continue;
    members.sort((a, b) => a.raisedAt.localeCompare(b.raisedAt));
    const group: CardGroup = {
      escalationIds: members.map((m) => m.escalationId),
      taskIds: members.map((m) => m.sourceTaskId!),
      taskTitles: members.map((m) => tasks[m.sourceTaskId!]!.title),
    };
    for (const m of members) out.set(m.escalationId, group);
  }
  return out;
}

/**
 * A queue with each group shown once: its oldest card stands for the rest and carries the group.
 * Cards outside any group pass through unchanged.
 */
export function clusterQueue(
  queue: EscalationView[],
  tasks: Record<string, TaskView>,
): EscalationView[] {
  const groups = cardGroups(queue, tasks);
  return queue.flatMap((x) => {
    const g = groups.get(x.escalationId);
    if (!g) return [x];
    return g.escalationIds[0] === x.escalationId ? [{ ...x, group: g }] : [];
  });
}
