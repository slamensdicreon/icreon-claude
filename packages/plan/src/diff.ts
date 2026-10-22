import type { TaskState } from '@lw/contracts';
import type { CollectionDiff } from './blueprint';
import type { Plan, PlannedTask } from './compile';

export interface PlanDiff {
  added: PlannedTask[];
  removed: PlannedTask[];
  /** Same id, different scope: title, items covered, dependencies or role. */
  changed: { before: PlannedTask; after: PlannedTask; fields: (keyof PlannedTask)[] }[];
}

const COMPARED: (keyof PlannedTask)[] = ['title', 'itemKeys', 'dependsOn', 'role', 'kind', 'gate'];

export function diffPlans(before: Plan, after: Plan): PlanDiff {
  const a = new Map(before.tasks.map((t) => [t.taskId, t]));
  const b = new Map(after.tasks.map((t) => [t.taskId, t]));
  const changed: PlanDiff['changed'] = [];
  for (const [id, t] of b) {
    const old = a.get(id);
    if (!old) continue;
    const fields = COMPARED.filter((f) => JSON.stringify(old[f]) !== JSON.stringify(t[f]));
    if (fields.length) changed.push({ before: old, after: t, fields });
  }
  return {
    added: [...b.values()].filter((t) => !a.has(t.taskId)),
    removed: [...a.values()].filter((t) => !b.has(t.taskId)),
    changed,
  };
}

export interface Impact {
  diff: PlanDiff;
  /** Removed tasks that already ran: their effects on the tenant must be rolled back. */
  rollback: string[];
  /** Changed tasks that already ran or are running: they re-run with the new scope. */
  rerun: string[];
  /** Removed tasks that hadn't started: simply cancelled. */
  cancel: string[];
  /** One sentence for the Chief of Staff's acknowledgement and the Workbench side note. */
  summary: string;
}

const STARTED: ReadonlySet<TaskState> = new Set([
  'running',
  'validating',
  'rejected',
  'blocked',
  'paused',
  'done',
]);

/**
 * What applying a re-plan would do to a running project. Feeds the directive acknowledgement
 * ("Skipping blog templates removes 3 templates and 41 pages…") and every dry-run preview.
 */
export function impactOf(
  diff: PlanDiff,
  states: Record<string, TaskState>,
  scope: CollectionDiff[] = [],
): Impact {
  const started = (id: string) => STARTED.has(states[id] ?? 'planned');
  const rollback = diff.removed.filter((t) => states[t.taskId] === 'done').map((t) => t.taskId);
  const cancel = diff.removed.filter((t) => !started(t.taskId)).map((t) => t.taskId);
  const rerun = diff.changed
    .filter((c) => started(c.after.taskId) && c.fields.some((f) => f !== 'dependsOn'))
    .map((c) => c.after.taskId);

  const parts: string[] = [];
  const scopeWords = (verb: string, pick: (c: CollectionDiff) => number) => {
    const counts = scope.map((c) => [pick(c), c.collection] as const).filter(([n]) => n > 0);
    if (counts.length)
      parts.push(`${verb} ${list(counts.map(([n, c]) => `${n} ${n === 1 ? singular(c) : c}`))}`);
  };
  scopeWords('removes', (c) => c.dropped.length);
  scopeWords('adds', (c) => c.added.length);
  scopeWords('changes', (c) => c.changed.length);
  if (!parts.length) {
    if (diff.removed.length) parts.push(`removes ${n(diff.removed.length, 'task')}`);
    if (diff.added.length) parts.push(`adds ${n(diff.added.length, 'task')}`);
    if (diff.changed.length) parts.push(`changes ${n(diff.changed.length, 'task')}`);
  }
  const consequences: string[] = [];
  if (rollback.length) consequences.push(`${n(rollback.length, 'completed task')} rolled back`);
  if (rerun.length) consequences.push(`${n(rerun.length, 'started task')} re-run`);
  const head = parts.length
    ? capitalize(parts.join(' and ')) + ' in scope'
    : 'No change to the plan';
  const summary = consequences.length ? `${head}; ${list(consequences)}.` : `${head}.`;
  return { diff, rollback, rerun, cancel, summary };
}

function n(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function singular(collection: string) {
  return collection.endsWith('s') ? collection.slice(0, -1) : collection;
}

function list(items: string[]) {
  return items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
