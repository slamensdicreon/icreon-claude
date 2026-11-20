import { OPTIMIZELY_DEFAULTS } from '@lw/connectors';
import { describe, expect, it } from 'vitest';
import { optimizelyChecks, typeKeyOf, visibleText } from '../optimizely/checks';
import type { PlatformCheckContext } from '../src';

const target = {
  cmsUrl: 'https://app-acme.cms.optimizely.com',
  application: 'Acme Site',
  typePrefix: 'Acme',
  languages: ['en'],
};
const blueprint = {
  collections: {
    components: [
      { key: 'hero', name: 'Hero' },
      { key: 'promo-card', name: 'Promo Card' },
      { key: 'header', name: 'Site Header', attrs: { shared: true } },
      { key: 'old', name: 'Old Thing', status: 'drop' },
    ],
    templates: [{ key: 'home', name: 'Experience' }],
  },
};
const TYPES = [
  { key: 'AcmeHero', baseType: '_component', compositionBehaviors: ['sectionEnabled'] },
  { key: 'AcmePromoCard', baseType: '_component', compositionBehaviors: ['sectionEnabled'] },
  { key: 'AcmeSiteHeader', baseType: '_component', compositionBehaviors: [] },
  { key: 'AcmeExperience', baseType: '_experience', compositionBehaviors: [] },
];
const TEMPLATES = [
  { key: 'AcmeHeroDefault', contentType: 'AcmeHero', isDefault: true },
  { key: 'AcmePromoCardDefault', contentType: 'AcmePromoCard', isDefault: true },
];
const APP = {
  key: 'Acme_Site',
  startPage: { key: 'a'.repeat(32) },
  assetsRoot: 'b'.repeat(32),
  hosts: [{ host: 'acme.vercel.app', type: 'primary', scheme: 'https' }],
  previewTokens: true,
  previewUrl: '{host}/preview?key={key}&ver={version}&loc={locale}&ctx={context}',
};
const START = {
  status: 'published',
  properties: {},
  composition: [
    {
      name: 'Hero',
      contentType: 'AcmeHero',
      displayTemplate: 'AcmeHeroDefault',
      properties: { heading: 'Welcome to Acme' },
    },
    {
      name: 'Promos',
      contentType: 'AcmePromoCard',
      displayTemplate: 'AcmePromoCardDefault',
      properties: {
        cards: [{ contentType: 'AcmeCard', properties: { heading: 'Tom & Jerry’s' } }],
      },
    },
  ],
};

type Answers = Record<string, { code: number; body: unknown }>;
const ctx = (
  answers: Answers = {},
  over: Partial<PlatformCheckContext> = {},
): PlatformCheckContext => {
  const all: Answers = {
    'optimizely-cms application.read': { code: 200, body: APP },
    'optimizely-cms contenttype.list': { code: 200, body: { contentTypes: TYPES } },
    'optimizely-cms displaytemplate.list': { code: 200, body: { displayTemplates: TEMPLATES } },
    'optimizely-cms content.read': { code: 200, body: START },
    'optimizely-cms blueprint.list': {
      code: 200,
      body: { blueprints: [{ name: 'Landing', contentType: 'AcmeExperience', own: true }] },
    },
    'optimizely-graph graph.routes': {
      code: 200,
      body: {
        routes: [
          { route: '/en/', host: 'https://acme.vercel.app', name: 'Home', status: 'Published' },
        ],
      },
    },
    ...answers,
  };
  return {
    projectId: 'p',
    target,
    scope: { collection: null, items: [] },
    blueprint,
    read: async (server, op) =>
      all[`${server} ${op}`] ?? { code: 404, body: { error: 'Not connected' } },
    credential: async () => null,
    document: async () => null,
    ...over,
  };
};
const HOME = `<html><body><header><a href="/">Acme</a></header><main><h1>Welcome to Acme</h1><h2>Tom &amp; Jerry&#x27;s</h2></main><footer><a href="/x">X</a><a href="/y">Y</a></footer><script>var a="<h1>no</h1>"</script></body></html>`;
const checks = (pages: Record<string, { status: number; html?: string; url?: string }> = {}) =>
  optimizelyChecks({
    ...OPTIMIZELY_DEFAULTS,
    fetch: (async (input: string | URL | Request) => {
      const url = String(input);
      const p = pages[url] ?? { status: 404 };
      const res = new Response(p.html ?? '', { status: p.status });
      Object.defineProperty(res, 'url', { value: p.url ?? url });
      return res;
    }) as typeof fetch,
  });
const run = (id: string, c: PlatformCheckContext, pages?: Parameters<typeof checks>[0]) =>
  checks(pages)[id]!(c);

describe('Optimizely checks', () => {
  it('names a Blueprint item’s content type', () => {
    expect(typeKeyOf({ name: 'Promo Card' }, 'Acme')).toBe('AcmePromoCard');
    expect(typeKeyOf({ name: 'AcmeHero' }, 'Acme')).toBe('AcmeHero');
    expect(typeKeyOf({ name: 'Hero', attrs: { contentType: 'AcmeHeroWithTabs' } }, 'Acme')).toBe(
      'AcmeHeroWithTabs',
    );
  });

  it('passes an application that is ready for editors, and says what one lacks', async () => {
    expect(await run('structural.application', ctx())).toMatchObject({ status: 'pass' });
    const bare = await run(
      'structural.application',
      ctx({
        'optimizely-cms application.read': {
          code: 200,
          body: { ...APP, assetsRoot: null, previewTokens: false },
        },
      }),
    );
    expect(bare.status).toBe('fail');
    expect(bare.detail).toContain('no assets of its own');
    expect(bare.detail).toContain('preview tokens are off');
    expect(
      await run(
        'structural.application',
        ctx({ 'optimizely-cms application.read': { code: 404, body: {} } }),
      ),
    ).toMatchObject({ status: 'fail' });
    // The CMS not answering is not a failure of the work.
    expect(
      await run(
        'structural.application',
        ctx({ 'optimizely-cms application.read': { code: 503, body: { error: 'down' } } }),
      ),
    ).toMatchObject({ status: 'pending' });
  });

  it('holds every Blueprint item to a content type in the CMS, dropped ones aside', async () => {
    expect(await run('structural.content-types', ctx())).toMatchObject({ status: 'pass' });
    expect(await run('structural.templates', ctx())).toMatchObject({ status: 'pass' });
    expect(await run('types.pushed', ctx())).toMatchObject({ status: 'pass' });
    const missing = await run(
      'structural.content-types',
      ctx({
        'optimizely-cms contenttype.list': { code: 200, body: { contentTypes: TYPES.slice(1) } },
      }),
    );
    expect(missing).toMatchObject({ status: 'fail' });
    expect(missing.detail).toContain('Hero: content type AcmeHero is not in the CMS');
    expect(missing.detail).not.toContain('Old Thing');
    const wrongBase = await run(
      'structural.templates',
      ctx({
        'optimizely-cms contenttype.list': {
          code: 200,
          body: { contentTypes: [{ key: 'AcmeExperience', baseType: '_component' }] },
        },
      }),
    );
    expect(wrongBase.detail).toContain('not a page or experience');
    expect(await run('structural.content-types', ctx({}, { blueprint: null }))).toMatchObject({
      status: 'pending',
    });
  });

  it('checks only the task’s own component when it has one', async () => {
    const c = ctx(
      { 'optimizely-cms contenttype.list': { code: 200, body: { contentTypes: TYPES.slice(1) } } },
      { scope: { collection: 'components', items: ['promo-card'] } },
    );
    expect(await run('structural.content-types', c)).toMatchObject({ status: 'pass' });
  });

  it('wants each section-enabled component to have its own default display template', async () => {
    expect(await run('editor.element-enabled', ctx())).toMatchObject({ status: 'pass' });
    const r = await run(
      'editor.element-enabled',
      ctx({
        'optimizely-cms displaytemplate.list': {
          code: 200,
          body: { displayTemplates: TEMPLATES.slice(1) },
        },
      }),
    );
    expect(r).toMatchObject({ status: 'fail' });
    expect(r.detail).toContain('AcmeHero has no default display template of its own');
    // The shared header is never dragged onto a page.
    expect(r.detail).not.toContain('Header');
  });

  it('wants a blueprint editors can start a page from', async () => {
    expect(await run('editor.new-experience', ctx())).toMatchObject({ status: 'pass' });
    expect(
      await run(
        'editor.new-experience',
        ctx({
          'optimizely-cms blueprint.list': {
            code: 200,
            body: { blueprints: [{ name: 'Theirs', own: false }] },
          },
        }),
      ),
    ).toMatchObject({ status: 'fail' });
  });

  it('wants the start page composed from the project’s own sections', async () => {
    expect(await run('structural.experiences', ctx())).toMatchObject({ status: 'pass' });
    const foreign = await run(
      'structural.experiences',
      ctx({
        'optimizely-cms content.read': {
          code: 200,
          body: { composition: [{ name: 'Teaser', contentType: 'Teaser', displayTemplate: 'x' }] },
        },
      }),
    );
    expect(foreign.detail).toContain("not one of the project's");
    expect(
      await run(
        'structural.experiences',
        ctx({ 'optimizely-cms content.read': { code: 200, body: { composition: [] } } }),
      ),
    ).toMatchObject({ status: 'fail' });
  });

  it('wants a primary https host, and the start page in Graph on it', async () => {
    expect(await run('hostname.registered', ctx())).toMatchObject({ status: 'pass' });
    expect(
      await run(
        'hostname.registered',
        ctx({ 'optimizely-cms application.read': { code: 200, body: { ...APP, hosts: [] } } }),
      ),
    ).toMatchObject({ status: 'fail' });
    expect(await run('graph.published', ctx())).toMatchObject({ status: 'pass' });
    expect(
      await run(
        'graph.published',
        ctx({ 'optimizely-graph graph.routes': { code: 200, body: { routes: [] } } }),
      ),
    ).toMatchObject({ status: 'fail' });
    const noHome = await run(
      'graph.published',
      ctx({
        'optimizely-graph graph.routes': {
          code: 200,
          body: { routes: [{ route: '/en/about/', host: 'https://acme.vercel.app' }] },
        },
      }),
    );
    expect(noHome.detail).toContain('The start page (/en/) is not in Graph');
  });

  it('opens every route Graph serves on the head', async () => {
    expect(
      await run('routes.resolve', ctx(), {
        'https://acme.vercel.app/en/': { status: 200, html: HOME },
      }),
    ).toMatchObject({ status: 'pass' });
    const broken = await run('routes.resolve', ctx(), {
      'https://acme.vercel.app/en/': { status: 500 },
    });
    expect(broken).toMatchObject({ status: 'fail', detail: '/en/ answered 500' });
  });

  it('opens the preview as Visual Builder does and looks for what an editor needs', async () => {
    const url = 'https://acme.vercel.app/preview';
    const edit = `${url}?key=a&ver=1&loc=en&ctx=edit&preview_token=t`;
    const links = { 'optimizely-cms content.previews': { code: 200, body: { edit } } };
    const bare = { status: 200, html: '<main>Preview</main>' };
    const framed =
      '<script src="https://app-acme.cms.optimizely.com/util/javascript/communicationinjector.js"></script>' +
      '<div data-epi-block-id="1"><h1 data-epi-edit="heading">Hi</h1><p data-epi-edit="text">x</p></div>';
    expect(
      await run('head.preview-route', ctx(links), {
        [url]: bare,
        [edit]: { status: 200, html: framed },
      }),
    ).toMatchObject({ status: 'pass', data: { fields: 2, blocks: 1 } });
    // A page that renders but marks nothing can't be edited in place.
    const inert = await run('head.preview-route', ctx(links), {
      [url]: bare,
      [edit]: { status: 200, html: '<h1>Hi</h1>' },
    });
    expect(inert).toMatchObject({ status: 'fail' });
    expect(inert.detail).toContain('communicationinjector.js');
    expect(inert.detail).toContain('nothing on the page is marked editable');
    expect(inert.detail).toContain('no section can be selected');
    // The frame can't be opened yet (no host on the application): not a pass.
    expect(await run('head.preview-route', ctx(), { [url]: bare })).toMatchObject({
      status: 'pending',
    });
    const walled = await run('head.preview-route', ctx(links), {
      [url]: { status: 401, html: 'Authentication Required' },
    });
    expect(walled.detail).toContain('Vercel Authentication must be off');
    expect(await run('head.preview-route', ctx(links), {})).toMatchObject({ status: 'fail' });
  });

  it('reads the rendered start page for what its sections hold', async () => {
    const pages = { 'https://acme.vercel.app/en/': { status: 200, html: HOME } };
    expect(await run('head.pages-render', ctx(), pages)).toMatchObject({
      status: 'pass',
      data: { owed: 2 },
    });
    expect(await run('head.header-footer', ctx(), pages)).toMatchObject({ status: 'pass' });
    const bare = {
      'https://acme.vercel.app/en/': { status: 200, html: '<main><h1>Something else</h1></main>' },
    };
    const missing = await run('head.pages-render', ctx(), bare);
    expect(missing).toMatchObject({ status: 'fail' });
    expect(missing.detail).toContain('"Welcome to Acme" (Hero) is not on the page');
    expect((await run('head.header-footer', ctx(), bare)).detail).toContain('no header');
  });

  it('reads text as a visitor sees it', () => {
    expect(visibleText(HOME)).toBe("Acme Welcome to Acme Tom & Jerry's X Y");
  });
});

describe('Optimizely parity checks', () => {
  const inventory = { document: async () => ({ origin: 'https://www.acme.com/' }) };
  const SOURCE =
    '<html><body><h1>Welcome to Acme</h1><h2>Tom &amp; Jerry’s</h2><h2 class="sr-only">Skip</h2><p>' +
    'word '.repeat(60) +
    '</p></body></html>';

  it('compares the start page with the source’s headings', async () => {
    const pages = {
      'https://www.acme.com/': { status: 200, html: SOURCE },
      'https://acme.vercel.app/en/': {
        status: 200,
        html: '<main><h1>Welcome  to Acme</h1><h2>Tom &amp; Jerry’s</h2></main>',
      },
    };
    expect(await run('parity.render', ctx({}, inventory), pages)).toMatchObject({
      status: 'pass',
      data: { headings: 2, missing: [] },
    });
    const thin = {
      ...pages,
      'https://acme.vercel.app/en/': { status: 200, html: '<main><h1>Something else</h1></main>' },
    };
    const r = await run('parity.render', ctx({}, inventory), thin);
    expect(r).toMatchObject({ status: 'fail' });
    expect(r.detail).toContain('"Welcome to Acme" is on the source page and not on the new one');
  });

  it('is pending, never passed, when the source can’t be read or there is no inventory', async () => {
    const pages = {
      'https://acme.vercel.app/en/': { status: 200, html: '<main><h1>Hi</h1></main>' },
    };
    expect(await run('parity.render', ctx({}, inventory), pages)).toMatchObject({
      status: 'pending',
    });
    const challenged = {
      ...pages,
      'https://www.acme.com/': { status: 200, html: '<title>Just a moment...</title>' },
    };
    expect(await run('parity.render', ctx({}, inventory), challenged)).toMatchObject({
      status: 'pending',
    });
    expect(await run('parity.render', ctx(), pages)).toMatchObject({ status: 'pending' });
    expect(await run('parity.visual', ctx({}, inventory))).toMatchObject({ status: 'pending' });
  });

  it('takes the model’s verdict on how the two pages look', async () => {
    const seen: unknown[] = [];
    const compare = (verdict: 'match' | 'differs') => ({
      ...inventory,
      compareScreens: async (pair: unknown) => {
        seen.push(pair);
        return {
          verdict,
          differences: verdict === 'match' ? [] : ['The hero has no background image'],
          tokens: 1,
        };
      },
    });
    expect(await run('parity.visual', ctx({}, compare('match')))).toMatchObject({ status: 'pass' });
    expect(seen[0]).toEqual({
      path: '/',
      source: 'https://www.acme.com/',
      candidate: 'https://acme.vercel.app/en/',
    });
    expect(await run('parity.visual', ctx({}, compare('differs')))).toMatchObject({
      status: 'fail',
      detail: 'The hero has no background image',
    });
  });
});

describe('Optimizely page checks on the task’s own page', () => {
  const withPages = {
    blueprint: {
      collections: {
        ...blueprint.collections,
        pages: [
          { key: 'home', name: 'Home', attrs: { path: '/' } },
          { key: 'about', name: 'About', attrs: { path: '/about' } },
          { key: 'not-found', name: '404', attrs: { path: '/404', errorPage: 404 } },
        ],
      },
    },
  };
  const about = { ...withPages, scope: { collection: 'pages', items: ['about'] } };

  it('reads the page the task migrated, not the start page', async () => {
    const asked: Record<string, unknown>[] = [];
    const c = ctx({}, about);
    const read = c.read;
    c.read = async (server, op, args) => {
      if (op === 'content.read') asked.push(args);
      return read(server, op, args);
    };
    const pages = { 'https://acme.vercel.app/en/about/': { status: 200, html: HOME } };
    expect(await run('head.pages-render', c, pages)).toMatchObject({ status: 'pass' });
    expect(asked).toEqual([{ path: '/content/Acme_Site/about' }]);
    // Nothing at the start page's address was fetched or would have passed for it.
    expect(
      await run('head.pages-render', c, {
        'https://acme.vercel.app/en/': { status: 200, html: HOME },
      }),
    ).toMatchObject({
      status: 'fail',
      detail: 'https://acme.vercel.app/en/about/ answered 404',
    });
  });

  it('compares it with the same page of the source', async () => {
    const seen: unknown[] = [];
    const c = ctx(
      {},
      {
        ...about,
        document: async () => ({ origin: 'https://www.acme.com' }),
        compareScreens: async (pair: unknown) => {
          seen.push(pair);
          return { verdict: 'match' as const, differences: [], tokens: 1 };
        },
      },
    );
    expect(await run('parity.visual', c)).toMatchObject({ status: 'pass' });
    expect(seen).toEqual([
      {
        path: '/about',
        source: 'https://www.acme.com/about',
        candidate: 'https://acme.vercel.app/en/about/',
      },
    ]);
  });

  it('names each failing page when a task covers several, and skips error pages', async () => {
    const c = ctx(
      { 'optimizely-cms content.read': { code: 404, body: { error: 'Nothing there' } } },
      { ...withPages, scope: { collection: 'pages', items: ['home', 'about', 'not-found'] } },
    );
    const r = await run('structural.experiences', c);
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('/: The start page does not exist in the CMS yet');
    expect(r.detail).toContain(
      '/about: /about does not exist in the CMS yet (/content/Acme_Site/about)',
    );
    expect(r.detail).not.toContain('/404');
  });
});

describe('Optimizely checks with an editing host', () => {
  const twoHosts = {
    'optimizely-cms application.read': {
      code: 200,
      body: {
        ...APP,
        hosts: [
          { host: 'acme.vercel.app', type: 'primary', scheme: 'https' },
          { host: 'acme-editing.vercel.app', type: 'preview', scheme: 'https' },
        ],
      },
    },
  };

  it('looks at the build on the preview host, where the integration branch runs', async () => {
    // Production still runs the starter: only the editing host has the team's components.
    const pages = {
      'https://acme-editing.vercel.app/en/': { status: 200, html: HOME },
      'https://acme.vercel.app/en/': { status: 200, html: '<main>Starter</main>' },
    };
    expect(await run('head.pages-render', ctx(twoHosts), pages)).toMatchObject({ status: 'pass' });
    expect(await run('head.header-footer', ctx(twoHosts), pages)).toMatchObject({ status: 'pass' });
    expect((await run('hostname.registered', ctx(twoHosts))).detail).toContain(
      'acme-editing.vercel.app its preview host',
    );
  });

  it('still opens the routes Graph serves on the primary host', async () => {
    const pages = { 'https://acme.vercel.app/en/': { status: 200, html: HOME } };
    expect(await run('routes.resolve', ctx(twoHosts), pages)).toMatchObject({ status: 'pass' });
  });
});

describe('Optimizely content, media and redirect checks', () => {
  const pagesBlueprint = (pages: { key: string; path: string; route?: string }[]) => ({
    blueprint: {
      collections: {
        ...blueprint.collections,
        pages: pages.map((p) => ({
          key: p.key,
          name: p.key,
          attrs: { path: p.path, ...(p.route ? { route: p.route } : {}) },
        })),
      },
    },
    document: async () => ({ origin: 'https://www.acme.com' }),
  });
  const words = (n: number, prefix = 'source') =>
    `<main>${Array.from({ length: n }, (_, i) => `${prefix}word${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`).join(' ')}</main>`;

  it('holds each page to nine in ten of its source page’s words', async () => {
    const c = ctx(
      {},
      pagesBlueprint([
        { key: 'home', path: '/' },
        { key: 'about', path: '/about' },
      ]),
    );
    const same = words(40);
    const pages = {
      'https://www.acme.com/': { status: 200, html: same },
      'https://acme.vercel.app/en/': { status: 200, html: same },
      'https://www.acme.com/about': { status: 200, html: same },
      'https://acme.vercel.app/en/about/': { status: 200, html: same },
    };
    expect(await run('parity.page', c, pages)).toMatchObject({
      status: 'pass',
      data: { parity: 100 },
    });
    const thin = {
      ...pages,
      'https://acme.vercel.app/en/about/': { status: 200, html: words(20) },
    };
    const r = await run('parity.page', c, thin);
    expect(r).toMatchObject({ status: 'fail', data: { parity: 50 } });
    expect(r.detail).toContain('Content parity 50% (98% needed)');
    expect(r.detail).toContain('/about has 50% of the source page’s words'.replace('’', "'"));
    // A source that can't be read is never counted as matching.
    expect(
      await run('parity.page', c, { 'https://acme.vercel.app/en/': { status: 200, html: same } }),
    ).toMatchObject({
      status: 'pending',
    });
  });

  it('wants alt text on every image in the application’s own media', async () => {
    const media = (items: unknown[]) => ({
      'optimizely-graph graph.query': {
        code: 200,
        body: { data: { _Image: { total: items.length, items } } },
      },
    });
    const asked: Record<string, unknown>[] = [];
    const c = ctx(media([{ AltText: 'A hero', _metadata: { displayName: 'hero.webp' } }]));
    const read = c.read;
    c.read = async (server, op, args) => {
      if (op === 'graph.query') asked.push(args);
      return read(server, op, args);
    };
    expect(await run('media.alt-text', c)).toMatchObject({ status: 'pass', data: { images: 1 } });
    // Only this application's media: its assets root, on this instance.
    expect((asked[0]!.variables as { prefix: string }).prefix).toBe(
      `https://app-acme.cms.optimizely.com/siteassets/${'b'.repeat(32)}/`,
    );
    const r = await run(
      'media.alt-text',
      ctx(
        media([
          { AltText: 'A hero', _metadata: { displayName: 'hero.webp' } },
          { AltText: ' ', _metadata: { displayName: 'icon.svg' } },
        ]),
      ),
    );
    expect(r).toMatchObject({ status: 'fail', detail: 'icon.svg has no alt text' });
    expect(await run('media.alt-text', ctx(media([])))).toMatchObject({ status: 'pending' });
  });

  it('wants a moved page to redirect permanently to its new address', async () => {
    const redirect = (status: number, location?: string) =>
      optimizelyChecks({
        ...OPTIMIZELY_DEFAULTS,
        fetch: (async () =>
          new Response(null, { status, headers: location ? { location } : {} })) as typeof fetch,
      })['experience.redirects-resolve']!;
    const moved = ctx(
      {},
      pagesBlueprint([
        { key: 'home', path: '/' },
        { key: 'team', path: '/our-team', route: '/about/team' },
      ]),
    );
    expect(await redirect(308, '/about/team')(moved)).toMatchObject({
      status: 'pass',
      data: { moved: 1 },
    });
    expect(await redirect(301, 'https://acme.vercel.app/en/about/team/')(moved)).toMatchObject({
      status: 'pass',
    });
    expect((await redirect(302, '/about/team')(moved)).detail).toContain(
      'not a permanent redirect',
    );
    expect((await redirect(301, '/somewhere-else')(moved)).detail).toContain('not /about/team');
    expect((await redirect(404)(moved)).status).toBe('fail');
    const unmoved = ctx(
      {},
      pagesBlueprint([
        { key: 'home', path: '/' },
        { key: 'about', path: '/about', route: '/about/' },
      ]),
    );
    expect(await redirect(404)(unmoved)).toMatchObject({ status: 'pass' });
  });
});
