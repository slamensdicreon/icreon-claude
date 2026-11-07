import { PGlite } from '@electric-sql/pglite';
import { migrate } from '@lw/events';
import { MemoryBlobStore } from '@lw/tool-gateway';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BrowserToolServer,
  Crawler,
  GuardedBrowser,
  groupTemplates,
  MemoryCrawlStore,
  Pacer,
  parseRobots,
  PostgresCrawlStore,
  urlPattern,
  type CrawlJob,
  type CrawlStore,
} from '../src';
import { cleanLink, interleave } from '../src/crawl/crawler';
import { onOrigin } from '../src/crawl/sitemap';
import { largeSite, type LargeSite } from './large-site';

const policy = () => ({ allowedHosts: ['127.0.0.1'], allowPrivateNetworks: true });
const ctx = { projectId: 'p1', token: 'unused', role: 'content-analyst', taskId: 't1' };

interface Status {
  crawlId: string;
  status: string;
  progress: {
    found: number;
    read: number;
    queued: number;
    excluded: number;
    sitemapUrls: number;
    perMinute: number | null;
  };
  how: { http: number; rendered: number; throttled: number; reused: number };
  limits: { truncated: boolean; dropped: number };
  templates: {
    id: string;
    pages: number;
    patterns: { pattern: string; pages: number }[];
    examples: string[];
    layout: string[];
  }[];
  repeatedRegions: { region: string; pages: number }[];
  redirects: { count: number; first: { from: string; to: string }[] };
  excluded: { reason: string; count: number; examples: string[] }[];
}

let guarded: GuardedBrowser;

beforeAll(() => {
  guarded = new GuardedBrowser({ allowPrivateNetworks: true });
});

afterAll(async () => {
  await guarded.close();
});

/** Waits for a crawl through crawl.status, as an agent would. */
async function finish(server: BrowserToolServer, crawlId: string): Promise<Status> {
  for (;;) {
    const r = await server.call('crawl.status', { crawlId, waitSeconds: 60 }, ctx);
    expect(r.code).toBe(200);
    const body = r.body as Status;
    if (body.status !== 'running') return body;
  }
}

describe('a large site, crawled in the background', () => {
  let site: LargeSite;
  let server: BrowserToolServer;
  let first: Status;
  let firstSummary = '';
  let seconds = 0;

  beforeAll(async () => {
    site = await largeSite({ throttleTimes: 2 });
    server = new BrowserToolServer({
      policy,
      blobs: new MemoryBlobStore(),
      browser: guarded,
      settleMs: 1_500,
    });
    const started = Date.now();
    const r = await server.call('crawl.start', { url: `${site.origin}/`, concurrency: 12 }, ctx);
    expect(r.code).toBe(202);
    const id = (r.body as { crawlId: string }).crawlId;
    first = await finish(server, id);
    seconds = (Date.now() - started) / 1000;
    firstSummary = (await server.call('crawl.status', { crawlId: id }, ctx)).summary ?? '';
  }, 300_000);

  afterAll(async () => {
    await server.close();
    await site.close();
  });

  it('reads every page the sitemaps list, quickly, without a browser for most', () => {
    // 2,980 sitemap pages, plus one only links reach (/company/app).
    expect(first.status).toBe('done');
    expect(first.progress.sitemapUrls).toBe(site.listed.length);
    expect(first.progress.read).toBe(site.listed.length + 1);
    expect(first.how.http).toBeGreaterThanOrEqual(site.listed.length);
    // Far inside the 10-minute tool call the old crawl had to fit in, and it never had to.
    expect(seconds).toBeLessThan(240);
    console.log(`Crawled ${first.progress.read} pages in ${seconds.toFixed(1)} s`);
  });

  it('asks the site for its own spelling, not a redirect per page', () => {
    // Paths end in a slash here; the canonical form drops it. After the first redirect it asks
    // for /about/, not /about: about one request per page.
    expect(site.total()).toBeLessThan(site.listed.length * 1.05 + 50);
  });

  it('groups thousands of pages into a few templates, with examples to read', () => {
    const top = first.templates.slice(0, 3);
    expect(top.map((t) => t.id)).toEqual([
      'resources-learn',
      'resources-glossary',
      'products-capabilities',
    ]);
    expect(top.map((t) => t.pages)).toEqual([1200, 900, 880]);
    expect(top[0]!.patterns).toEqual([{ pattern: '/resources/learn/*', pages: 1200 }]);
    expect(top[0]!.examples.length).toBeGreaterThanOrEqual(2);
    expect(top[2]!.layout).toEqual([
      'section.product-hero',
      'section.feature-grid',
      'section.cta-band',
    ]);
    expect(first.templates.length).toBeLessThan(20);
    expect(first.repeatedRegions.map((r) => r.region).sort()).toEqual(['footer', 'header', 'nav']);
  });

  it('reads a page built by scripts in a real browser', () => {
    expect(first.how.rendered).toBeGreaterThanOrEqual(1);
  });

  it('slows down when throttled and still reads the page', async () => {
    expect(first.how.throttled).toBe(2);
    const r = await server.call('crawl.page', { url: `${site.origin}/company/careers` }, ctx);
    expect(r.code).toBe(200);
    expect(r.body).toMatchObject({ title: 'careers | Acme HR', via: 'http' });
  });

  it('records redirects, robots.txt exclusions, and drops tracking parameters', () => {
    expect(first.redirects.first).toContainEqual({ from: '/old-page', to: '/company/about' });
    expect(first.excluded).toContainEqual(
      expect.objectContaining({ reason: 'disallowed by robots.txt', count: 1 }),
    );
    expect(site.hits.get('/private/admin/') ?? 0).toBe(0);
    expect(first.limits.truncated).toBe(false);
  });

  it('says it all in one line', () => {
    expect(firstSummary).toMatch(
      /^Crawl crawl-\w+ of http:\/\/127\.0\.0\.1:\d+: done, \d+ pages read \(\d+ read directly, \d+ in a browser\), \d+ excluded, 1 redirects, \d+ templates, 3 repeated regions\. The site is throttling us/,
    );
    expect(firstSummary).toMatch(/A large site \(\d+ URLs found\): work from the templates/);
  });

  it('lists pages by template, a page of rows at a time', async () => {
    const r = await server.call(
      'crawl.query',
      { template: 'resources-glossary', limit: 200, offset: 0 },
      ctx,
    );
    const body = r.body as {
      total: number;
      next: number | null;
      pages: { path: string; title: string; template: string; words: number }[];
    };
    expect(body.total).toBe(900);
    expect(body.pages).toHaveLength(200);
    expect(body.next).toBe(200);
    expect(body.pages.every((p) => p.template === 'resources-glossary')).toBe(true);
    expect(body.pages[0]).toMatchObject({
      path: expect.stringMatching(/^\/resources\/glossary\/term-\d+$/),
      title: expect.stringMatching(/^Term \d+ \| Acme HR$/),
    });
    expect(JSON.stringify(r.body).length).toBeLessThan(80_000);
    const last = await server.call(
      'crawl.query',
      { template: 'resources-glossary', limit: 200, offset: 800 },
      ctx,
    );
    expect((last.body as { next: number | null }).next).toBeNull();

    const text = await server.call('crawl.query', { text: 'Capability 123' }, ctx);
    expect((text.body as { total: number }).total).toBe(1);
    const excluded = await server.call('crawl.query', { state: 'excluded' }, ctx);
    expect((excluded.body as { pages: { reason: string }[] }).pages.map((p) => p.reason)).toEqual(
      expect.arrayContaining(['disallowed by robots.txt', 'redirects (301) to /company/about']),
    );
  });

  it('hands back one page as read, without visiting the site again', async () => {
    const before = site.total();
    const r = await server.call(
      'crawl.page',
      { url: `${site.origin}/products/capabilities/cap-3/` },
      ctx,
    );
    expect(r.code).toBe(200);
    const page = r.body as {
      title: string;
      layout: string[];
      images: { alt: string }[];
      links: { internalCount: number };
    };
    expect(page.title).toBe('Capability 3 | Acme HR');
    expect(page.images[0]!.alt).toBe('Capability 3');
    expect(page.links.internalCount).toBeGreaterThan(3);
    expect(site.total()).toBe(before);
  });

  it('returns the recent crawl instead of crawling again, unless asked', async () => {
    const before = site.total();
    const again = await server.call('crawl.start', { url: `${site.origin}/` }, ctx);
    expect(again.code).toBe(200);
    expect(again.body).toMatchObject({ crawlId: first.crawlId, existing: 'recent' });
    expect(again.summary).toMatch(/was crawled \d+ minutes? ago .*fresh: true/);
    expect(site.total()).toBe(before);
  });

  it('re-crawls only what the sitemap says changed', async () => {
    site.touch('/resources/glossary/');
    const before = site.total();
    const r = await server.call(
      'crawl.start',
      { url: `${site.origin}/`, fresh: true, changedOnly: true, concurrency: 12 },
      ctx,
    );
    expect(r.code).toBe(202);
    const status = await finish(server, (r.body as { crawlId: string }).crawlId);
    expect(status.progress.read).toBe(first.progress.read);
    expect(status.how.reused).toBe(site.listed.length - 900);
    // The glossary and the pages no sitemap dates: a third of the requests, not all of them.
    expect(site.total() - before).toBeLessThan(1100);
  }, 120_000);
});

describe('limits and failures', () => {
  let site: LargeSite;
  beforeAll(async () => {
    site = await largeSite({ articles: 60, glossary: 30, capabilities: 30 });
  });
  afterAll(() => site.close());

  it('stops at maxPages and says the inventory is partial', async () => {
    const server = new BrowserToolServer({
      policy,
      blobs: new MemoryBlobStore(),
      browser: guarded,
    });
    const r = await server.call('crawl.start', { url: `${site.origin}/`, maxPages: 25 }, ctx);
    const status = await finish(server, (r.body as { crawlId: string }).crawlId);
    expect(status.progress.found).toBe(25);
    expect(status.limits).toMatchObject({ truncated: true });
    const line = (await server.call('crawl.status', {}, ctx)).summary;
    expect(line).toMatch(
      /Stopped at maxPages \(25\): \d+ more URLs were found and not read; the inventory is partial/,
    );
    await server.close();
  }, 60_000);

  it("keeps one project's crawls from another", async () => {
    const server = new BrowserToolServer({
      policy,
      blobs: new MemoryBlobStore(),
      browser: guarded,
    });
    const r = await server.call('crawl.start', { url: `${site.origin}/`, maxPages: 5 }, ctx);
    const id = (r.body as { crawlId: string }).crawlId;
    await finish(server, id);
    const other = await server.call('crawl.status', { crawlId: id }, { ...ctx, projectId: 'p2' });
    expect(other.code).toBe(404);
    expect((await server.call('crawl.query', {}, { ...ctx, projectId: 'p2' })).code).toBe(404);
    await server.close();
  }, 60_000);

  it('says when the site refuses our browser on every page', async () => {
    const { createServer } = await import('node:http');
    const walled = createServer((_req, res) =>
      res.writeHead(403, { 'content-type': 'text/html' }).end('<h1>Access denied</h1>'),
    );
    await new Promise<void>((r) => walled.listen(0, '127.0.0.1', r));
    const port = (walled.address() as { port: number }).port;
    const server = new BrowserToolServer({
      policy,
      blobs: new MemoryBlobStore(),
      browser: guarded,
    });
    try {
      const r = await server.call('crawl.start', { url: `http://127.0.0.1:${port}/` }, ctx);
      await finish(server, (r.body as { crawlId: string }).crawlId);
      const line = (await server.call('crawl.status', {}, ctx)).summary;
      expect(line).toMatch(
        /found no page it could read.*bot protection, not our access.*needs_decision/,
      );
    } finally {
      await server.close();
      await new Promise((r) => walled.close(r));
    }
  }, 60_000);

  it('resumes a crawl whose worker died, from where it was', async () => {
    const store = new MemoryCrawlStore();
    // A crawl a dead worker left: discovered, some pages read, some claimed and never finished.
    const now = new Date().toISOString();
    const job: CrawlJob = {
      id: 'crawl-dead',
      projectId: 'p1',
      origin: site.origin,
      startUrl: `${site.origin}/`,
      status: 'running',
      options: {
        maxPages: 1000,
        maxDepth: 12,
        concurrency: 4,
        respectRobots: true,
        maxRunMs: 3_600_000,
        reuseFrom: null,
      },
      stats: {
        http: 0,
        rendered: 0,
        reused: 0,
        throttled: 0,
        refused: 0,
        dropped: 0,
        robots: 0,
        readingSince: now,
      },
      sitemapUrls: 3,
      message: null,
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    await store.create(job);
    await store.enqueue(job.id, [
      { url: `${site.origin}/company/about`, depth: 1, source: 'sitemap', lastmod: null },
      { url: `${site.origin}/company/privacy`, depth: 1, source: 'sitemap', lastmod: null },
      { url: `${site.origin}/company/contact`, depth: 1, source: 'sitemap', lastmod: null },
    ]);
    expect(await store.claim(job.id, 2)).toHaveLength(2); // in flight when the worker died
    await store.lease(job.id, 'dead-worker', 1); // its lease runs out at once
    await new Promise((r) => setTimeout(r, 5));

    const crawler = new Crawler({ store, browser: guarded, policy });
    expect(await crawler.resumeAll()).toBe(1);
    const done = await crawler.wait(job.id, 60_000);
    expect(done?.status).toBe('done');
    const c = await store.counts(job.id);
    expect(c.inflight).toBe(0);
    expect(c.queued).toBe(0);
    // The three it had, and what their links led to.
    expect(c.done).toBeGreaterThan(3);
  }, 60_000);

  it('leaves a crawl another live worker holds alone', async () => {
    const store = new MemoryCrawlStore();
    const a = new Crawler({ store, browser: guarded, policy });
    const b = new Crawler({ store, browser: guarded, policy });
    const { job } = await a.start('p1', { url: `${site.origin}/`, maxPages: 40 });
    await b.resumeAll(); // a holds the lease
    await a.wait(job.id, 60_000);
    const c = await store.counts(job.id);
    expect(c.done + c.excluded).toBe(40);
  }, 60_000);
});

describe('pieces', () => {
  it('reads robots.txt the way major crawlers do', () => {
    const r = parseRobots(
      'User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nUser-agent: other\nDisallow: /private/\nAllow: /private/open$\nDisallow: /*?print=\nCrawl-delay: 3\nSitemap: https://x.example/s.xml\n',
    );
    expect(r.allows('/about')).toBe(true);
    expect(r.allows('/private/x')).toBe(false);
    expect(r.allows('/private/open')).toBe(true);
    expect(r.allows('/private/open/more')).toBe(false);
    expect(r.allows('/page?print=1')).toBe(false);
    expect(r.crawlDelay).toBe(3);
    expect(r.sitemaps).toEqual(['https://x.example/s.xml']);
    expect(parseRobots('User-agent: *\nDisallow:\n').allows('/x')).toBe(true);
  });

  it('knows a page by where it sits', () => {
    expect(urlPattern('https://x.com/')).toBe('/');
    expect(urlPattern('https://x.com/about')).toBe('/about');
    expect(urlPattern('https://x.com/blog/2024/05/post')).toBe('/blog/*/*/*');
    expect(urlPattern('https://x.com/resources/learn/what-is-payroll')).toBe('/resources/learn/*');
  });

  it('splits one parent by layout, and merges parents built alike', () => {
    const page = (url: string, layout: string[]) => ({ url, words: 100, layout });
    const article = ['section.hero', 'article.body', 'aside.related'];
    const listing = ['section.listing', 'div.cards', 'nav.pager'];
    const product = ['section.product-hero', 'section.features', 'section.cta'];
    const { templates, templateOf } = groupTemplates([
      ...Array.from({ length: 6 }, (_, i) => page(`https://x.com/blog/post-${i}`, article)),
      page('https://x.com/blog/page-2', listing),
      page('https://x.com/blog/page-3', listing),
      ...Array.from({ length: 3 }, (_, i) => page(`https://x.com/products/hr/p${i}`, product)),
      ...Array.from({ length: 2 }, (_, i) => page(`https://x.com/products/finance/f${i}`, product)),
      page('https://x.com/about', ['section.about']),
    ]);
    expect(templates.map((t) => [t.id, t.pages])).toEqual([
      ['blog', 6],
      ['products-hr', 5],
      ['blog-2', 2],
      ['about', 1],
    ]);
    expect(templates[1]!.patterns).toEqual([
      { pattern: '/products/hr/*', pages: 3 },
      { pattern: '/products/finance/*', pages: 2 },
    ]);
    expect(templateOf.get('https://x.com/products/finance/f1')).toBe('products-hr');
    expect(templateOf.size).toBe(14);
  });

  it('shows every section early: sitemap URLs round-robin', () => {
    const e = (p: string) => ({ url: `https://x.com${p}`, lastmod: null });
    expect(
      interleave([e('/a/1'), e('/a/2'), e('/a/3'), e('/b/1'), e('/c/1'), e('/b/2')]).map(
        (x) => new URL(x.url).pathname,
      ),
    ).toEqual(['/a/1', '/b/1', '/c/1', '/a/2', '/b/2', '/a/3']);
  });

  it('cleans links and keeps them on the origin', () => {
    expect(cleanLink('https://x.com/a/?utm_source=x&id=2#top')).toBe('https://x.com/a?id=2');
    expect(cleanLink('mailto:a@x.com')).toBeNull();
    expect(onOrigin('https://x.com/a', 'https://www.x.com')).toBe('https://www.x.com/a');
    expect(onOrigin('http://www.x.com/a', 'https://www.x.com')).toBe('https://www.x.com/a');
    expect(onOrigin('https://y.com/a', 'https://www.x.com')).toBeNull();
  });

  it('backs off when throttled and recovers on success', async () => {
    let t = 0;
    const pacer = new Pacer(8, 0, () => t);
    pacer.throttled(null);
    expect(pacer.concurrency).toBe(4);
    pacer.throttled(null);
    expect(pacer.concurrency).toBe(2);
    for (let i = 0; i < 40; i++) pacer.succeeded();
    expect(pacer.concurrency).toBe(4);
    t = 10 ** 9; // past any pause
    expect(await pacer.run(async () => 'ran')).toBe('ran');
  });
});

/** The same contract for the memory store and the Postgres one. */
describe.each([
  ['memory', async () => new MemoryCrawlStore()],
  [
    'postgres',
    async () => {
      const db = new PGlite();
      await migrate(db);
      return new PostgresCrawlStore(db);
    },
  ],
] as const)('crawl store (%s)', (_name, make) => {
  let store: CrawlStore;
  const now = new Date().toISOString();
  const job = (id: string, over: Partial<CrawlJob> = {}): CrawlJob => ({
    id,
    projectId: 'p1',
    origin: 'https://x.com',
    startUrl: 'https://x.com/',
    status: 'running',
    options: {
      maxPages: 100,
      maxDepth: 5,
      concurrency: 4,
      respectRobots: true,
      maxRunMs: 1000,
      reuseFrom: null,
    },
    stats: {
      http: 0,
      rendered: 0,
      reused: 0,
      throttled: 0,
      refused: 0,
      dropped: 0,
      robots: 0,
      readingSince: null,
    },
    sitemapUrls: -1,
    message: null,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    ...over,
  });
  const page = (url: string) => ({
    url,
    status: 200,
    via: 'http' as const,
    title: `T ${url}`,
    description: null,
    lang: 'en',
    headings: [{ level: 1, text: 'H' }],
    links: [],
    images: [],
    regions: { header: null, nav: null, footer: null },
    blocks: [],
    layout: ['section.a'],
    wordCount: 10,
  });

  beforeAll(async () => {
    store = await make();
  }, 60_000);

  it('queues, claims in order, finishes and counts', async () => {
    await store.create(job('c1'));
    const urls = ['a', 'b', 'c', 'd'].map((x) => ({
      url: `https://x.com/${x}`,
      depth: 1,
      source: 'sitemap' as const,
      lastmod: '2026-01-01',
    }));
    expect(await store.enqueue('c1', urls)).toBe(4);
    expect(await store.enqueue('c1', urls.slice(0, 2))).toBe(0);
    const claimed = await store.claim('c1', 3);
    expect(claimed.map((u) => u.url)).toEqual(urls.slice(0, 3).map((u) => u.url));
    expect(claimed.every((u) => u.state === 'inflight')).toBe(true);
    await store.finish('c1', urls[0]!.url, {
      state: 'done',
      page: page(urls[0]!.url),
      attempts: 1,
    });
    await store.finish('c1', urls[1]!.url, { state: 'excluded', reason: 'HTTP 404' });
    expect(await store.counts('c1')).toEqual({
      queued: 1,
      inflight: 1,
      done: 1,
      excluded: 1,
      failed: 0,
    });
    expect(await store.requeue('c1')).toBe(1);
    expect((await store.urls('c1', { states: ['queued'] })).map((u) => u.url)).toEqual([
      urls[2]!.url,
      urls[3]!.url,
    ]);
    const got = await store.page('c1', urls[0]!.url);
    expect(got?.page?.title).toBe(`T ${urls[0]!.url}`);
    expect(got?.url.summary).toMatchObject({
      title: `T ${urls[0]!.url}`,
      h1: 'H',
      layout: ['section.a'],
    });
    expect((await store.urls('c1', { prefix: 'https://x.com/b' })).map((u) => u.reason)).toEqual([
      'HTTP 404',
    ]);
    expect(await store.urls('c1', { limit: 2, offset: 1 })).toHaveLength(2);
  });

  it('updates the job, finds the latest and the running', async () => {
    await store.update('c1', {
      status: 'done',
      sitemapUrls: 4,
      message: 'ok',
      finishedAt: now,
      origin: 'https://www.x.com',
    });
    const j = await store.get('c1');
    expect(j).toMatchObject({
      status: 'done',
      sitemapUrls: 4,
      message: 'ok',
      origin: 'https://www.x.com',
    });
    await store.create(job('c2', { startedAt: new Date(Date.now() + 1000).toISOString() }));
    expect((await store.latest('p1'))?.id).toBe('c2');
    expect((await store.running()).map((r) => r.id)).toEqual(['c2']);
  });

  it('copies unchanged pages into a new crawl', async () => {
    const kept = await store.reuse('c1', 'c2', [
      { url: 'https://x.com/a', lastmod: '2026-01-01' },
      { url: 'https://x.com/c', lastmod: '2026-01-01' }, // not read in c1
    ]);
    expect(kept).toEqual(['https://x.com/a']);
    expect((await store.page('c2', 'https://x.com/a'))?.page?.via).toBe('reused');
    expect(
      await store.reuse('c1', 'c2', [{ url: 'https://x.com/a', lastmod: '2026-01-01' }]),
    ).toEqual([]);
  });

  it('lets one worker hold a crawl at a time', async () => {
    expect(await store.lease('c2', 'w1', 60_000)).toBe(true);
    expect(await store.lease('c2', 'w2', 60_000)).toBe(false);
    expect(await store.lease('c2', 'w1', 60_000)).toBe(true);
    await store.release('c2', 'w1');
    expect(await store.lease('c2', 'w2', 1)).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(await store.lease('c2', 'w1', 60_000)).toBe(true); // w2's ran out
  });
});
