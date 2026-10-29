import { z } from 'zod';

/**
 * The Blueprint as the plan compiler sees it: named collections of items. What a collection means
 * (components, templates, pages) belongs to the playbook; the compiler only expands over it.
 */
export const BlueprintItem = z.object({
  /** Stable, kebab-case. Task ids derive from it, so it must not change across versions. */
  key: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string(),
  /** `drop` removes the item from scope; merge and split are recorded decisions that still ship. */
  status: z.enum(['keep', 'merge', 'split', 'drop']).default('keep'),
  /** Part of the pilot slice (built end to end before the rest). */
  pilot: z.boolean().default(false),
  attrs: z.record(z.string(), z.unknown()).default({}),
});
export type BlueprintItem = z.infer<typeof BlueprintItem>;

export const Blueprint = z.object({
  version: z.number().int().positive(),
  collections: z.record(z.string(), z.array(BlueprintItem)),
});
export type Blueprint = z.infer<typeof Blueprint>;

export interface CollectionDiff {
  collection: string;
  added: BlueprintItem[];
  dropped: BlueprintItem[];
  changed: { before: BlueprintItem; after: BlueprintItem }[];
}

const inScope = (i: BlueprintItem) => i.status !== 'drop';

/** Item-level difference between two Blueprint versions, by collection. */
export function diffBlueprints(before: Blueprint, after: Blueprint): CollectionDiff[] {
  const names = new Set([...Object.keys(before.collections), ...Object.keys(after.collections)]);
  const out: CollectionDiff[] = [];
  for (const collection of [...names].sort()) {
    const a = new Map(
      (before.collections[collection] ?? []).filter(inScope).map((i) => [i.key, i]),
    );
    const b = new Map((after.collections[collection] ?? []).filter(inScope).map((i) => [i.key, i]));
    const diff: CollectionDiff = {
      collection,
      added: [...b.values()].filter((i) => !a.has(i.key)),
      dropped: [...a.values()].filter((i) => !b.has(i.key)),
      changed: [...b.values()]
        .filter((i) => a.has(i.key) && JSON.stringify(a.get(i.key)) !== JSON.stringify(i))
        .map((after) => ({ before: a.get(after.key)!, after })),
    };
    if (diff.added.length || diff.dropped.length || diff.changed.length) out.push(diff);
  }
  return out;
}
