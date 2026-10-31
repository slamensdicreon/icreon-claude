import type { LwEvent } from '@lw/contracts';
import type { ProjectState } from './projector';

/** One thing that went wrong or cost time in a phase, as the retrospective sees it. */
export interface RetroItem {
  /** Stable reference the proposals cite: "card:<id>", "review:<seq>", "wait:<seq>", … */
  ref: string;
  kind: 'card' | 'rejection' | 'wait' | 'failed-check' | 'gap';
  taskId: string | null;
  role: string | null;
  title: string;
  detail: string;
}

/** A task that got there after more than one try: its last, working attempt. */
export interface RetroProcedure {
  ref: string;
  taskId: string;
  role: string;
  title: string;
  attempts: number;
  rejections: number;
  steps: string[];
}

export interface RetroEvidence {
  phase: number;
  name: string;
  tasks: number;
  items: RetroItem[];
  procedures: RetroProcedure[];
}

const clip = (s: string, n = 300) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * What a phase cost, for its retrospective: the cards it raised and how they were answered, the
 * Lead's rejections, the waits, the failed checks and the capability gaps, each with a reference;
 * and the tasks that got there after more than one try, with the steps that finally worked.
 */
export function retroEvidence(
  s: ProjectState,
  log: LwEvent[],
  phase: number,
  limit = 160,
): RetroEvidence {
  const tasks = Object.values(s.tasks).filter((t) => t.phase === phase && t.kind === 'work');
  const ids = new Set(tasks.map((t) => t.taskId));
  const roleOf = (taskId: string | null) => (taskId ? (s.tasks[taskId]?.role ?? null) : null);
  const titleOf = (taskId: string | null) =>
    taskId ? (s.tasks[taskId]?.title ?? taskId) : 'the project';
  const items: RetroItem[] = [];

  for (const x of Object.values(s.escalations)) {
    if (x.gate || !x.sourceTaskId || !ids.has(x.sourceTaskId)) continue;
    const chosen = x.status === 'expired' ? x.defaultOptionId : x.resolution?.optionId;
    const answer = x.options.find((o) => o.id === chosen)?.label;
    items.push({
      ref: `card:${x.escalationId}`,
      kind: 'card',
      taskId: x.sourceTaskId,
      role: roleOf(x.sourceTaskId),
      title: clip(x.title, 120),
      detail: clip(
        `${x.context} ${answer ? `Answered: ${answer}.` : `Not answered (${x.status}).`}${x.resolution?.notes ? ` Notes: ${x.resolution.notes}` : ''}`,
      ),
    });
  }

  const checks = new Set<string>();
  for (const e of log) {
    if (e.type === 'review.recorded' && e.data.verdict === 'reject' && e.data.taskId) {
      if (!ids.has(e.data.taskId)) continue;
      items.push({
        ref: `review:${e.seq}`,
        kind: 'rejection',
        taskId: e.data.taskId,
        role: roleOf(e.data.taskId),
        title: `Rejected: ${clip(titleOf(e.data.taskId), 100)}`,
        detail: clip(`${e.data.grounds ? `(${e.data.grounds}) ` : ''}${e.data.note ?? ''}`),
      });
    } else if (e.type === 'task.state' && e.data.to === 'waiting' && ids.has(e.data.taskId)) {
      items.push({
        ref: `wait:${e.seq}`,
        kind: 'wait',
        taskId: e.data.taskId,
        role: roleOf(e.data.taskId),
        title: `Waited: ${clip(titleOf(e.data.taskId), 100)}`,
        detail: clip(e.data.reason ?? 'no reason given'),
      });
    } else if (
      e.type === 'step.recorded' &&
      e.data.toolServer === 'validators' &&
      e.data.resultCode === 422 &&
      e.data.taskId &&
      ids.has(e.data.taskId)
    ) {
      // The same check failing the same way on a re-run is one item.
      const key = `${e.data.taskId}:${e.data.operation}:${e.data.summary}`;
      if (checks.has(key)) continue;
      checks.add(key);
      items.push({
        ref: `check:${e.seq}`,
        kind: 'failed-check',
        taskId: e.data.taskId,
        role: roleOf(e.data.taskId),
        title: `${e.data.operation} failed on ${clip(titleOf(e.data.taskId), 80)}`,
        detail: clip(e.data.summary),
      });
    }
  }

  for (const g of Object.values(s.capabilityGaps)) {
    const own = Object.entries(g.tasks).filter(([t]) => ids.has(t));
    if (!own.length) continue;
    items.push({
      ref: `gap:${g.capability}`,
      kind: 'gap',
      taskId: own[0]![0],
      role: roleOf(own[0]![0]),
      title: `Missing capability: ${g.capability}`,
      detail: clip(`${own.length} task(s) waited on it. ${own[0]![1].summary}`),
    });
  }

  // Tasks that finished after a rejection or a second run, with their last attempt's steps.
  const procedures: RetroProcedure[] = [];
  for (const t of tasks) {
    const l = s.ledger[t.taskId];
    if (t.state !== 'done' || !l || (l.rejections < 1 && l.runs < 2)) continue;
    let start = -1;
    log.forEach((e, i) => {
      if (e.type === 'task.state' && e.data.taskId === t.taskId && e.data.to === 'running')
        start = i;
    });
    const steps = log
      .slice(Math.max(0, start))
      .filter(
        (e): e is Extract<LwEvent, { type: 'step.recorded' }> =>
          e.type === 'step.recorded' &&
          e.data.taskId === t.taskId &&
          e.data.agentId === t.role &&
          e.data.resultCode < 400,
      )
      .map((e) => clip(`${e.data.toolServer}.${e.data.operation}: ${e.data.summary}`, 160))
      .slice(0, 40);
    if (!steps.length) continue;
    procedures.push({
      ref: `task:${t.taskId}`,
      taskId: t.taskId,
      role: t.role,
      title: t.title,
      attempts: Math.max(t.attempt, l.runs),
      rejections: l.rejections,
      steps,
    });
  }

  return {
    phase,
    name: s.phases[phase]?.name ?? `Phase ${phase}`,
    tasks: tasks.length,
    items: items.slice(0, limit),
    procedures: procedures.sort((a, b) => b.rejections - a.rejections).slice(0, 12),
  };
}
