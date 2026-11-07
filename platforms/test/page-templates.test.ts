import { SITECORE_DEFAULTS } from '@lw/connectors';
import { describe, expect, it } from 'vitest';
import { createPlatforms } from '../src';
import {
  BULK_TEMPLATE_PAGES,
  LARGE_SITE_PAGES,
  pageTemplateChecks,
  siteScale,
  spread,
} from '../sitecoreai/page-templates';

const target = {
  cmHost: 'xmc.sitecorecloud.io',
  siteCollection: 'Brands',
  site: 'acme',
  languages: ['en'],
  hostingProject: 'Acme-Site',
};

const ctx = (
  blueprint: unknown,
  docs: Record<string, unknown>,
  scope: { collection: string | null; items: string[] } = { collection: null, items: [] },
) => ({
  projectId: 'p',
  target,
  scope,
  blueprint: blueprint as never,
  read: async () => ({ code: 404, body: {} }),
  credential: async () => null,
  document: async (id: string) => docs[id] ?? null,
});

/** A discovery inventory: how many pages the crawl found, and its templates. */
const inventory = (pagesFound: number, templates: { id: string; pages: number }[] = []) => ({
  origin: 'https://www.acme.example',
  crawl: { crawlId: 'crawl-1', pagesFound, pagesInventoried: 20, partial: pagesFound > 20 },
  pages: [{ path: '/', title: 'Home' }],
  templates,
});

const LARGE = inventory(2700, [
  { id: 'resources-learn', pages: 778 },
  { id: 'resources-glossary', pages: 246 },
  { id: 'company', pages: 12 },
]);

const article = {
  key: 'resources-learn',
  name: 'Learn article',
  attrs: {
    crawlTemplate: 'resources-learn',
    template: 'article',
    pages: 778,
    mapping: [
      { component: 'PageHeader', field: 'title', from: 'h1' },
      {
        component: 'ArticleBody',
        field: 'body',
        from: 'css:article.article-body @html',
        as: 'html',
      },
    ],
  },
};
const glossary = {
  key: 'resources-glossary',
  name: 'Glossary term',
  attrs: {
    crawlTemplate: 'resources-glossary',
    template: 'term',
    mapping: [{ component: 'Term', field: 'definition', from: 'css:.glossary-term p' }],
  },
};
const example = (key: string, path: string, into: string) => ({
  key,
  name: key,
  status: 'merge',
  attrs: { path, template: 'article', mergedInto: into },
});

const largeBlueprint = {
  collections: {
    templates: [
      { key: 'home', name: 'Home' },
      { key: 'article', name: 'Article' },
      { key: 'term', name: 'Term' },
    ],
    'page-templates': [article, glossary],
    pages: [
      { key: 'home', name: 'Home', attrs: { path: '/', template: 'home' } },
      example('learn-1', '/resources/learn/what-is-payroll', 'resources-learn'),
      example('learn-2', '/resources/learn/pto', 'resources-learn'),
      example('term-1', '/resources/glossary/fica', 'resources-glossary'),
    ],
  },
};

describe('the size rule', () => {
  const checks = createPlatforms({ sitecore: SITECORE_DEFAULTS }).get('sitecoreai')!.checks!;
  const rule = checks['blueprint.page-templates']!;

  it('sizes a site by what the crawl found', () => {
    expect(LARGE_SITE_PAGES).toBe(400);
    expect(BULK_TEMPLATE_PAGES).toBe(20);
    expect(siteScale(inventory(399, [{ id: 'blog', pages: 300 }]))).toMatchObject({
      large: false,
      bulk: [],
    });
    expect(siteScale(LARGE)).toMatchObject({ pages: 2700, large: true });
    expect(siteScale(LARGE).bulk.map((t) => t.id)).toEqual([
      'resources-learn',
      'resources-glossary',
    ]);
    // An inventory without crawl counts is sized by the pages it lists.
    expect(siteScale({ pages: Array.from({ length: 450 }, () => ({})) }).large).toBe(true);
  });

  it('plans a small site page by page, and refuses bulk templates for it', async () => {
    const small = { collections: { templates: [], pages: [{ key: 'home', name: 'Home' }] } };
    expect(await rule(ctx(small, { 'page-inventory': inventory(48) }))).toEqual({
      status: 'pass',
      detail: 'A small site (48 pages): every page is planned and migrated on its own.',
    });
    const res = await rule(
      ctx(
        { collections: { ...small.collections, 'page-templates': [article] } },
        { 'page-inventory': inventory(180, [{ id: 'resources-learn', pages: 150 }]) },
      ),
    );
    expect(res.status).toBe('fail');
    expect(res.detail).toMatch(
      /^the source has 180 pages, fewer than 400: a site this size is planned page by page\. Remove page-templates \(resources-learn\)/,
    );
  });

  it('requires every big template of a large site to be planned per template', async () => {
    const res = await rule(
      ctx(
        { collections: { ...largeBlueprint.collections, 'page-templates': [article] } },
        { 'page-inventory': LARGE },
      ),
    );
    expect(res.status).toBe('fail');
    expect(res.detail).toContain(
      'template resources-glossary (246 pages) has no page-templates entry: plan it per template',
    );
    // The 12-page template stays page by page: it isn't asked for.
    expect(res.detail).not.toContain('template company');
  });

  it('names what a page template is missing: crawl template, page template, mapping, examples', async () => {
    const res = await rule(
      ctx(
        {
          collections: {
            ...largeBlueprint.collections,
            'page-templates': [
              article,
              {
                key: 'resources-glossary',
                name: 'Glossary',
                attrs: { crawlTemplate: 'resources-glossary' },
              },
              {
                key: 'company',
                name: 'Company',
                attrs: {
                  crawlTemplate: 'company',
                  template: 'home',
                  mapping: [{ field: 'title', from: 'h1' }],
                },
              },
            ],
            pages: largeBlueprint.collections.pages.filter((p) => p.key !== 'term-1'),
          },
        },
        { 'page-inventory': LARGE },
      ),
    );
    expect(res.status).toBe('fail');
    expect(res.detail).toContain('resources-glossary needs attrs.template');
    expect(res.detail).toContain('resources-glossary has no attrs.mapping');
    expect(res.detail).toContain('resources-glossary has no example pages');
    expect(res.detail).toContain(
      'company covers 12 pages, fewer than 20: plan those pages one by one',
    );
  });

  it('passes a large site planned per template for its big templates, the rest page by page', async () => {
    expect(await rule(ctx(largeBlueprint, { 'page-inventory': LARGE }))).toEqual({
      status: 'pass',
      detail:
        'A large site (2700 pages): 2 templates planned per template (1024 pages, proven on their examples first), 1 page planned one by one.',
    });
    // A big template the client won't keep is dropped with a reason, not left out.
    const dropped = {
      collections: {
        ...largeBlueprint.collections,
        'page-templates': [
          article,
          { ...glossary, status: 'drop', attrs: { ...glossary.attrs, reason: 'retired' } },
        ],
      },
    };
    expect((await rule(ctx(dropped, { 'page-inventory': LARGE }))).status).toBe('pass');
  });
});

describe("a template's proof", () => {
  const seen: string[] = [];
  const checks = createPlatforms({
    sitecore: {
      ...SITECORE_DEFAULTS,
      fetch: (async (url: string | URL | Request) => {
        seen.push(String(url));
        return new Response('', { status: 200 });
      }) as typeof fetch,
    },
  }).get('sitecoreai')!.checks!;
  const scope = { collection: 'page-templates', items: ['resources-learn'] };

  it('checks the example pages, and only them', async () => {
    await checks['head.pages-render']!(ctx(largeBlueprint, {}, scope));
    expect(seen).toEqual([
      'https://acme-site-editing.vercel.app/resources/learn/what-is-payroll',
      'https://acme-site-editing.vercel.app/resources/learn/pto',
    ]);
  });

  it('needs the mapping as it worked, every field kept and every example recorded', async () => {
    const mapping = checks['template.mapping']!;
    expect((await mapping(ctx(largeBlueprint, {}, scope))).detail).toMatch(
      /^no template-mapping-resources-learn document/,
    );
    const partial = {
      template: 'article',
      mapping: [{ component: 'PageHeader', field: 'title', from: 'h1' }],
      examples: [{ path: '/resources/learn/what-is-payroll', itemId: '{1}' }],
    };
    const res = await mapping(
      ctx(largeBlueprint, { 'template-mapping-resources-learn': partial }, scope),
    );
    expect(res.status).toBe('fail');
    expect(res.detail).toContain('leaves out ArticleBody.body');
    expect(res.detail).toContain("doesn't record /resources/learn/pto as migrated");
    const proven = {
      ...partial,
      mapping: [
        ...partial.mapping,
        {
          component: 'ArticleBody',
          field: 'body',
          from: 'css:article.article-body @html',
          as: 'html',
        },
      ],
      examples: [...partial.examples, { path: '/resources/learn/pto/', itemId: '{2}' }],
    };
    expect(
      await mapping(ctx(largeBlueprint, { 'template-mapping-resources-learn': proven }, scope)),
    ).toEqual({
      status: 'pass',
      detail: 'Mapping proven and recorded for the bulk import: Learn article (2 examples).',
    });
  });

  it('is pending for a task that proves no template', async () => {
    expect((await checks['template.mapping']!(ctx(largeBlueprint, {}))).status).toBe('pending');
  });
});

describe("a template's bulk import", () => {
  const scope = { collection: 'page-templates', items: ['resources-learn'] };
  const sampled: { id: string; paths: string[] }[] = [];
  const page =
    (id: string) =>
    async (c: { blueprint: { collections: { pages: { attrs?: { path?: string } }[] } } }) => {
      sampled.push({ id, paths: c.blueprint.collections.pages.map((p) => String(p.attrs?.path)) });
      return { status: 'pass' as const, detail: 'ok' };
    };
  const checks = pageTemplateChecks({
    'parity.render': page('parity.render') as never,
    'parity.visual': page('parity.visual') as never,
  });
  const imported = Array.from({ length: 100 }, (_, i) => ({ path: `/resources/learn/a-${i}` }));
  const withDoc = (doc: unknown, built: string[] = []) => ({
    ...ctx(largeBlueprint, { 'template-import-resources-learn': doc }, scope),
    read: async (_s: string, _op: string, args: Record<string, unknown>) => ({
      code: built.some((b) => String(args.path).endsWith(b)) ? 200 : 404,
      body: {},
    }),
  });

  it('waits for an import that is missing or unfinished', async () => {
    const check = checks['template.imported']!;
    expect((await check(withDoc(null))).detail).toMatch(/hasn't been imported: run import.start/);
    expect((await check(withDoc({ status: 'running' }))).detail).toMatch(
      /import is running: follow it with import.status/,
    );
  });

  it('sends a mapping that misses more than 1 in 10 pages back to be fixed', async () => {
    const res = await checks['template.imported']!(
      withDoc({
        status: 'done',
        total: 100,
        imported: imported.slice(0, 85),
        exceptions: Array.from({ length: 15 }, (_, i) => ({ path: `/x-${i}`, reason: 'no body' })),
      }),
    );
    expect(res.detail).toMatch(
      /15 of 100 pages of resources-learn didn't fit its mapping \(more than 10%\): fix template-mapping-resources-learn .*no body.* and retry the import/,
    );
  });

  it('needs each exception page built, then samples the imported pages through the page checks', async () => {
    const doc = {
      status: 'done',
      total: 100,
      imported: imported.slice(0, 97),
      exceptions: [
        { path: '/resources/learn/odd-1' },
        { path: '/resources/learn/odd-2' },
        { path: '/resources/learn/odd-3' },
      ],
    };
    const res = await checks['template.imported']!(withDoc(doc, ['/odd-1']));
    expect(res.detail).toMatch(
      /2 exception pages of resources-learn aren't built yet: \/resources\/learn\/odd-2, \/resources\/learn\/odd-3/,
    );
    sampled.length = 0;
    const ok = await checks['template.imported']!(withDoc(doc, ['/odd-1', '/odd-2', '/odd-3']));
    expect(ok).toEqual({
      status: 'pass',
      detail:
        'Imported: Learn article: 97 pages imported, 3 built by hand; parity.render on 20; parity.visual on 3.',
    });
    // A spread, first to last, not the first 20.
    const text = sampled.find((s) => s.id === 'parity.render')!.paths;
    expect(text).toHaveLength(20);
    expect(text[0]).toBe('/resources/learn/a-0');
    expect(text.at(-1)).toBe('/resources/learn/a-96');
    expect(spread([1, 2, 3, 4, 5], 3)).toEqual([1, 3, 5]);
  });
});
