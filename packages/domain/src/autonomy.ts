import {
  DECISION_CATEGORY_LABEL,
  DecisionCategory,
  type AutonomyLevel,
  type SettingsSnapshot,
} from '@lw/contracts';
import type { ProjectState } from './projector';

/** Always the Director's: releases, gates and budget, and what is in scope. */
export const LOCKED_CATEGORIES: readonly DecisionCategory[] = ['release', 'scope'];

/**
 * Where a playbook says nothing. The categories a Lead can settle start in shadow, so its answers
 * are compared with the Director's before it is trusted with them.
 */
export const FALLBACK_AUTONOMY: Record<DecisionCategory, AutonomyLevel> = {
  media: 'shadow',
  tool: 'shadow',
  retry: 'shadow',
  ownership: 'shadow',
  naming: 'shadow',
  content: 'shadow',
  access: 'ask',
  scope: 'ask',
  release: 'ask',
  other: 'ask',
};

export type AutonomyRow = SettingsSnapshot['autonomy'][number];

/**
 * Who may settle each category on this project: the project's choice over the playbook's default
 * over the fallback, except locked categories, which are always the Director's.
 */
export function autonomyOf(
  s: Pick<ProjectState, 'settings'>,
  playbookDefaults: Partial<Record<DecisionCategory, AutonomyLevel>> = {},
): AutonomyRow[] {
  const chosen = (s.settings.autonomy ?? {}) as Partial<Record<DecisionCategory, AutonomyLevel>>;
  return DecisionCategory.options.map((category) => {
    const locked = LOCKED_CATEGORIES.includes(category);
    const fallback = locked ? 'ask' : (playbookDefaults[category] ?? FALLBACK_AUTONOMY[category]);
    return {
      category,
      label: DECISION_CATEGORY_LABEL[category],
      level: locked ? 'ask' : (chosen[category] ?? fallback),
      default: fallback,
      locked,
    };
  });
}

/** The level for one category. */
export function autonomyFor(
  s: Pick<ProjectState, 'settings'>,
  category: DecisionCategory,
  playbookDefaults: Partial<Record<DecisionCategory, AutonomyLevel>> = {},
): AutonomyLevel {
  return autonomyOf(s, playbookDefaults).find((r) => r.category === category)!.level;
}
