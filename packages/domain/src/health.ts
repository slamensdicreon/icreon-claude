import type { Budgets, Health, Spend, TaskState } from '@lw/contracts';
import { isInSecondRetry } from './task-fsm';

/** Soft budget warning threshold (NFR-09). */
export const BUDGET_SOFT = 0.8;

export interface HealthInput {
  openBlockers: { title: string }[];
  tasks: { title: string; state: TaskState; attempt: number }[];
  budgets: Budgets;
  spent: Spend;
}

export interface HealthResult {
  health: Health;
  reason: string | null;
}

/**
 * Design spec §4, status strip: Blocked if any Blocker escalation is open; Attention if any task is
 * in its second retry or budget is above 80%; otherwise Healthy.
 */
export function computeHealth({ openBlockers, tasks, budgets, spent }: HealthInput): HealthResult {
  const blocker = openBlockers[0];
  if (blocker) {
    const more = openBlockers.length > 1 ? ` (+${openBlockers.length - 1} more)` : '';
    return { health: 'blocked', reason: `Blocker open: ${blocker.title}${more}` };
  }

  const retrying = tasks.find((t) => isInSecondRetry(t.state, t.attempt));
  if (retrying) {
    return { health: 'attention', reason: `${retrying.title} is on its second retry` };
  }

  const usage = budgetUsage(budgets, spent);
  if (usage.max > BUDGET_SOFT) {
    return {
      health: 'attention',
      reason: `${usage.dimension} budget at ${Math.round(usage.max * 100)}%`,
    };
  }

  return { health: 'healthy', reason: null };
}

export function budgetUsage(budgets: Budgets, spent: Spend) {
  const dims = [
    { dimension: 'Token', ratio: spent.tokens / budgets.tokens },
    { dimension: 'Cost', ratio: spent.usd / budgets.usd },
    { dimension: 'Time', ratio: spent.hours / budgets.hours },
  ];
  const top = dims.reduce((a, b) => (b.ratio > a.ratio ? b : a));
  return { max: top.ratio, dimension: top.dimension };
}
