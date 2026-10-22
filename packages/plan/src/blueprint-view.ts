import type { BlueprintRow, BlueprintSnapshot, DecisionView, TaskView } from '@lw/contracts';
import type { Blueprint, BlueprintItem } from './blueprint';

/**
 * The Blueprint as the Workbench shows it: one row per item mapping source code to what a
 * marketer edits, with build status from the plan and what changed since the Director approved
 * it. Mapping detail lives in item `attrs`: source, fields, params, placeholders, variants (each a
 * string or a list), and optionally `was` (how the approved version described it).
 */

export interface BlueprintViewInput {
  seq: number;
  current: { version: number; blueprint: Blueprint };
  /** The version a Director gate approved, if any. */
  approved: { version: number; at: string; blueprint: Blueprint } | null;
  tasks: TaskView[];
  decisions: DecisionView[];
  /** Collections to show, in order, and what "done" is called in each. */
  collections?: { name: string; doneLabel: string }[];
}

const text = (v: unknown, fallback = '–'): string => {
  if (Array.isArray(v)) return v.length ? v.map(String).join(', ') : fallback;
  if (v === undefined || v === null || v === '') return fallback;
  return String(v);
};

function statusOf(item: BlueprintItem, tasks: TaskView[]): BlueprintRow['status'] {
  if (item.status === 'drop') return 'dropped';
  if (item.status === 'merge') return 'merged';
  const mine = tasks.filter((t) => t.itemKeys.includes(item.key) && t.state !== 'cancelled');
  if (!mine.length) return 'planned';
  if (mine.every((t) => t.state === 'done')) return 'done';
  if (mine.some((t) => t.state !== 'planned' && t.state !== 'ready')) return 'in_progress';
  return 'planned';
}

const comparable = (i: BlueprintItem) => {
  const { was: _was, ...attrs } = i.attrs as Record<string, unknown>;
  return JSON.stringify({ name: i.name, status: i.status, attrs });
};

export function blueprintSnapshot(input: BlueprintViewInput): BlueprintSnapshot {
  const { current, approved } = input;
  const collections = input.collections ?? [{ name: 'components', doneLabel: 'registered' }];
  const changedKeys = new Set<string>();

  const shown = collections.map(({ name, doneLabel }) => {
    const before = new Map(
      (approved?.blueprint.collections[name] ?? []).map((i) => [i.key, i] as const),
    );
    const rows: BlueprintRow[] = (current.blueprint.collections[name] ?? []).map((item) => {
      const a = item.attrs as Record<string, unknown>;
      const prior = before.get(item.key);
      const changed =
        approved !== null &&
        current.version !== approved.version &&
        (!prior || comparable(prior) !== comparable(item));
      if (changed) changedKeys.add(item.key);
      return {
        key: item.key,
        name: item.name,
        source: text(a.source, ''),
        fields: text(a.fields),
        params: text(a.params),
        placeholders: text(a.placeholders),
        variants: text(a.variants),
        status: statusOf(item, input.tasks),
        changed,
        was: changed
          ? typeof a.was === 'string'
            ? a.was
            : prior
              ? `${prior.name}: ${text((prior.attrs as Record<string, unknown>).fields)}`
              : `Not in version ${approved!.version}`
          : null,
      };
    });
    return { name, doneLabel, rows };
  });

  const updatedBy = approved
    ? input.decisions
        .filter(
          (d) =>
            d.ts > approved.at &&
            (d.scopeKey.startsWith('blueprint') ||
              [...changedKeys].some((k) => d.scopeKey === k || d.scopeKey.endsWith(`:${k}`))),
        )
        .map((d) => d.ref)
    : [];

  return {
    seq: input.seq,
    version: current.version,
    approvedVersion: approved?.version ?? null,
    approvedAt: approved?.at ?? null,
    updatedBy,
    collections: shown,
  };
}
