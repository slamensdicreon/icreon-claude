import { randomUUID } from 'node:crypto';
import type { GuardedBrowser } from '../guarded';
import { loadPage, OfflineParser, RENDERED_SIZE, safeCanonical, sizeOf } from '../page-load';
import { assertNavigable, BlockedUrlError, type UrlPolicy } from '../ssrf';
import { fetchPage } from './http';
import { Pacer } from './pacer';
import { ALLOW_ALL, type Robots } from './robots';
import { discover, onOrigin, readRobots, type SitemapEntry } from './sitemap';
import {
  emptyStats,
  type CrawlJob,
  type CrawlOptions,
  type CrawlStats,
  type CrawlStore,
  type CrawlUrl,
  type NewUrl,
  type StoredPage,
} from './store';
import { urlPattern } from './templates';

export interface CrawlerOptions {
  store: CrawlStore;
  browser: GuardedBrowser;
  /** Source-site hosts per project, read again whenever a crawl resumes. */
  policy: (projectId: string) => UrlPolicy;
  settleMs?: number;
  navigationTimeoutMs?: number;
  /** URLs claimed from the store at a time (default 50). */
  batchSize?: number;
  /**
   * URLs read in one offline browser context before it is replaced (default 1,000), so a long
   * crawl doesn't run on one context for hours, and a Chromium restart costs one segment.
   */
  segmentSize?: number;
  /** Pages read in a real browser at once, across a crawl (default 2): they cost the most. */
  renderConcurrency?: number;
  /** How long a crawl's lease lasts without renewal (default 60 s). */
  leaseMs?: number;
  defaults?: Partial<CrawlOptions>;
  /** A finished crawl younger than this is returned instead of starting another (default 24 h). */
  reuseWithinMs?: number;
  /** Replaceable in tests. */
  fetch?: typeof fetch;
  log?: (msg: string, err?: unknown) => void;
}

export interface StartArgs {
  url: string;
  maxPages?: number;
  concurrency?: number;
  respectRobots?: boolean;
  /** Start a new crawl even when a recent one of the site exists. */
  fresh?: boolean;
  /** With fresh: keep the pages of the last crawl whose sitemap lastmod hasn't changed. */
  changedOnly?: boolean;
}

export const CRAWL_DEFAULTS: CrawlOptions = {
  maxPages: 5_000,
  maxDepth: 12,
  concurrency: 6,
  respectRobots: true,
  maxRunMs: 3 * 60 * 60_000,
  reuseFrom: null,
};

/** Hard ceilings, whatever an agent asks for. */
export const CRAWL_LIMITS = { maxPages: 25_000, concurrency: 16 };

const FILE =
  /\.(pdf|zip|docx?|xlsx?|pptx?|jpe?g|png|gif|svg|webp|avif|ico|mp4|webm|mov|mp3|wav|css|js|json|xml|txt|rss|atom|ics|woff2?|ttf|eot)$/i;
const TRACKING = /^(utm_[a-z]+|gclid|fbclid|msclkid|mc_[a-z]+|_hs[a-z]+|hsa_[a-z]+|ref|trk|cmp)$/i;
/** Query-string versions of one path a crawl follows (filters and sorts multiply them). */
const QUERY_VARIANTS = 5;

/** A link without tracking parameters, so one page isn't read once per campaign. */
export function cleanLink(raw: string): string | null {
  const c = safeCanonical(raw);
  if (!c) return null;
  const u = new URL(c);
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.search = u.searchParams.toString() ? `?${u.searchParams.toString()}` : '';
  return u.toString();
}

/**
 * Sitemap URLs in an order that shows every kind of page early: round-robin across sections
 * (`/resources/learn/*`, `/products/*`, ...) instead of 800 articles first. Templates then appear
 * in the first minutes of a crawl, and agents can start on them while the rest is read.
 */
export function interleave(entries: SitemapEntry[]): SitemapEntry[] {
  const groups = new Map<string, SitemapEntry[]>();
  for (const e of entries) {
    const k = urlPattern(e.url);
    const g = groups.get(k) ?? [];
    g.push(e);
    groups.set(k, g);
  }
  const lists = [...groups.values()];
  const out: SitemapEntry[] = [];
  for (let i = 0; out.length < entries.length; i++)
    for (const l of lists) if (i < l.length) out.push(l[i]!);
  return out;
}

/** One crawl in progress in this process: what it has found and how fast it may go. */
interface Run {
  job: CrawlJob;
  policy: UrlPolicy;
  robots: Robots;
  pacer: Pacer;
  stats: CrawlStats;
  known: Set<string>;
  variants: Map<string, number>;
  /** The site's spelling of paths: with a trailing slash, learnt from its redirects. */
  trailingSlash: boolean;
  lost: boolean;
  /** When the store was last asked whether the crawl should go on. */
  checked: number;
  /**
   * Per URL pattern, whether reading its pages in a browser adds anything: true once it has,
   * false after three tries that didn't (short pages that are complete as served).
   */
  rendering: Map<string, boolean | number>;
  /** URLs found past maxPages in this run. */
  dropped: Set<string>;
}

/** An empty app container, as single-page apps serve their pages. */
const SHELL =
  /<(div|main|section)\b[^>]*\bid=["'](root|app|__next|__nuxt|___gatsby|main-app)["'][^>]*>\s*<\/\1>/i;

/**
 * Whether a page as served looks built by scripts: an empty app container, or almost no words
 * and no images. A short page that is complete as served (a glossary term, a contact page) is
 * read as it is; the crawl learns per section when a browser adds nothing.
 */
export function needsBrowser(p: { wordCount: number; images: unknown[] }, html: string): boolean {
  if (sizeOf(p) >= RENDERED_SIZE) return false;
  return SHELL.test(html) || (p.wordCount < 30 && p.images.length === 0);
}

function learn(run: Run, pattern: string, better: boolean) {
  const seen = run.rendering.get(pattern);
  if (seen === true || seen === false) return;
  if (better) run.rendering.set(pattern, true);
  else run.rendering.set(pattern, (seen ?? 0) + 1 >= 3 ? false : (seen ?? 0) + 1);
}

/**
 * The URL as the site spells it. Pages are kept without a trailing slash (one page, one
 * spelling), but a site that serves `/about/` redirects `/about` there: asking for its own
 * spelling saves a redirect on every page.
 */
function spelled(url: string, trailingSlash: boolean): string {
  if (!trailingSlash) return url;
  const u = new URL(url);
  if (u.pathname.endsWith('/') || /\.[a-z0-9]{2,5}$/i.test(u.pathname)) return url;
  u.pathname += '/';
  return u.toString();
}

/**
 * Crawls in the background: a crawl is a job, not one tool call, so a site of any size is read in
 * full however long it takes, and the agent reads its progress and pages as they come in.
 *
 * Pages are read over plain HTTP, several at once at the pace the site allows, and parsed in an
 * offline browser context (scripts off, nothing fetched): the same extract a browser makes, in a
 * few milliseconds. A page that comes back nearly empty (built by scripts) or refused to a plain
 * client is read again in a real browser. Everything found goes to the store; a crawl survives a
 * restart, and a worker resumes a crawl whose worker died once its lease runs out.
 */
export class Crawler {
  readonly owner = `crawler-${randomUUID().slice(0, 8)}`;
  private readonly active = new Map<string, Promise<void>>();
  private readonly finished = new Map<string, Set<() => void>>();
  private readonly render: Pacer;
  private closing = false;

  constructor(private readonly opts: CrawlerOptions) {
    this.render = new Pacer(opts.renderConcurrency ?? 2);
  }

  get store(): CrawlStore {
    return this.opts.store;
  }

  /**
   * Starts a crawl of the site, or returns the one already covering it: still running, or
   * finished within the last day (unless `fresh`).
   */
  async start(
    projectId: string,
    args: StartArgs,
  ): Promise<{ job: CrawlJob; existing: 'running' | 'recent' | null }> {
    const policy = this.opts.policy(projectId);
    const start = (await assertNavigable(args.url, policy)).toString();
    const bare = (u: string) => new URL(u).hostname.toLowerCase().replace(/^www\./, '');
    const last = await this.opts.store.latest(projectId);
    const same = last && bare(last.origin) === bare(start) ? last : null;
    if (same?.status === 'running') {
      this.ensure(same);
      return { job: same, existing: 'running' };
    }
    const fresh =
      same?.status === 'done' &&
      Date.now() - Date.parse(same.finishedAt ?? same.updatedAt) <
        (this.opts.reuseWithinMs ?? 24 * 60 * 60_000);
    if (same && fresh && !args.fresh) return { job: same, existing: 'recent' };

    const d = { ...CRAWL_DEFAULTS, ...this.opts.defaults };
    const options: CrawlOptions = {
      ...d,
      maxPages: clamp(args.maxPages ?? d.maxPages, 1, CRAWL_LIMITS.maxPages),
      concurrency: clamp(args.concurrency ?? d.concurrency, 1, CRAWL_LIMITS.concurrency),
      respectRobots: args.respectRobots ?? d.respectRobots,
      reuseFrom: args.changedOnly && same?.status === 'done' ? same.id : null,
    };
    const now = new Date().toISOString();
    const job: CrawlJob = {
      id: `crawl-${randomUUID().slice(0, 8)}`,
      projectId,
      origin: new URL(start).origin,
      startUrl: safeCanonical(start) ?? start,
      status: 'running',
      options,
      stats: emptyStats(),
      sitemapUrls: -1,
      message: null,
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    await this.opts.store.create(job);
    this.ensure(job);
    return { job, existing: null };
  }

  /** Resumes every running crawl no live worker holds (call on start). */
  async resumeAll(): Promise<number> {
    const jobs = await this.opts.store.running();
    for (const j of jobs) this.ensure(j);
    return jobs.length;
  }

  /**
   * The crawl once it finishes or `ms` pass, whichever is first. A running crawl no worker holds
   * (its worker died) is picked up here.
   */
  async wait(id: string, ms: number): Promise<CrawlJob | null> {
    const deadline = Date.now() + Math.max(0, ms);
    for (;;) {
      const job = await this.opts.store.get(id);
      if (!job || job.status !== 'running') return job;
      this.ensure(job);
      const left = deadline - Date.now();
      if (left <= 0) return job;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(left, this.active.has(id) ? left : 2_000));
        const set = this.finished.get(id) ?? new Set();
        set.add(done);
        this.finished.set(id, set);
        function done() {
          clearTimeout(timer);
          set.delete(done);
          resolve();
        }
      });
    }
  }

  /** Stops a crawl, keeping what it has read. */
  async stop(id: string, why = 'Stopped when asked.'): Promise<CrawlJob | null> {
    const job = await this.opts.store.get(id);
    if (job?.status === 'running')
      await this.opts.store.update(id, {
        status: 'stopped',
        message: why,
        finishedAt: new Date().toISOString(),
      });
    await this.active.get(id)?.catch(() => {});
    return this.opts.store.get(id);
  }

  /**
   * For a worker shutting down: stops reading, puts claimed URLs back and lets go of its crawls,
   * which stay running for the next worker to resume (at once: the leases are released).
   */
  async shutdown(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.active.values()]);
  }

  private ensure(job: CrawlJob): void {
    if (this.active.has(job.id) || this.closing) return;
    const run = this.run(job.id)
      .catch((err: unknown) => this.log(`Crawl ${job.id} failed`, err))
      .finally(() => {
        this.active.delete(job.id);
        for (const f of this.finished.get(job.id) ?? []) f();
      });
    this.active.set(job.id, run);
  }

  private log(msg: string, err?: unknown) {
    (this.opts.log ?? ((m, e) => console.error(m, e ?? '')))(msg, err);
  }

  private async run(id: string): Promise<void> {
    const store = this.opts.store;
    const leaseMs = this.opts.leaseMs ?? 60_000;
    if (!(await store.lease(id, this.owner, leaseMs))) return;
    let job = await store.get(id);
    if (!job || job.status !== 'running') {
      await store.release(id, this.owner);
      return;
    }
    const run: Run = {
      job,
      policy: this.opts.policy(job.projectId),
      robots: ALLOW_ALL,
      pacer: new Pacer(job.options.concurrency),
      stats: { ...emptyStats(), ...job.stats },
      known: new Set(),
      variants: new Map(),
      trailingSlash: false,
      lost: false,
      checked: 0,
      rendering: new Map(),
      dropped: new Set(),
    };
    const heartbeat = setInterval(() => {
      store
        .lease(id, this.owner, leaseMs)
        .then((held) => {
          if (!held) run.lost = true;
        })
        .catch(() => {});
    }, leaseMs / 3);
    try {
      if (job.sitemapUrls < 0) job = await this.seed(run);
      else run.robots = await readRobots(job.origin, run.policy, this.fetchOpts());
      run.job = job;
      if (run.robots.crawlDelay)
        // Crawl-delay honoured up to 2 s: one request at a time, spaced as asked.
        run.pacer = new Pacer(1, Math.min(2_000, run.robots.crawlDelay * 1000));
      for (const u of await store.urls(id)) run.known.add(u.url);
      await store.requeue(id);
      await this.read(run);
    } catch (err) {
      await store.update(id, {
        status: 'failed',
        stats: run.stats,
        message: `The crawl failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
        finishedAt: new Date().toISOString(),
      });
      throw err;
    } finally {
      clearInterval(heartbeat);
      await store.release(id, this.owner).catch(() => {});
    }
  }

  /** Discovery: the real origin, robots.txt, the sitemaps; then the first URLs queued. */
  private async seed(run: Run): Promise<CrawlJob> {
    const store = this.opts.store;
    const { job } = run;
    const d = await discover(job.startUrl, run.policy, this.fetchOpts());
    run.robots = d.robots;
    const entries = interleave(d.entries);
    if (job.options.reuseFrom) {
      const withDates = entries.filter((e): e is { url: string; lastmod: string } => !!e.lastmod);
      const kept = await store.reuse(job.options.reuseFrom, job.id, withDates);
      run.stats.reused += kept.length;
      for (const u of kept) run.known.add(u);
    }
    const seeds: NewUrl[] = [
      {
        url: d.start,
        depth: 0,
        source: 'start',
        // The sitemap's date for it too, so a changed-only re-crawl can keep it.
        lastmod: d.entries.find((e) => e.url === d.start)?.lastmod ?? null,
      },
      ...entries.map((e) => ({
        url: e.url,
        depth: 1,
        source: 'sitemap' as const,
        lastmod: e.lastmod,
      })),
    ];
    const updated = { ...job, origin: d.origin, startUrl: d.start, sitemapUrls: d.entries.length };
    run.job = updated;
    await this.queue(run, seeds);
    // Pages kept from the last crawl aren't read again, but what they link to still is.
    if (run.stats.reused) {
      const links: NewUrl[] = [];
      for (const u of await store.urls(job.id, { states: ['done'] })) {
        const kept = await store.page(job.id, u.url);
        for (const raw of kept?.page?.links ?? []) {
          const c = onOrigin(cleanLink(raw), d.origin);
          if (c && !run.known.has(c))
            links.push({ url: c, depth: u.depth + 1, source: 'link', lastmod: null });
        }
      }
      await this.queue(run, links);
    }
    run.stats.readingSince = new Date().toISOString();
    await store.update(job.id, {
      origin: d.origin,
      startUrl: d.start,
      sitemapUrls: d.entries.length,
      stats: run.stats,
    });
    return updated;
  }

  /** Queues the URLs a crawl should read: on the origin, allowed, new, and within maxPages. */
  private async queue(run: Run, urls: NewUrl[]): Promise<void> {
    const { job } = run;
    const fresh: NewUrl[] = [];
    const disallowed: NewUrl[] = [];
    for (const u of urls) {
      if (run.known.has(u.url)) continue;
      const url = new URL(u.url);
      if (FILE.test(url.pathname) || u.depth > job.options.maxDepth) continue;
      if (url.search) {
        const path = url.origin + url.pathname;
        const n = run.variants.get(path) ?? 0;
        if (n >= QUERY_VARIANTS) continue;
        run.variants.set(path, n + 1);
      }
      if (run.known.size + fresh.length + disallowed.length >= job.options.maxPages) {
        // Counted once per URL, however many pages link to it.
        if (!run.dropped.has(u.url) && run.dropped.size < 100_000) {
          run.dropped.add(u.url);
          run.stats.dropped++;
        }
        continue;
      }
      if (job.options.respectRobots && !run.robots.allows(url.pathname + url.search)) {
        disallowed.push(u);
        continue;
      }
      fresh.push(u);
    }
    for (const u of [...fresh, ...disallowed]) run.known.add(u.url);
    if (fresh.length) await this.opts.store.enqueue(job.id, fresh);
    if (disallowed.length) {
      await this.opts.store.enqueue(job.id, disallowed);
      for (const u of disallowed)
        await this.opts.store.finish(job.id, u.url, {
          state: 'excluded',
          reason: 'disallowed by robots.txt',
        });
      run.stats.robots += disallowed.length;
    }
  }

  /** Reads queued URLs until none are left, time runs out, or it's stopped. */
  private async read(run: Run): Promise<void> {
    const store = this.opts.store;
    const id = run.job.id;
    for (;;) {
      const outcome = await this.opts.browser.withContext(
        run.policy,
        (offline) => this.segment(run, new OfflineParser(offline)),
        { offline: true },
      );
      await store.update(id, { stats: run.stats });
      if (outcome === 'halt') return;
      if (outcome === 'empty') {
        const c = await store.counts(id);
        if (!c.queued) break;
      }
    }
    const c = await store.counts(id);
    if (c.queued || c.inflight) return; // another worker is still reading its claims
    const refusedAll = c.done === 0 && run.stats.refused > 0;
    await store.update(id, {
      status: 'done',
      stats: run.stats,
      message: refusedAll
        ? `The site refused our browser on every page (${run.stats.refused} answered 401 or 403).`
        : null,
      finishedAt: new Date().toISOString(),
    });
  }

  /**
   * Whether to stop reading: another worker took the crawl, it was stopped, or its time ran out
   * (then it is marked stopped here). Reads the store at most every 2 seconds.
   */
  private async halted(run: Run): Promise<boolean> {
    if (run.lost || this.closing) return true;
    const now = Date.now();
    if (now - run.checked < 2_000) return false;
    run.checked = now;
    const store = this.opts.store;
    const current = await store.get(run.job.id);
    if (!current || current.status !== 'running') return true;
    if (now > Date.parse(run.job.startedAt) + run.job.options.maxRunMs) {
      const c = await store.counts(run.job.id);
      await store.update(run.job.id, {
        status: 'stopped',
        stats: run.stats,
        message: `Ran for its time limit (${Math.round(run.job.options.maxRunMs / 60_000)} minutes): ${c.done} pages read, ${c.queued + c.inflight} not yet read.`,
        finishedAt: new Date().toISOString(),
      });
      return true;
    }
    return false;
  }

  /**
   * Up to segmentSize URLs through one offline context: workers each take the next URL as soon
   * as they finish one (no waiting for the slowest page of a batch), and the store is asked for
   * more before the buffer runs dry. URLs claimed but not read when it halts are put back.
   */
  private async segment(run: Run, parser: OfflineParser): Promise<'empty' | 'more' | 'halt'> {
    const store = this.opts.store;
    const id = run.job.id;
    const budget = this.opts.segmentSize ?? 1_000;
    const buffer: CrawlUrl[] = [];
    let taken = 0;
    let active = 0;
    let exhausted = false;
    let halt = false;
    let refilling: Promise<void> | null = null;
    const refill = async () => {
      if (await this.halted(run)) {
        halt = true;
        return;
      }
      const got = await store.claim(id, Math.min(this.opts.batchSize ?? 50, budget - taken));
      taken += got.length;
      buffer.push(...got);
      // Nothing queued: done, unless pages still being read add links.
      if (!got.length) {
        if (active) await new Promise((r) => setTimeout(r, 100));
        else exhausted = true;
      }
    };
    const next = async (): Promise<CrawlUrl | null> => {
      for (;;) {
        if (halt) return null;
        if (buffer.length) {
          // Ask for more before the last few are taken.
          if (buffer.length < 10 && !refilling && !exhausted && taken < budget)
            refilling = refill().finally(() => (refilling = null));
          return buffer.shift()!;
        }
        if (exhausted || taken >= budget) return null;
        refilling ??= refill().finally(() => (refilling = null));
        await refilling;
      }
    };
    const workers = Math.min(32, run.job.options.concurrency * 2 + 2);
    await Promise.all(
      Array.from({ length: workers }, async () => {
        for (let u = await next(); u; u = await next()) {
          active++;
          try {
            await this.readOne(run, parser, u);
          } finally {
            active--;
          }
        }
      }),
    );
    await refilling;
    if (buffer.length) await store.requeue(id);
    return halt ? 'halt' : exhausted ? 'empty' : 'more';
  }

  /** One URL: fetched over HTTP, parsed offline, read in a browser when it has to be. */
  private async readOne(run: Run, parser: OfflineParser, u: CrawlUrl): Promise<void> {
    const store = this.opts.store;
    const { job, policy, pacer, stats } = run;
    const attempts = u.attempts + 1;
    try {
      const get = (url: string) =>
        pacer.run(() =>
          fetchPage(url, policy, {
            ...this.fetchOpts(),
            timeoutMs: this.opts.navigationTimeoutMs,
          }),
        );
      const asked = spelled(u.url, run.trailingSlash);
      let f = await get(asked);
      // Not every path takes the site's usual spelling (`/old-page` may only exist bare).
      if (f.status === 404 && asked !== u.url) f = await get(u.url);
      if (
        f.redirect &&
        new URL(f.finalUrl).pathname.endsWith('/') &&
        safeCanonical(f.finalUrl) === u.url
      )
        run.trailingSlash = true;
      if (f.status === 429 || f.status === 503) {
        stats.throttled++;
        pacer.throttled(f.retryAfterMs);
        return await store.finish(job.id, u.url, {
          state: attempts < 4 ? 'queued' : 'failed',
          attempts,
          reason: `HTTP ${f.status}${attempts < 4 ? '' : ': the site kept asking us to slow down'}`,
        });
      }
      const landed = safeCanonical(f.finalUrl);
      if (f.redirect && landed && landed !== u.url) {
        const target = onOrigin(landed, job.origin);
        await store.finish(job.id, u.url, {
          state: 'excluded',
          reason: `redirects (${f.redirect.status}) to ${target ? new URL(target).pathname + new URL(target).search : landed}`,
        });
        if (target)
          await this.queue(run, [
            { url: target, depth: u.depth, source: 'redirect', lastmod: null },
          ]);
        return;
      }
      let page: StoredPage | null = null;
      if (f.status === 401 || f.status === 403) {
        // Bot protection often turns away plain clients only: ask a real browser.
        page = await this.rendered(run, u.url);
        if (!page || page.status >= 400) {
          stats.refused++;
          return await store.finish(job.id, u.url, {
            state: 'excluded',
            reason: `HTTP ${page?.status ?? f.status}`,
            attempts,
          });
        }
      } else if (f.status >= 400) {
        return await store.finish(job.id, u.url, {
          state: 'excluded',
          reason: `HTTP ${f.status}`,
          attempts,
        });
      } else if (!/html/i.test(f.contentType)) {
        return await store.finish(job.id, u.url, {
          state: 'excluded',
          reason: `not a page (${f.contentType.split(';')[0] || 'no content type'})`,
          attempts,
        });
      } else {
        const extract = await parser.parse(f.body, f.finalUrl);
        page = { url: u.url, status: f.status, via: 'http', ...extract };
        const pattern = urlPattern(u.url);
        if (needsBrowser(extract, f.body) && run.rendering.get(pattern) !== false) {
          // Built in the browser, by the look of it: read it there.
          const r = await this.rendered(run, u.url);
          const better = !!r && r.status < 400 && sizeOf(r) > sizeOf(extract) * 1.2 + 10;
          if (better) page = r;
          learn(run, pattern, better);
        }
      }
      if (page.via === 'browser') stats.rendered++;
      else stats.http++;
      pacer.succeeded();
      await store.finish(job.id, u.url, { state: 'done', page, attempts });
      const links: NewUrl[] = [];
      for (const raw of page.links) {
        const c = onOrigin(cleanLink(raw), job.origin);
        if (c) links.push({ url: c, depth: u.depth + 1, source: 'link', lastmod: null });
      }
      await this.queue(run, links);
    } catch (err) {
      const reason = err instanceof Error ? err.message.split('\n')[0]! : String(err);
      // A URL the project may not visit (a redirect off the site) is the site's answer.
      if (err instanceof BlockedUrlError)
        return await store.finish(job.id, u.url, { state: 'excluded', reason, attempts });
      await store.finish(job.id, u.url, {
        state: attempts < 3 ? 'queued' : 'failed',
        reason,
        attempts,
      });
    }
  }

  /** The page read in a real browser (scripts run, the page settles), or null if it failed. */
  private async rendered(run: Run, url: string): Promise<StoredPage | null> {
    try {
      return await this.render.run(() =>
        this.opts.browser.withContext(run.policy, async (context) => {
          const r = await loadPage(context, run.policy, url, {
            settleMs: this.opts.settleMs,
            navigationTimeoutMs: this.opts.navigationTimeoutMs,
          });
          if (!r.page) return null;
          const { url: _final, ...extract } = r.page;
          return { ...extract, url, status: r.status, via: 'browser' as const };
        }),
      );
    } catch {
      return null;
    }
  }

  private fetchOpts() {
    return this.opts.fetch ? { fetch: this.opts.fetch } : {};
  }
}

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, Math.floor(Number.isFinite(n) ? n : lo)));
