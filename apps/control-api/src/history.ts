import type { LwEvent } from '@lw/contracts';
import { isLogEvent, scorecard, toActivity, type ProjectState } from '@lw/domain';

const clip = (s: string, n = 240) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * One project's history as Cypher reads it on the Dashboard: what was decided (the Decision
 * Log), what happened (Activity rows, newest first, matching a search when one is given), how
 * the work went (the scorecard's totals and repeated causes) and what its retrospectives
 * proposed.
 */
export function projectHistory(
  s: ProjectState,
  log: LwEvent[],
  search: string | null,
  extra: { lessons: { ref: string; status: string; title: string }[]; now: number },
) {
  const words = (search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const match = (text: string) => {
    const t = text.toLowerCase();
    return words.every((w) => t.includes(w));
  };
  const title = (taskId: string | null) => (taskId ? (s.tasks[taskId]?.title ?? taskId) : null);
  const decisions = s.decisions
    .filter((d) => match(`${d.ref ?? ''} ${d.question} ${d.answer} ${d.rationale}`))
    .slice(-40)
    .map((d) => ({
      ref: d.ref,
      at: d.ts,
      question: clip(d.question),
      answer: clip(d.answer),
      decidedBy: d.decidedBy,
      why: clip(d.rationale, 200),
    }));
  const activity = log
    .filter(isLogEvent)
    .map((e) => toActivity(s, e))
    .filter((a) =>
      match(`${a.summary} ${a.toolServer ?? ''} ${a.operation ?? ''} ${title(a.taskId) ?? ''}`),
    )
    .slice(-40)
    .reverse()
    .map((a) => ({
      at: a.ts,
      who: a.agentId ?? a.actorId,
      task: title(a.taskId),
      what: clip(a.summary),
      outcome: a.outcome,
    }));
  const sc = scorecard(s, extra.now);
  return {
    name: s.name,
    status: s.status,
    playbook: s.playbook,
    phases: Object.values(s.phases)
      .sort((a, b) => a.number - b.number)
      .map((p) => `${p.number} ${p.name}: ${p.status}`),
    search: search ?? null,
    decisions,
    activity,
    scorecard: {
      totals: sc.totals,
      categories: sc.categories.filter((c) => c.raised > 0),
      repeats: sc.repeats.slice(0, 10),
    },
    lessons: extra.lessons,
  };
}
