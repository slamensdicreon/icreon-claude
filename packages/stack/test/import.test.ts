import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { InMemoryEventStore, migrate } from '@lw/events';
import { loadPlaybook, type Playbook } from '@lw/playbook-sdk';
import {
  BrowserToolServer,
  GuardedBrowser,
  MemoryCrawlStore,
  Crawler,
  CrawlReports,
} from '@lw/tool-browser';
import {
  MemoryBlobStore,
  MemoryIdempotencyStore,
  MemoryWriteLocks,
  TokenBucketLimiter,
  ToolGateway,
  type OperationCatalog,
  type ToolServer,
} from '@lw/tool-gateway';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ImportToolServer,
  MemoryImportStore,
  PostgresImportStore,
  TemplateImporter,
  type BlueprintLike,
  type ImportCall,
  type ImportStore,
} from '../src';

const PLAYBOOK = fileURLToPath(new URL('../../../playbooks/sitecoreai-migration', import.meta.url));
const SITE = '/sitecore/content/Brands/acme';
const HOME = `${SITE}/Home`;
const MEDIA = '/sitecore/media library/Project/Brands/acme/articles';

/** A source site: 30 articles under /resources/learn, one without a body, one under a parent the new site lacks. */
async function sourceSite() {
  const article = (i: number) =>
    `<!doctype html><html><head><title>Article ${i} | Acme</title><meta name="description" content="About ${i}"></head><body>
     <header>Acme</header><main>
       <section class="article-hero"><h1>Article ${i}</h1><img class="hero" src="/media/hero-${i % 3}.png" alt="Hero"></section>
       ${i === 7 ? '' : `<article class="article-body"><p>Body of article ${i}. <a href="/resources/learn/article-${(i + 1) % 30}">Next</a></p><script>x()</script></article>`}
       <aside class="cta"><a href="/demo">Get a demo</a></aside>
     </main><footer>Footer</footer></body></html>`;
  const paths = new Map<string, string>();
  for (let i = 0; i < 30; i++) paths.set(`/resources/learn/article-${i}`, article(i));
  paths.set('/resources/archive/article-99', article(99).replaceAll('Article 99', 'Archived 99'));
  paths.set(
    '/',
    '<html><head><title>Home</title></head><body><main><h1>Home</h1><p>' +
      'word '.repeat(100) +
      '</p></main></body></html>',
  );
  let origin = '';
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url!, 'http://x').pathname;
    if (path === '/sitemap.xml')
      return res
        .writeHead(200, { 'content-type': 'application/xml' })
        .end(
          `<urlset>${[...paths.keys()].map((p) => `<url><loc>${origin}${p}</loc></url>`).join('')}</urlset>`,
        );
    if (path.startsWith('/media/'))
      return res
        .writeHead(200, { 'content-type': 'image/png' })
        .end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const body = paths.get(path);
    if (!body) return res.writeHead(404).end('no');
    res.writeHead(200, { 'content-type': 'text/html' }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { origin, close: () => new Promise<void>((r) => server.close(() => r())) };
}

interface Item {
  itemId: string;
  name: string;
  path: string;
  templateId: string;
  fields: Map<string, string>;
}

/** Sitecore as the authoring operations see it: items by path. */
class FakeSitecore implements ToolServer {
  readonly name = 'sitecore-authoring';
  readonly items = new Map<string, Item>();
  readonly uploads: string[] = [];
  private n = 0;
  readonly catalog: OperationCatalog = {
    'item.read': { mutates: false, pathArgs: ['path'] },
    'item.create': {
      mutates: true,
      pathArgs: ['parentPath'],
      lockPaths: (a) => [`${String(a.parentPath)}/${String(a.name)}`],
    },
    'item.update': { mutates: true, pathArgs: ['path'] },
    'layout.compose': { mutates: true, pathArgs: ['path'] },
    'media.upload': { mutates: true, pathArgs: ['itemPath'] },
  };

  target() {
    return 'tenant';
  }

  add(path: string, templateId: string, fields: Record<string, string> = {}): Item {
    const id = `${(++this.n).toString(16).padStart(8, '0')}-0000-0000-0000-000000000000`;
    const item = {
      itemId: id,
      name: path.split('/').pop()!,
      path,
      templateId,
      fields: new Map(Object.entries(fields)),
    };
    this.items.set(path.toLowerCase(), item);
    return item;
  }

  get(path: string) {
    return this.items.get(path.toLowerCase());
  }

  async call(op: string, a: Record<string, unknown>) {
    const view = (i: Item, names?: string[]) => ({
      itemId: i.itemId,
      name: i.name,
      path: i.path,
      template: { name: 't', templateId: i.templateId },
      fields: {
        nodes: [...i.fields]
          .filter(([k]) =>
            names ? names.some((n) => n.toLowerCase() === k.toLowerCase()) : !k.startsWith('__'),
          )
          .map(([name, value]) => ({ name, value })),
      },
    });
    if (op === 'item.read') {
      const i = this.get(String(a.path));
      if (!i) return { code: 404, body: { error: `No item at ${String(a.path)}` } };
      const children = a.children
        ? {
            children: {
              nodes: [...this.items.values()]
                .filter(
                  (c) =>
                    c.path.toLowerCase().startsWith(`${i.path.toLowerCase()}/`) &&
                    !c.path.slice(i.path.length + 1).includes('/'),
                )
                .map((c) => ({
                  itemId: c.itemId,
                  name: c.name,
                  path: c.path,
                  template: { name: 't' },
                })),
            },
          }
        : {};
      return { code: 200, body: { ...view(i, a.fields as string[] | undefined), ...children } };
    }
    if (op === 'item.create') {
      const parent = this.get(String(a.parentPath));
      if (!parent) return { code: 404, body: { error: 'no parent' } };
      const path = `${parent.path}/${String(a.name)}`;
      const existing = this.get(path);
      if (existing) return { code: 200, body: { itemId: existing.itemId, path, existed: true } };
      const fields = Object.fromEntries(
        ((a.fields ?? []) as { name: string; value: string }[]).map((f) => [f.name, f.value]),
      );
      const made = this.add(path, String(a.templateId ?? ''), fields);
      return { code: 200, body: { itemId: made.itemId, path } };
    }
    if (op === 'item.update') {
      const i = this.get(String(a.path));
      if (!i) return { code: 404, body: { error: 'missing' } };
      for (const f of a.fields as { name: string; value: string }[]) i.fields.set(f.name, f.value);
      return { code: 200, body: { path: i.path } };
    }
    if (op === 'layout.compose') {
      const i = this.get(String(a.path));
      if (!i) return { code: 404, body: { error: 'missing' } };
      i.fields.set('__Renderings', String(a.renderingsXml));
      return { code: 200, body: { path: i.path } };
    }
    if (op === 'media.upload') {
      this.uploads.push(String(a.itemPath));
      const i = this.get(String(a.itemPath)) ?? this.add(String(a.itemPath), 'image');
      return { code: 200, body: { itemPath: i.path, itemId: i.itemId } };
    }
    return { code: 400, body: { error: op } };
  }
}

const braced = (id: string) => `{${id.toUpperCase()}}`;

let playbook: Playbook;
let guarded: GuardedBrowser;
let site: Awaited<ReturnType<typeof sourceSite>>;
let crawlId = '';
let crawlTemplate = '';
let browser: BrowserToolServer;

beforeAll(async () => {
  playbook = await loadPlaybook(PLAYBOOK);
  guarded = new GuardedBrowser({ allowPrivateNetworks: true });
  site = await sourceSite();
  const policy = () => ({ allowedHosts: ['127.0.0.1'], allowPrivateNetworks: true });
  const crawler = new Crawler({ store: new MemoryCrawlStore(), browser: guarded, policy });
  browser = new BrowserToolServer({
    policy,
    blobs: new MemoryBlobStore(),
    browser: guarded,
    crawler,
  });
  const { job } = await crawler.start('p1', { url: `${site.origin}/` });
  const done = await crawler.wait(job.id, 60_000);
  crawlId = done!.id;
  const g = await new CrawlReports(crawler.store).grouping(done!);
  crawlTemplate = g.grouping.templateOf.get(`${site.origin}/resources/learn/article-3`)!;
}, 120_000);

afterAll(async () => {
  await guarded.close();
  await site.close();
});

/** The project as the example's proof left it: Sitecore with the example page, the Blueprint and the mapping. */
function project(opts: { mapping?: unknown[]; store?: ImportStore } = {}) {
  const sitecore = new FakeSitecore();
  sitecore.add(SITE, 'site');
  sitecore.add(HOME, 'home', { Title: 'Home' });
  sitecore.add(`${HOME}/resources`, 'folder');
  sitecore.add(`${HOME}/resources/learn`, 'listing', { Title: 'Learn' });
  const example = sitecore.add(`${HOME}/resources/learn/article-0`, 'article-page', {
    Title: 'Article 0 | Acme',
    NavigationTitle: 'Article 0',
  });
  sitecore.add(`${example.path}/Data`, 'data-folder');
  const header = sitecore.add(`${example.path}/Data/Article Header`, 'header-ds', {
    heading: 'Article 0',
    image: '<image mediaid="{AAAA}" />',
  });
  const body = sitecore.add(`${example.path}/Data/Article Body`, 'body-ds', {
    body: '<p>Body of article 0.</p>',
    footnote: 'only on the example',
  });
  const cta = sitecore.add(`${example.path}/Data/CTA`, 'cta-ds', { label: 'Get a demo' });
  example.fields.set(
    '__Renderings',
    `<r><d id="{FE5D7FDF}" l="{96E5F4BA}"><r ds="${braced(header.itemId)}" id="{R1}" ph="headless-main" uid="{U1}" /><r ds="${braced(body.itemId)}" id="{R2}" ph="headless-main" uid="{U2}" /><r ds="${braced(cta.itemId)}" id="{R3}" ph="headless-main" uid="{U3}" /></d></r>`,
  );
  const mapping = opts.mapping ?? [
    { component: 'page', field: 'Title', from: 'title' },
    { component: 'page', field: 'NavigationTitle', from: 'h1' },
    { component: 'Article Header', field: 'heading', from: 'h1' },
    { component: 'Article Header', field: 'image', from: 'css:img.hero @src', as: 'image' },
    {
      component: 'Article Body',
      field: 'body',
      from: 'css:article.article-body @html',
      as: 'html',
    },
    { component: 'CTA', field: 'label', from: 'same' },
  ];
  const blueprint: BlueprintLike = {
    collections: {
      'page-templates': [
        {
          key: 'learn',
          name: 'Learn article',
          attrs: { crawlTemplate, crawlId, template: 'article' },
        },
      ],
      pages: [
        {
          key: 'a0',
          name: 'Article 0',
          status: 'merge',
          attrs: { path: '/resources/learn/article-0', mergedInto: 'learn' },
        },
      ],
    },
  };
  const docs: Record<string, unknown> = {
    'template-mapping-learn': { template: 'article', mapping, mediaFolder: MEDIA },
    'page-inventory': { crawl: { crawlId } },
  };
  const reports: Record<string, unknown> = {};
  const events = new InMemoryEventStore();
  const gateway = new ToolGateway({
    playbook,
    servers: [sitecore, browser],
    bindings: () => ({
      sitePath: SITE,
      project: 'Brands/acme',
      module: 'Brands/acme',
      collection: 'Brands',
    }),
    credentials: { tokenFor: async () => 'token' },
    idempotency: new MemoryIdempotencyStore(),
    rollback: { hasRecipe: async () => false },
    locks: new MemoryWriteLocks(),
    limiter: new TokenBucketLimiter(10_000, 10_000),
    store: events,
  });
  const call: ImportCall = async (projectId, role, taskId, stepIndex, server, op, args) => {
    const r = await gateway.call({
      projectId,
      taskId,
      stepIndex,
      attempt: 0,
      role,
      server,
      op,
      args,
    });
    if (r.ok) {
      const b = r.body as { untrusted?: boolean; content?: unknown };
      return { ok: true, code: r.code, body: b?.untrusted ? b.content : r.body };
    }
    return {
      ok: false,
      code: 'denied' in r ? 403 : r.code,
      body: null,
      message: r.message,
      retryable: 'retryable' in r ? r.retryable : false,
    };
  };
  const importer = new TemplateImporter({
    store: opts.store ?? new MemoryImportStore(),
    crawls: browser.crawler.store,
    browser: guarded,
    policy: () => ({ allowedHosts: ['127.0.0.1'], allowPrivateNetworks: true }),
    call,
    blueprint: async () => blueprint,
    document: async (_p, id) => docs[id] ?? null,
    report: async (_p, template, content) => {
      reports[template] = content;
    },
    sitePath: () => SITE,
  });
  return {
    sitecore,
    importer,
    server: new ImportToolServer(importer),
    docs,
    reports,
    events,
    example,
    header,
    body,
    cta,
  };
}

const ctx = {
  projectId: 'p1',
  token: '',
  role: 'content-migrator',
  taskId: 'import-template-learn',
};

describe('the bulk import', () => {
  it('builds every other page of the template like the example, filled from its source page', async () => {
    const p = project();
    const started = await p.server.call('start', { template: 'learn' }, ctx);
    expect(started.code).toBe(202);
    expect(started.summary).toMatch(
      /^Importing 30 pages of learn in the background \(import-\w+\)/,
    );
    let status;
    do status = await p.server.call('status', { template: 'learn', waitSeconds: 60 }, ctx);
    while ((status.body as { status: string }).status === 'running');
    expect(status.body).toMatchObject({
      status: 'done',
      pages: { total: 30, written: 28, exceptions: 2 },
    });

    const page = p.sitecore.get(`${HOME}/resources/learn/article-12`)!;
    expect(page.templateId).toBe('article-page');
    expect(page.fields.get('Title')).toBe('Article 12 | Acme');
    expect(page.fields.get('NavigationTitle')).toBe('Article 12');
    const header = p.sitecore.get(`${page.path}/Data/Article Header`)!;
    const body = p.sitecore.get(`${page.path}/Data/Article Body`)!;
    expect(header.fields.get('heading')).toBe('Article 12');
    // Rich Text: the source's HTML, scripts gone, links absolute.
    expect(body.fields.get('body')).toBe(
      `<p>Body of article 12. <a href="${site.origin}/resources/learn/article-13">Next</a></p>`,
    );
    // A field the mapping leaves out is set empty, never the example's copy.
    expect(body.fields.get('footnote')).toBe('');
    expect(p.sitecore.get(`${page.path}/Data/CTA`)!.fields.get('label')).toBe('Get a demo');
    // Its layout is the example's, pointing at its own datasources.
    const xml = page.fields.get('__Renderings')!;
    expect(xml).toContain(`ds="${braced(header.itemId)}"`);
    expect(xml).toContain(`ds="${braced(body.itemId)}"`);
    expect(xml).not.toContain(braced(p.body.itemId));
    expect(xml).not.toContain('uid="{U1}"');
    // Three distinct hero images, each uploaded once, and linked by media ID.
    expect(new Set(p.sitecore.uploads).size).toBe(3);
    expect(p.sitecore.uploads.every((u) => u.startsWith(`${MEDIA}/hero-`))).toBe(true);
    expect(header.fields.get('image')).toMatch(/^<image mediaid="\{[0-9A-F-]+\}" \/>$/);

    // What didn't fit, with why.
    const off = await p.server.call('pages', { template: 'learn', state: 'exception' }, ctx);
    const reasons = Object.fromEntries(
      (off.body as { pages: { path: string; reason: string }[] }).pages.map((r) => [
        r.path,
        r.reason,
      ]),
    );
    expect(reasons['/resources/learn/article-7']).toMatch(
      /nothing for Article Body\.body \(css:article\.article-body @html\): it doesn't fit the mapping/,
    );
    expect(reasons['/resources/archive/article-99']).toMatch(
      /its parent \/resources\/archive isn't on the new site yet/,
    );
    expect(status.summary).toMatch(
      /done, 28 of 30 pages written, 2 exceptions \(7%\)\. Build each exception page yourself/,
    );

    // The report its acceptance reads.
    expect(p.reports.learn).toMatchObject({ status: 'done', total: 30 });
    expect((p.reports.learn as { imported: unknown[] }).imported).toHaveLength(28);

    // Every write went through the gateway, as the task, and is on record.
    const steps = (await p.events.read('p1')).filter((e) => e.type === 'step.recorded');
    expect(steps.length).toBeGreaterThan(28 * 5);
  }, 120_000);

  it('retries its exceptions once what they wait on is fixed', async () => {
    const p = project();
    await p.importer.start('p1', 'import-template-learn', 'learn', { role: 'content-migrator' });
    const first = await p.importer.store.latest('p1', 'learn');
    await p.importer.wait(first!.id, 60_000);
    // The parent is built, and the body made optional (some articles have none).
    p.sitecore.add(`${HOME}/resources/archive`, 'listing');
    (
      p.docs['template-mapping-learn'] as { mapping: { field: string; optional?: boolean }[] }
    ).mapping.find((m) => m.field === 'body')!.optional = true;
    const again = await p.server.call('start', { template: 'learn', retry: true }, ctx);
    expect(again.summary).toMatch(/^Retrying 2 pages of learn/);
    const done = await p.importer.wait(first!.id, 60_000);
    expect(done?.status).toBe('done');
    expect(await p.importer.store.counts(first!.id)).toMatchObject({ done: 30, exception: 0 });
    expect(
      p.sitecore
        .get(`${HOME}/resources/archive/article-99/Data/Article Header`)!
        .fields.get('heading'),
    ).toBe('Archived 99');
  }, 120_000);

  it('returns the finished import instead of starting another', async () => {
    const p = project();
    await p.importer.start('p1', 't', 'learn', { role: 'content-migrator' });
    const job = await p.importer.store.latest('p1', 'learn');
    await p.importer.wait(job!.id, 60_000);
    const r = await p.server.call('start', { template: 'learn' }, ctx);
    expect(r.code).toBe(200);
    expect(r.summary).toMatch(
      /learn was imported already \(import-\w+\): 28 pages, 2 exceptions\. Pass retry: true/,
    );
  }, 120_000);

  it("refuses before writing anything: no proven mapping, a mapping it can't run, a list it can't map", async () => {
    const p = project();
    delete p.docs['template-mapping-learn'];
    expect((await p.server.call('start', { template: 'learn' }, ctx)).body).toEqual({
      error: 'No template-mapping-learn: prove the template on its example pages first',
    });
    const loose = project({
      mapping: [{ component: 'page', field: 'Title', from: 'the page title' }],
    });
    expect(
      ((await loose.server.call('start', { template: 'learn' }, ctx)).body as { error: string })
        .error,
    ).toMatch(
      /can't be run as it is: entry 1 \(page\.Title\): "the page title" isn't a source the import can read/,
    );
    const unknown = project({ mapping: [{ component: 'Hero', field: 'x', from: 'h1' }] });
    expect(
      ((await unknown.server.call('start', { template: 'learn' }, ctx)).body as { error: string })
        .error,
    ).toMatch(
      /names Hero, which the example page \/resources\/learn\/article-0 has no datasource item for/,
    );
    const lists = project();
    lists.sitecore.add(`${lists.cta.path}/Link 1`, 'link', { text: 'One' });
    expect(
      ((await lists.server.call('start', { template: 'learn' }, ctx)).body as { error: string })
        .error,
    ).toMatch(/The example's CTA lists 1 child items, and the bulk import can't map lists/);
    expect(lists.sitecore.get(`${HOME}/resources/learn/article-5`)).toBeUndefined();
  }, 60_000);

  it('copies a datasource whole, child items included, when mapped as the same on every page', async () => {
    const p = project({
      mapping: [
        { component: 'page', field: 'Title', from: 'title' },
        { component: 'Article Header', field: 'heading', from: 'h1' },
        {
          component: 'Article Body',
          field: 'body',
          from: 'css:article.article-body @html',
          as: 'html',
          optional: true,
        },
        { component: 'CTA', field: '*', from: 'same' },
      ],
    });
    p.sitecore.add(`${p.cta.path}/Link 1`, 'link', { text: 'Book a call' });
    await p.importer.start('p1', 't', 'learn', { role: 'content-migrator' });
    const job = await p.importer.store.latest('p1', 'learn');
    await p.importer.wait(job!.id, 60_000);
    const link = p.sitecore.get(`${HOME}/resources/learn/article-4/Data/CTA/Link 1`);
    expect(link?.fields.get('text')).toBe('Book a call');
  }, 120_000);
});

describe.each([
  ['memory', async () => new MemoryImportStore()],
  [
    'postgres',
    async () => {
      const db = new PGlite();
      await migrate(db);
      return new PostgresImportStore(db);
    },
  ],
] as const)('import store (%s)', (_name, make) => {
  it('queues, claims in order, finishes, retries and counts', async () => {
    const store = await make();
    const now = new Date().toISOString();
    await store.create({
      id: 'i1',
      projectId: 'p1',
      taskId: 't',
      template: 'learn',
      crawlId: 'c1',
      status: 'running',
      plan: { role: 'content-migrator' },
      stats: { written: 0, uploads: 0, writingSince: null },
      message: null,
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
    });
    const pages = ['a', 'b', 'c'].map((x) => ({ url: `https://x/${x}`, path: `/${x}` }));
    expect(await store.enqueue('i1', pages)).toBe(3);
    expect(await store.enqueue('i1', pages)).toBe(0);
    expect((await store.claim('i1', 2)).map((p) => p.path)).toEqual(['/a', '/b']);
    await store.finish('i1', 'https://x/a', { state: 'done', itemId: '{1}', attempts: 1 });
    await store.finish('i1', 'https://x/b', { state: 'exception', reason: 'no body' });
    expect(await store.counts('i1')).toEqual({
      queued: 1,
      inflight: 0,
      done: 1,
      exception: 1,
      failed: 0,
    });
    expect(await store.requeue('i1', ['exception'])).toBe(1);
    expect((await store.pages('i1', { states: ['queued'] })).map((p) => p.path)).toEqual([
      '/b',
      '/c',
    ]);
    await store.update('i1', { status: 'done', plan: { role: 'x' }, finishedAt: now });
    expect(await store.latest('p1', 'learn')).toMatchObject({
      status: 'done',
      plan: { role: 'x' },
    });
    expect(await store.running()).toEqual([]);
    expect(await store.lease('i1', 'w1', 60_000)).toBe(true);
    expect(await store.lease('i1', 'w2', 60_000)).toBe(false);
  }, 60_000);
});
