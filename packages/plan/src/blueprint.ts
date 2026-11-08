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

/**
 * What the Blueprint covers of the site, when Discovery read only part of it: the pages the crawl
 * and the sitemap found, and how the rest is handled (built from these templates, imported, left
 * out), so a sample never silently becomes the scope. Shown at Gate 1.
 */
export const BlueprintScope = z.object({
  /** Pages the crawl and the sitemap found. */
  pagesFound: z.number().int().nonnegative(),
  /** How the pages beyond `pages` are handled, and why: one or two sentences. */
  approach: z.string().min(10).max(1000),
  /** Sections (sitemap paths) handled another way, with their page counts. */
  sections: z
    .array(z.object({ path: z.string(), pages: z.number().int().nonnegative(), plan: z.string() }))
    .default([]),
});
export type BlueprintScope = z.infer<typeof BlueprintScope>;

export const Blueprint = z.object({
  version: z.number().int().positive(),
  collections: z.record(z.string(), z.array(BlueprintItem)),
  scope: BlueprintScope.optional(),
});
export type Blueprint = z.infer<typeof Blueprint>;

export interface CollectionDiff {
  collection: string;
  added: BlueprintItem[];
  dropped: BlueprintItem[];
  changed: { before: BlueprintItem; after: BlueprintItem }[];
}

const inScope = (i: BlueprintItem) => i.status !== 'drop';

/**
 * Does the item get tasks of its own? Not when dropped, nor when merged into another item
 * (`status: 'merge'` naming it in `attrs.mergedInto`): it ships with that item's tasks.
 */
export const hasOwnWork = (i: BlueprintItem) =>
  i.status !== 'drop' && !(i.status === 'merge' && Boolean(i.attrs?.mergedInto));

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
