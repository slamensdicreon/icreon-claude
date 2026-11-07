import { safeCanonical } from '../page-load';
import type { UrlPolicy } from '../ssrf';
import { fetchPage, type FetchOptions } from './http';
import { ALLOW_ALL, parseRobots, type Robots } from './robots';

export interface SitemapEntry {
  url: string;
  lastmod: string | null;
}

export interface Discovery {
  /** Where the start URL ended up: a bare domain usually redirects to www, or http to https. */
  origin: string;
  start: string;
  robots: Robots;
  /** Page URLs on the origin, deduplicated, in the sitemaps' order. */
  entries: SitemapEntry[];
  /** The sitemap files read (an index's children included). */
  sitemaps: string[];
}

export interface DiscoverOptions extends FetchOptions {
  /** Most child sitemaps an index may send us to (default 200). */
  maxSitemaps?: number;
  /** Most URLs taken from the sitemaps (default 100,000). */
  maxUrls?: number;
}

const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");

/**
 * Finds a site's pages before reading any: follows the start URL's redirects to the real origin,
 * reads robots.txt (its rules, Crawl-delay and the sitemaps it lists), then the sitemaps, child
 * sitemaps of an index included (gzipped ones too). Never throws: a site without robots.txt or a
 * sitemap is crawled from its links.
 */
export async function discover(
  start: string,
  policy: UrlPolicy,
  opts: DiscoverOptions = {},
): Promise<Discovery> {
  let origin = new URL(start).origin;
  let resolvedStart = safeCanonical(start) ?? start;
  try {
    const head = await fetchPage(start, policy, { ...opts, timeoutMs: opts.timeoutMs ?? 20_000 });
    if (head.status < 400) {
      origin = new URL(head.finalUrl).origin;
      resolvedStart = safeCanonical(head.finalUrl) ?? resolvedStart;
    }
  } catch {
    /* read below what we can */
  }

  const robots = await readRobots(origin, policy, opts);

  const maxSitemaps = opts.maxSitemaps ?? 200;
  const maxUrls = opts.maxUrls ?? 100_000;
  const queue = robots.sitemaps.length ? [...robots.sitemaps] : [`${origin}/sitemap.xml`];
  const read = new Set<string>();
  const seen = new Set<string>();
  const entries: SitemapEntry[] = [];
  while (queue.length && read.size < maxSitemaps && entries.length < maxUrls) {
    const next = queue.shift()!;
    if (read.has(next)) continue;
    read.add(next);
    let xml: string;
    try {
      const r = await fetchPage(next, policy, { ...opts, timeoutMs: 20_000 });
      if (r.status !== 200) continue;
      xml = r.body;
    } catch {
      // A sitemap on a host the project may not visit, or one that won't answer: skip it.
      continue;
    }
    if (/<sitemapindex\b/i.test(xml)) {
      for (const m of xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)/gi))
        queue.push(decode(m[1]!));
      continue;
    }
    for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
      const loc = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)/i.exec(m[1]!)?.[1];
      if (!loc) continue;
      const url = onOrigin(safeCanonical(decode(loc)), origin);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const lastmod = /<lastmod>\s*([^<\s]+)/i.exec(m[1]!)?.[1] ?? null;
      entries.push({ url, lastmod });
      if (entries.length >= maxUrls) break;
    }
  }
  return { origin, start: resolvedStart, robots, entries, sitemaps: [...read] };
}

/** The site's robots.txt, or allow-all when it has none (or answers with a page). */
export async function readRobots(
  origin: string,
  policy: UrlPolicy,
  opts: FetchOptions = {},
): Promise<Robots> {
  try {
    const r = await fetchPage(`${origin}/robots.txt`, policy, { ...opts, timeoutMs: 10_000 });
    if (r.status === 200 && !/html/i.test(r.contentType)) return parseRobots(r.body);
  } catch {
    /* none */
  }
  return ALLOW_ALL;
}

/**
 * The URL on the crawl's origin, or null when it is elsewhere. A sitemap that writes the other
 * spelling of the host (`example.com` for `www.example.com`) or the other scheme means the same
 * page: it is moved onto the origin rather than dropped.
 */
export function onOrigin(url: string | null, origin: string): string | null {
  if (!url) return null;
  const u = new URL(url);
  if (u.origin === origin) return url;
  const o = new URL(origin);
  const bare = (h: string) => h.toLowerCase().replace(/^www\./, '');
  if (bare(u.hostname) !== bare(o.hostname) || (u.port || '') !== (o.port || '')) return null;
  u.protocol = o.protocol;
  u.hostname = o.hostname;
  return u.toString();
}
