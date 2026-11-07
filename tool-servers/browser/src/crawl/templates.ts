/**
 * Groups a crawl's pages into templates, so agents reason about 30 kinds of page instead of 3,000
 * pages. Two signals: where a page sits (its URL pattern: `/resources/learn/*`) and how it is
 * built (its layout, the sequence of its main sections). Pages under one parent that are built
 * alike are one template; one parent can hold several (a listing and its articles); and groups
 * under different parents built the same way merge (`/products/hr/*` and `/products/finance/*`).
 */

export interface TemplatePage {
  url: string;
  title?: string;
  words: number;
  layout: string[];
}

export interface Template {
  /** Stable while the crawl runs on: from its main URL pattern (`resources-learn`). */
  id: string;
  /** The URL patterns it covers, most pages first, with how many each. */
  patterns: { pattern: string; pages: number }[];
  pages: number;
  /** Up to three pages to read as its examples: the longest, a typical one and the shortest. */
  examples: string[];
  /** Its layout: the sections its pages share, in order. */
  layout: string[];
  avgWords: number;
}

/** A path segment that varies per item: numbers, dates, IDs, hashes. */
const VARIABLE = /^(\d+|\d{4}-\d{2}(-\d{2})?|[0-9a-f]{8,}|[0-9a-f-]{32,36})$/i;

/** Where a page sits: its parent with a wildcard (`/blog/*`); a top-level page is its own. */
export function urlPattern(raw: string): string {
  const segments = new URL(raw).pathname
    .split('/')
    .filter(Boolean)
    .map((s) => (VARIABLE.test(s) ? '*' : s));
  if (!segments.length) return '/';
  if (segments.length === 1) return `/${segments[0]}`;
  return `/${segments.slice(0, -1).join('/')}/*`;
}

function jaccard(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 1;
  const A = new Set(a);
  const B = new Set(b);
  let both = 0;
  for (const x of A) if (B.has(x)) both++;
  return both / (A.size + B.size - both);
}

interface Cluster {
  rep: string[];
  pages: TemplatePage[];
  patterns: Map<string, number>;
}

const slug = (pattern: string) =>
  pattern === '/'
    ? 'home'
    : pattern
        .replace(/\/\*$/, '')
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase() || 'pages';

/** Same parent, built alike: at least this much of their layouts in common. */
const SAME_PARENT = 0.5;
/** Different parents, or top-level pages: almost the same layout. */
const ACROSS = 0.8;
/** Fewer section tokens than this can't tell layouts apart across URL patterns. */
const MIN_LAYOUT = 3;

export interface Grouping {
  templates: Template[];
  /** Each page's template id, by URL: the same grouping, so counts and lists always agree. */
  templateOf: Map<string, string>;
}

export function groupTemplates(pages: TemplatePage[]): Grouping {
  const byPattern = new Map<string, TemplatePage[]>();
  for (const p of pages) {
    const k = urlPattern(p.url);
    const list = byPattern.get(k) ?? [];
    list.push(p);
    byPattern.set(k, list);
  }

  // Within each parent: one cluster per layout family.
  const clusters: Cluster[] = [];
  const loose: TemplatePage[] = [];
  for (const [pattern, list] of byPattern) {
    if (!pattern.endsWith('/*')) {
      loose.push(...list);
      continue;
    }
    const local: Cluster[] = [];
    for (const p of list) {
      const c = local.find((c) => jaccard(c.rep, p.layout) >= SAME_PARENT);
      if (c) {
        c.pages.push(p);
        c.patterns.set(pattern, (c.patterns.get(pattern) ?? 0) + 1);
      } else local.push({ rep: p.layout, pages: [p], patterns: new Map([[pattern, 1]]) });
    }
    clusters.push(...local);
  }

  // Across parents, and the top-level pages: merge what is built the same way.
  const merged: Cluster[] = [];
  // A layout of one or two tokens says nothing (every page is "div"): such pages merge with
  // nothing, so their URL patterns keep them apart.
  const add = (c: Cluster) => {
    const m =
      c.rep.length >= MIN_LAYOUT
        ? merged.find((m) => m.rep.length >= MIN_LAYOUT && jaccard(m.rep, c.rep) >= ACROSS)
        : undefined;
    if (!m) return merged.push(c);
    m.pages.push(...c.pages);
    for (const [k, n] of c.patterns) m.patterns.set(k, (m.patterns.get(k) ?? 0) + n);
  };
  for (const c of clusters.sort((a, b) => b.pages.length - a.pages.length)) add(c);
  for (const p of loose)
    add({ rep: p.layout, pages: [p], patterns: new Map([[urlPattern(p.url), 1]]) });

  const used = new Map<string, number>();
  const templateOf = new Map<string, string>();
  const templates = merged
    .sort(
      (a, b) => b.pages.length - a.pages.length || a.pages[0]!.url.localeCompare(b.pages[0]!.url),
    )
    .map((c) => {
      const patterns = [...c.patterns]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([pattern, n]) => ({ pattern, pages: n }));
      const base = slug(patterns[0]!.pattern);
      const n = (used.get(base) ?? 0) + 1;
      used.set(base, n);
      const id = n === 1 ? base : `${base}-${n}`;
      for (const p of c.pages) templateOf.set(p.url, id);
      const byWords = [...c.pages].sort((a, b) => b.words - a.words);
      const examples = [
        ...new Set([
          byWords[0]!.url,
          byWords[Math.floor(byWords.length / 2)]!.url,
          byWords[byWords.length - 1]!.url,
        ]),
      ];
      return {
        id,
        patterns,
        pages: c.pages.length,
        examples,
        layout: c.rep.slice(0, 15),
        avgWords: Math.round(c.pages.reduce((s, p) => s + p.words, 0) / c.pages.length),
      };
    });
  return { templates, templateOf };
}
