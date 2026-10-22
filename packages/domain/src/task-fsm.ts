import type { TaskState } from '@lw/contracts';

/** Max times a Lead may reject a specialist's output before the task blocks and escalates. */
export const MAX_REJECTIONS = 2;

const TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  planned: ['ready', 'cancelled'],
  ready: ['running', 'paused', 'blocked', 'cancelled'],
  running: ['validating', 'blocked', 'paused', 'cancelled'],
  validating: ['done', 'rejected', 'blocked'],
  rejected: ['running', 'blocked'],
  blocked: ['running', 'ready', 'cancelled'],
  paused: ['running', 'ready', 'cancelled'],
  done: ['rolled_back'],
  cancelled: [],
  rolled_back: ['ready'],
};

export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set(['done', 'cancelled']);

/** States in which a task is consuming effort right now. */
export const ACTIVE_TASK_STATES: ReadonlySet<TaskState> = new Set(['running', 'validating']);

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly taskId: string,
    readonly from: TaskState,
    readonly to: TaskState,
  ) {
    super(`Task ${taskId}: illegal transition ${from} → ${to}`);
  }
}

export function assertTransition(taskId: string, from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(taskId, from, to);
}

/**
 * Attempt numbering starts at 1 for the first run; each rejection that goes back to `running`
 * increments it. A task "in its second retry" (design spec, health rule) is on attempt 3.
 */
export function isInSecondRetry(state: TaskState, attempt: number): boolean {
  return ACTIVE_TASK_STATES.has(state) && attempt >= MAX_REJECTIONS + 1;
}
