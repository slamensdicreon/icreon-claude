import type { PageExtract } from '../extract';

export type CrawlStatus = 'running' | 'done' | 'stopped' | 'failed';
export type UrlState = 'queued' | 'inflight' | 'done' | 'excluded' | 'failed';
export type UrlSource = 'start' | 'sitemap' | 'link' | 'redirect';

export interface CrawlOptions {
  maxPages: number;
  maxDepth: number;
  /** Requests at once at the start; the pacer lowers it when the site throttles. */
  concurrency: number;
  respectRobots: boolean;
  /** Longest the whole crawl may run before it stops with what it has. */
  maxRunMs: number;
  /** A finished crawl of the same site: its pages whose sitemap lastmod hasn't changed are kept. */
  reuseFrom: string | null;
}

export interface CrawlStats {
  /** Pages read over plain HTTP and parsed without running scripts. */
  http: number;
  /** Pages read again in a real browser: built by scripts, or refused to a plain client. */
  rendered: number;
  /** Kept from an earlier crawl: unchanged by the sitemap's lastmod. */
  reused: number;
  /** 429 and 503 answers: the site asking us to slow down. */
  throttled: number;
  /** 401 and 403 answers, or challenge pages, also to a real browser: bot protection. */
  refused: number;
  /** Challenge pages served with 200 to a plain client (passed or not in a browser). */
  challenged: number;
  /** URLs found but not queued: past maxPages. */
  dropped: number;
  /** Disallowed by robots.txt. */
  robots: number;
  /** When the crawl began reading pages (after discovery), ISO. */
  readingSince: string | null;
}

export const emptyStats = (): CrawlStats => ({
  http: 0,
  rendered: 0,
  reused: 0,
  throttled: 0,
  refused: 0,
  challenged: 0,
  dropped: 0,
  robots: 0,
  readingSince: null,
});

export interface CrawlJob {
  id: string;
  projectId: string;
  origin: string;
  startUrl: string;
  status: CrawlStatus;
  options: CrawlOptions;
  stats: CrawlStats;
  /** URLs the sitemaps list (-1 until discovery has run). */
  sitemapUrls: number;
  /** Why it stopped or failed, in a sentence. */
  message: string | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

/** What's kept of a page read: the extract, plus where it came from and how it was read. */
export interface StoredPage extends PageExtract {
  url: string;
  status: number;
  via: 'http' | 'browser' | 'reused';
}

/** A page's few fields for listing and grouping, without loading every extract. */
export interface PageSummary {
  title: string;
  description: string | null;
  h1: string | null;
  lang: string | null;
  words: number;
  images: number;
  layout: string[];
  regions: Record<string, { hash: string; text: string } | null>;
}

export interface CrawlUrl {
  url: string;
  state: UrlState;
  depth: number;
  source: UrlSource;
  lastmod: string | null;
  attempts: number;
  reason: string | null;
  summary: PageSummary | null;
}

export interface NewUrl {
  url: string;
  depth: number;
  source: UrlSource;
  lastmod: string | null;
}

export interface UrlOutcome {
  state: Exclude<UrlState, 'inflight'>;
  reason?: string | null;
  page?: StoredPage | null;
  attempts?: number;
}

export interface UrlFilter {
  states?: UrlState[];
  /** URLs starting with this (a path prefix on the origin, or a whole URL). */
  prefix?: string;
  /** These URLs only. */
  urls?: string[];
  limit?: number;
  offset?: number;
}

/**
 * Where crawls live: the job and every URL it found, so a crawl survives a restart, any worker can
 * pick up a crawl whose worker died (the lease), and agents read pages from here rather than from
 * a tool result that has to fit their context.
 */
export interface CrawlStore {
  create(job: CrawlJob): Promise<void>;
  get(id: string): Promise<CrawlJob | null>;
  /** The project's most recent crawl, of this origin when given. */
  latest(projectId: string, origin?: string): Promise<CrawlJob | null>;
  /** Crawls still running, for resuming after a restart. */
  running(): Promise<CrawlJob[]>;
  update(
    id: string,
    patch: Partial<
      Pick<
        CrawlJob,
        'status' | 'stats' | 'sitemapUrls' | 'message' | 'finishedAt' | 'origin' | 'startUrl'
      >
    >,
  ): Promise<void>;
  /** Takes or renews the crawl for `owner`, if no other owner holds it; true when held. */
  lease(id: string, owner: string, ms: number): Promise<boolean>;
  release(id: string, owner: string): Promise<void>;

  /** Adds URLs not already known; returns how many were new. */
  enqueue(id: string, urls: NewUrl[]): Promise<number>;
  /** Copies `fromId`'s read pages whose lastmod matches; returns the URLs copied. */
  reuse(
    fromId: string,
    toId: string,
    entries: { url: string; lastmod: string }[],
  ): Promise<string[]>;
  /** Up to `n` queued URLs, oldest first, marked in flight. */
  claim(id: string, n: number): Promise<CrawlUrl[]>;
  /** In-flight URLs back to queued (their worker died); returns how many. */
  requeue(id: string): Promise<number>;
  finish(id: string, url: string, outcome: UrlOutcome): Promise<void>;
  counts(id: string): Promise<Record<UrlState, number>>;
  urls(id: string, filter?: UrlFilter): Promise<CrawlUrl[]>;
  page(id: string, url: string): Promise<{ url: CrawlUrl; page: StoredPage | null } | null>;
}

export function summarize(p: StoredPage): PageSummary {
  return {
    title: p.title,
    description: p.description,
    h1: p.headings.find((h) => h.level === 1)?.text ?? null,
    lang: p.lang,
    words: p.wordCount,
    images: p.images.length,
    layout: p.layout ?? [],
    regions: p.regions,
  };
}

const zero = (): Record<UrlState, number> => ({
  queued: 0,
  inflight: 0,
  done: 0,
  excluded: 0,
  failed: 0,
});

interface Row extends CrawlUrl {
  seq: number;
  page: StoredPage | null;
}

/** For tests and single-process runs: lost on restart. */
export class MemoryCrawlStore implements CrawlStore {
  private readonly jobs = new Map<string, CrawlJob>();
  private readonly leases = new Map<string, { owner: string; until: number }>();
  private readonly rows = new Map<string, Map<string, Row>>();
  private seq = 0;

  async create(job: CrawlJob) {
    this.jobs.set(job.id, structuredClone(job));
    this.rows.set(job.id, new Map());
  }

  async get(id: string) {
    const j = this.jobs.get(id);
    return j ? structuredClone(j) : null;
  }

  async latest(projectId: string, origin?: string) {
    const all = [...this.jobs.values()]
      .filter((j) => j.projectId === projectId && (!origin || j.origin === origin))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return all[0] ? structuredClone(all[0]) : null;
  }

  async running() {
    return [...this.jobs.values()]
      .filter((j) => j.status === 'running')
      .map((j) => structuredClone(j));
  }

  async update(id: string, patch: Parameters<CrawlStore['update']>[1]) {
    const j = this.jobs.get(id);
    if (j) Object.assign(j, structuredClone(patch), { updatedAt: new Date().toISOString() });
  }

  async lease(id: string, owner: string, ms: number) {
    const l = this.leases.get(id);
    if (l && l.owner !== owner && l.until > Date.now()) return false;
    this.leases.set(id, { owner, until: Date.now() + ms });
    return true;
  }

  async release(id: string, owner: string) {
    if (this.leases.get(id)?.owner === owner) this.leases.delete(id);
  }

  async enqueue(id: string, urls: NewUrl[]) {
    const rows = this.rows.get(id)!;
    let added = 0;
    for (const u of urls) {
      if (rows.has(u.url)) continue;
      rows.set(u.url, {
        ...u,
        seq: ++this.seq,
        state: 'queued',
        attempts: 0,
        reason: null,
        summary: null,
        page: null,
      });
      added++;
    }
    return added;
  }

  async reuse(fromId: string, toId: string, entries: { url: string; lastmod: string }[]) {
    const from = this.rows.get(fromId);
    const to = this.rows.get(toId)!;
    const out: string[] = [];
    for (const e of entries) {
      const r = from?.get(e.url);
      if (!r || r.state !== 'done' || r.lastmod !== e.lastmod || to.has(e.url)) continue;
      to.set(e.url, {
        ...structuredClone(r),
        seq: ++this.seq,
        source: 'sitemap',
        page: r.page ? { ...structuredClone(r.page), via: 'reused' } : null,
      });
      out.push(e.url);
    }
    return out;
  }

  async claim(id: string, n: number) {
    const out: CrawlUrl[] = [];
    for (const r of [...this.rows.get(id)!.values()].sort((a, b) => a.seq - b.seq)) {
      if (out.length >= n) break;
      if (r.state !== 'queued') continue;
      r.state = 'inflight';
      out.push(view(r));
    }
    return out;
  }

  async requeue(id: string) {
    let n = 0;
    for (const r of this.rows.get(id)?.values() ?? [])
      if (r.state === 'inflight') {
        r.state = 'queued';
        n++;
      }
    return n;
  }

  async finish(id: string, url: string, o: UrlOutcome) {
    const r = this.rows.get(id)?.get(url);
    if (!r) return;
    r.state = o.state;
    r.reason = o.reason ?? null;
    if (o.attempts !== undefined) r.attempts = o.attempts;
    if (o.page) {
      r.page = structuredClone(o.page);
      r.summary = summarize(o.page);
    }
  }

  async counts(id: string) {
    const c = zero();
    for (const r of this.rows.get(id)?.values() ?? []) c[r.state]++;
    return c;
  }

  async urls(id: string, f: UrlFilter = {}) {
    const only = f.urls ? new Set(f.urls) : null;
    const list = [...(this.rows.get(id)?.values() ?? [])]
      .filter(
        (r) =>
          (!f.states || f.states.includes(r.state)) &&
          (!f.prefix || r.url.startsWith(f.prefix)) &&
          (!only || only.has(r.url)),
      )
      .sort((a, b) => a.seq - b.seq);
    const start = f.offset ?? 0;
    return list.slice(start, f.limit === undefined ? undefined : start + f.limit).map(view);
  }

  async page(id: string, url: string) {
    const r = this.rows.get(id)?.get(url);
    return r ? { url: view(r), page: r.page ? structuredClone(r.page) : null } : null;
  }
}

const view = (r: Row): CrawlUrl => ({
  url: r.url,
  state: r.state,
  depth: r.depth,
  source: r.source,
  lastmod: r.lastmod,
  attempts: r.attempts,
  reason: r.reason,
  summary: r.summary ? structuredClone(r.summary) : null,
});

export { zero as emptyCounts };
