import type { FactChange, FactsSnapshot, FactView, KnowledgeEffect } from '@lw/contracts';
import type { ProjectState } from './projector';

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/**
 * Facts whose value changed after tasks finished using the old one. A task is counted when it
 * finished between the old value and the change, and builds on the task that recorded the old
 * value (directly or through a checkpoint) or covers the fact's item.
 */
export function factChanges(s: ProjectState): FactChange[] {
  const tasks = Object.values(s.tasks);
  const upstreamOf = (taskId: string) => {
    const seen = new Set<string>();
    const walk = (ids: string[], depth: number) => {
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const t = s.tasks[id];
        if (t && t.kind !== 'work' && depth < 3) walk(t.dependsOn, depth + 1);
      }
    };
    walk(s.tasks[taskId]?.dependsOn ?? [], 0);
    return seen;
  };
  const out: FactChange[] = [];
  for (const f of Object.values(s.facts)) {
    const was = f.previous;
    if (!was) continue;
    const key = slug(f.key);
    const affected = tasks.filter(
      (t) =>
        t.kind === 'work' &&
        t.state === 'done' &&
        t.taskId !== f.taskId &&
        t.taskId !== was.taskId &&
        !!t.endedAt &&
        t.endedAt > was.at &&
        t.endedAt <= f.at &&
        ((was.taskId !== null && upstreamOf(t.taskId).has(was.taskId)) ||
          t.itemKeys.some((k) => slug(k) === key)),
    );
    if (!affected.length) continue;
    out.push({
      kind: f.kind,
      key: f.key,
      from: was.value,
      to: f.value,
      at: f.at,
      by: f.by,
      tasks: affected.map((t) => ({ taskId: t.taskId, title: t.title })),
    });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** The facts page: every fact, newest first, and what changed under finished work. */
export function factsSnapshot(s: ProjectState): FactsSnapshot {
  const facts: FactView[] = Object.values(s.facts).sort((a, b) => b.at.localeCompare(a.at));
  return { seq: s.seq, facts, changed: factChanges(s) };
}

/**
 * How each knowledge entry has done across projects: the tasks whose brief carried it, and how
 * many of those a Lead still rejected or sent back afterwards. Flagged when it has been carried
 * by four or more tasks and half of them failed anyway: it isn't preventing what it's about.
 */
export function knowledgeEffects(states: ProjectState[]): KnowledgeEffect[] {
  const by = new Map<string, { tasks: number; failed: number }>();
  for (const s of states)
    for (const [id, tasks] of Object.entries(s.knowledgeUse ?? {})) {
      const e = by.get(id) ?? { tasks: 0, failed: 0 };
      for (const [taskId, at] of Object.entries(tasks)) {
        const now = s.ledger[taskId];
        e.tasks++;
        if (now && (now.rejections > at.rejections || now.reruns > at.reruns)) e.failed++;
      }
      by.set(id, e);
    }
  return [...by].map(([id, e]) => ({
    id,
    ...e,
    flagged: e.tasks >= 4 && e.failed / e.tasks >= 0.5,
  }));
}
