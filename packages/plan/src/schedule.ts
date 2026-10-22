import type { TaskState } from '@lw/contracts';
import type { Plan, PlannedTask } from './compile';

export type TaskStates = Record<string, TaskState>;

const SETTLED: ReadonlySet<TaskState> = new Set(['done', 'cancelled']);

const stateOf = (states: TaskStates, id: string): TaskState => states[id] ?? 'planned';

/** Phases whose prerequisite phases are all done and which have not started yet. */
export function startablePhases(
  plan: Plan,
  done: ReadonlySet<number>,
  started: ReadonlySet<number>,
): number[] {
  return plan.phases
    .filter((p) => !started.has(p.number) && p.dependsOn.every((d) => done.has(d)))
    .map((p) => p.number);
}

/**
 * Tasks the orchestrator may dispatch now: still `planned`, in an active phase, every dependency
 * settled. Returned in plan order, so dispatch under a concurrency limit is deterministic.
 */
export function readyTasks(
  plan: Plan,
  states: TaskStates,
  activePhases: ReadonlySet<number>,
): PlannedTask[] {
  return plan.tasks.filter(
    (t) =>
      activePhases.has(t.phase) &&
      stateOf(states, t.taskId) === 'planned' &&
      t.dependsOn.every((d) => SETTLED.has(stateOf(states, d))),
  );
}

/** A phase is complete when every one of its tasks is done or cancelled. */
export function phaseComplete(plan: Plan, states: TaskStates, phase: number): boolean {
  return plan.tasks
    .filter((t) => t.phase === phase)
    .every((t) => SETTLED.has(stateOf(states, t.taskId)));
}

/** Percent of a phase's non-cancelled tasks that are done. */
export function phasePercent(plan: Plan, states: TaskStates, phase: number): number {
  const tasks = plan.tasks.filter(
    (t) => t.phase === phase && stateOf(states, t.taskId) !== 'cancelled',
  );
  if (!tasks.length) return 100;
  return Math.round(
    (tasks.filter((t) => stateOf(states, t.taskId) === 'done').length / tasks.length) * 100,
  );
}

/**
 * Order in which to undo completed tasks: dependents before what they depend on (reverse
 * topological order), restricted to the given tasks.
 */
export function rollbackOrder(plan: Plan, taskIds: Iterable<string>): string[] {
  const wanted = new Set(taskIds);
  return plan.tasks
    .filter((t) => wanted.has(t.taskId))
    .map((t) => t.taskId)
    .reverse();
}

/** Everything downstream of a task (transitively), e.g. what a re-run invalidates. */
export function dependentsOf(plan: Plan, taskId: string): string[] {
  const out = new Set<string>();
  const queue = [taskId];
  while (queue.length) {
    const id = queue.shift()!;
    for (const t of plan.tasks) {
      if (t.dependsOn.includes(id) && !out.has(t.taskId)) {
        out.add(t.taskId);
        queue.push(t.taskId);
      }
    }
  }
  return plan.tasks.filter((t) => out.has(t.taskId)).map((t) => t.taskId);
}
