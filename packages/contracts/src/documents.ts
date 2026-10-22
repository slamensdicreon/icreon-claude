import { z } from 'zod';

/**
 * Structured documents agents write and the Workbench renders: inventories, reports, Platform
 * Notes. Stored as JSON artifacts (`format: json`) whose content parses as one of these.
 */

const Cell = z.union([
  z.string(),
  z.object({
    text: z.string(),
    /** Rendered as a state chip ("done", "waiting", "failed"). */
    chip: z.string().optional(),
    mono: z.boolean().optional(),
    muted: z.boolean().optional(),
    strong: z.boolean().optional(),
    /** Secondary text after the chip or value. */
    sub: z.string().optional(),
  }),
]);
export type DocCell = z.infer<typeof Cell>;

export const DocBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('paragraph'), text: z.string() }),
  z.object({ type: z.literal('heading'), text: z.string() }),
  z.object({ type: z.literal('note'), text: z.string() }),
  z.object({ type: z.literal('list'), items: z.array(z.string()) }),
  z.object({
    type: z.literal('table'),
    columns: z.array(z.object({ label: z.string(), align: z.enum(['left', 'num']).optional() })),
    rows: z.array(z.array(Cell)),
  }),
  /** Score tiles (Lighthouse). */
  z.object({
    type: z.literal('scores'),
    items: z.array(z.object({ label: z.string(), value: z.number() })),
  }),
  /** Images by blob reference or URL, with captions; `compare` lays two out side by side. */
  z.object({
    type: z.literal('images'),
    layout: z.enum(['compare', 'gallery']).default('gallery'),
    items: z.array(z.object({ ref: z.string(), caption: z.string().default('') })),
  }),
]);
export type DocBlock = z.infer<typeof DocBlock>;

export const ArtifactDocument = z.object({
  doc: z.literal('lw.document/1'),
  /** Right-aligned meta under the title ("Repo Analyst, Mon"). */
  meta: z.string().nullable().default(null),
  intro: z.string().nullable().default(null),
  blocks: z.array(DocBlock),
});
export type ArtifactDocument = z.infer<typeof ArtifactDocument>;

export const PullRequestDocument = z.object({
  doc: z.literal('lw.pull_request/1'),
  number: z.number().int(),
  title: z.string(),
  head: z.string(),
  base: z.string(),
  state: z.enum(['open', 'merged', 'closed']),
  author: z.string(),
  openedAt: z.iso.datetime(),
  mergedAt: z.iso.datetime().nullable().default(null),
  mergedBy: z.string().nullable().default(null),
  url: z.string().nullable().default(null),
  summary: z.string().nullable().default(null),
  files: z.array(
    z.object({ path: z.string(), additions: z.number().int(), deletions: z.number().int() }),
  ),
  filesChanged: z.number().int(),
});
export type PullRequestDocument = z.infer<typeof PullRequestDocument>;
