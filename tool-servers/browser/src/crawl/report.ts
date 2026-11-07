import type { CrawlJob, CrawlStore, CrawlUrl, UrlState } from './store';
import { groupTemplates, type Grouping } from './templates';

/**
 * What agents read of a crawl. Every answer is bounded, whatever the site's size: progress and
 * templates in crawl.status, pages a page of rows at a time in crawl.query, one page's extract in
 * crawl.page. Nothing here lists every page at once.
 */

interface Cached {
  done: number;
  grouping: Grouping;
  regions: { region: string; text: string; pages: number }[];
  pages: CrawlUrl[];
}

/** Templates are regrouped when the pages read have grown by this share (or the crawl ended). */
const REGROUP = 0.02;

export class CrawlReports {
  private readonly cache = new Map<string, Cached>();

  constructor(private readonly store: CrawlStore) {}

  /** The pages read so far, their templates and repeated regions, regrouped as pages arrive. */
  async grouping(job: CrawlJob): Promise<Cached> {
    const c = await this.store.counts(job.id);
    const hit = this.cache.get(job.id);
    const settled = job.status !== 'running';
    if (hit && (hit.done === c.done || (!settled && c.done - hit.done < hit.done * REGROUP)))
      return hit;
    const pages = (await this.store.urls(job.id, { states: ['done'] })).filter((p) => p.summary);
    const grouping = groupTemplates(
      pages.map((p) => ({
        url: p.url,
        words: p.summary!.words,
        layout: p.summary!.layout,
        title: p.summary!.title,
      })),
    );
    // Regions (header, nav, footer) on at least half the pages: partial-design candidates.
    const counts = new Map<string, { region: string; text: string; pages: number }>();
    for (const p of pages)
      for (const [region, r] of Object.entries(p.summary!.regions ?? {})) {
        if (!r) continue;
        const k = `${region}:${r.hash}`;
        const e = counts.get(k) ?? { region, text: r.text, pages: 0 };
        e.pages++;
        counts.set(k, e);
      }
    const regions = [...counts.values()].filter(
      (r) => pages.length > 1 && r.pages >= pages.length / 2,
    );
    const out = { done: c.done, grouping, regions, pages };
    this.cache.set(job.id, out);
    return out;
  }

  /** crawl.status: progress, pace, what was left out and why, and the templates so far. */
  async status(job: CrawlJob) {
    const c = await this.store.counts(job.id);
    const g = await this.grouping(job);
    const found = Object.values(c).reduce((a, b) => a + b, 0);
    const left = c.queued + c.inflight;
    const since = job.stats.readingSince ? Date.parse(job.stats.readingSince) : null;
    const end = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
    const minutes = since ? Math.max((end - since) / 60_000, 1 / 60) : null;
    const readHere = c.done - job.stats.reused;
    const perMinute = minutes ? Math.round((readHere / minutes) * 10) / 10 : null;
    const etaMinutes =
      job.status === 'running' && perMinute && left ? Math.ceil(left / perMinute) : null;

    const excluded = await this.store.urls(job.id, { states: ['excluded', 'failed'] });
    const reasons = new Map<string, { reason: string; count: number; examples: string[] }>();
    const redirects: { from: string; to: string }[] = [];
    for (const u of excluded) {
      const m = /^redirects \((\d+)\) to (.+)$/.exec(u.reason ?? '');
      if (m) {
        if (redirects.length < 50) redirects.push({ from: pathOf(u.url), to: m[2]! });
        continue;
      }
      const key = (u.reason ?? 'unknown').replace(/^(HTTP \d+).*$/, '$1');
      const e = reasons.get(key) ?? { reason: key, count: 0, examples: [] };
      e.count++;
      if (e.examples.length < 3) e.examples.push(pathOf(u.url));
      reasons.set(key, e);
    }
    const redirectCount = excluded.filter((u) => u.reason?.startsWith('redirects (')).length;
    const truncated = job.stats.dropped > 0;

    const body = {
      crawlId: job.id,
      status: job.status,
      origin: job.origin,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      progress: {
        found,
        read: c.done,
        queued: left,
        excluded: c.excluded,
        failed: c.failed,
        sitemapUrls: Math.max(0, job.sitemapUrls),
        perMinute,
        etaMinutes,
      },
      how: {
        http: job.stats.http,
        rendered: job.stats.rendered,
        reused: job.stats.reused,
        throttled: job.stats.throttled,
        refused: job.stats.refused,
      },
      limits: {
        maxPages: job.options.maxPages,
        truncated,
        dropped: job.stats.dropped,
        respectRobots: job.options.respectRobots,
      },
      templates: g.grouping.templates.slice(0, 40),
      ...(g.grouping.templates.length > 40
        ? { moreTemplates: g.grouping.templates.length - 40 }
        : {}),
      repeatedRegions: g.regions,
      redirects: { count: redirectCount, first: redirects },
      excluded: [...reasons.values()].sort((a, b) => b.count - a.count),
      ...(job.message ? { message: job.message } : {}),
    };
    return { body, summary: statusLine(job, body) };
  }

  /** crawl.query: a page of rows, by template, path, state or words in the title. */
  async query(
    job: CrawlJob,
    q: {
      template?: string;
      path?: string;
      state?: UrlState | 'read';
      text?: string;
      limit?: number;
      offset?: number;
    },
  ) {
    const limit = Math.min(Math.max(1, q.limit ?? 100), 200);
    const offset = Math.max(0, q.offset ?? 0);
    const g = await this.grouping(job);
    const state: UrlState = q.state === 'read' || !q.state ? 'done' : q.state;
    let rows: CrawlUrl[] =
      state === 'done' ? g.pages : await this.store.urls(job.id, { states: [state] });
    if (q.template) {
      const t = q.template;
      rows = rows.filter((r) => g.grouping.templateOf.get(r.url) === t);
    }
    if (q.path) {
      const prefix = q.path.startsWith('http')
        ? q.path
        : `${job.origin}${q.path.startsWith('/') ? '' : '/'}${q.path}`;
      rows = rows.filter((r) => r.url.startsWith(prefix));
    }
    if (q.text) {
      const needle = q.text.toLowerCase();
      rows = rows.filter((r) =>
        `${r.summary?.title ?? ''} ${r.summary?.h1 ?? ''} ${r.url}`.toLowerCase().includes(needle),
      );
    }
    const page = rows.slice(offset, offset + limit).map((r) => ({
      url: r.url,
      path: pathOf(r.url),
      ...(r.summary
        ? {
            title: r.summary.title,
            description: r.summary.description,
            h1: r.summary.h1,
            lang: r.summary.lang,
            words: r.summary.words,
            images: r.summary.images,
            template: g.grouping.templateOf.get(r.url) ?? null,
          }
        : {}),
      ...(r.reason ? { reason: r.reason } : {}),
      ...(r.lastmod ? { lastmod: r.lastmod } : {}),
    }));
    const next = offset + page.length < rows.length ? offset + page.length : null;
    return {
      body: { crawlId: job.id, status: job.status, total: rows.length, offset, next, pages: page },
      summary: `${rows.length} ${state === 'done' ? 'pages read' : `URLs ${state}`}${
        q.template ? ` in template ${q.template}` : ''
      }${q.path ? ` under ${q.path}` : ''}${q.text ? ` matching "${q.text}"` : ''}; rows ${offset + 1}-${offset + page.length}${next !== null ? `, next offset ${next}` : ''}`,
    };
  }

  invalidate(id: string) {
    this.cache.delete(id);
  }
}

const pathOf = (u: string) => {
  const x = new URL(u);
  return x.pathname + x.search;
};

interface StatusBody {
  progress: {
    found: number;
    read: number;
    excluded: number;
    failed: number;
    perMinute: number | null;
    etaMinutes: number | null;
  };
  how: { http: number; rendered: number; reused: number; throttled: number; refused: number };
  limits: { truncated: boolean; maxPages: number; dropped: number };
  templates: unknown[];
  moreTemplates?: number;
  repeatedRegions: unknown[];
  redirects: { count: number };
}

function statusLine(job: CrawlJob, b: StatusBody): string {
  const p = b.progress;
  const t = b.templates.length + (b.moreTemplates ?? 0);
  const head = `Crawl ${job.id} of ${job.origin}`;
  const throttled = b.how.throttled
    ? `. The site is throttling us (${b.how.throttled} "too many requests" answers): the crawl slowed to its pace`
    : '';
  const refused = b.how.refused
    ? `. The site refused ${b.how.refused} pages (401/403, also to a real browser): list them as not read, they aren't an access problem of ours`
    : '';
  const big =
    p.found >= 400
      ? `. A large site (${p.found} URLs found): work from the templates and crawl.query, not page by page`
      : '';
  if (job.status === 'running')
    return `${head}: running, ${p.read} of ${p.found} URLs read${p.perMinute ? ` (${p.perMinute}/min${p.etaMinutes ? `, about ${p.etaMinutes} min left` : ''})` : ''}; ${t} templates so far${throttled}${refused}${big}`;
  if (job.status === 'done' && p.read === 0 && b.how.refused)
    return `${head} found no page it could read: ${job.message ?? 'the site refused our browser'}. That is the site's bot protection, not our access, and retrying won't change it. Stop and submit needs_decision for the Director: the client allows our crawler, or gives the source repository, or the project uses another site`;
  const how = `${b.how.http} read directly, ${b.how.rendered} in a browser${b.how.reused ? `, ${b.how.reused} unchanged since the last crawl` : ''}`;
  const cut = b.limits.truncated
    ? `. Stopped at maxPages (${b.limits.maxPages}): ${b.limits.dropped} more URLs were found and not read; the inventory is partial`
    : '';
  return `${head}: ${job.status}, ${p.read} pages read (${how}), ${p.excluded + p.failed} excluded, ${b.redirects.count} redirects, ${t} templates, ${b.repeatedRegions.length} repeated regions${job.message ? `. ${job.message}` : ''}${cut}${throttled}${refused}${big}`;
}
