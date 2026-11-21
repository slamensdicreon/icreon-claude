import { OPTIMIZELY_DEFAULTS, SITECORE_DEFAULTS } from '@lw/connectors';
import { describe, expect, it } from 'vitest';
import { optimizelyChecks } from '../optimizely/checks';
import { createPlatforms, type PlatformCheckContext } from '../src';

/**
 * The checks the Optimizely playbooks share with the SitecoreAI ones by id: the Blueprint's model
 * contract (blueprint.coverage), discovery's (discovery.inventory, discovery.blueprint), the
 * shared header and footer's content (parity.chrome) and the pages' titles (seo.titles).
 */

const target = {
  cmsUrl: 'https://app-acme.cms.optimizely.com',
  application: 'Acme Site',
  typePrefix: 'Acme',
  languages: ['en'],
};
const APP = {
  key: 'Acme_Site',
  startPage: { key: 'a'.repeat(32) },
  assetsRoot: 'b'.repeat(32),
  hosts: [
    { host: 'acme.vercel.app', type: 'primary', scheme: 'https' },
    { host: 'acme-editing.vercel.app', type: 'preview', scheme: 'https' },
  ],
  previewTokens: true,
  previewUrl: '{host}/preview?key={key}&ver={version}&loc={locale}&ctx={context}',
};

type Answer = { code: number; body: unknown };
type Pages = Record<string, { status: number; html?: string; url?: string }>;
const fetcher = (pages: Pages, asked: string[] = []) =>
  (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    const p = pages[url] ?? { status: 404 };
    const res = new Response(p.html ?? '', { status: p.status });
    Object.defineProperty(res, 'url', { value: p.url ?? url });
    return res;
  }) as typeof fetch;
const ctx = (over: Partial<PlatformCheckContext> = {}): PlatformCheckContext => ({
  projectId: 'p',
  target,
  scope: { collection: null, items: [] },
  blueprint: null,
  read: async () => ({ code: 404, body: { error: 'Not connected' } }),
  credential: async () => null,
  document: async () => null,
  ...over,
});
const ref = (n: number) => `cms://content/${String(n).repeat(32)}`;
const key = (n: number) => String(n).repeat(32);

describe('Optimizely parity.chrome', () => {
  const blueprint = {
    collections: {
      components: [
        { key: 'hero', name: 'Hero' },
        { key: 'site-header', name: 'Site Header', attrs: { shared: true } },
        {
          key: 'main-navigation',
          name: 'Main Navigation',
          attrs: { shared: true, children: { contentType: 'AcmeNavGroup', max: 8 } },
        },
        {
          key: 'site-footer',
          name: 'Site Footer',
          attrs: { shared: true, children: { contentType: 'AcmeFooterColumn', max: 6 } },
        },
      ],
    },
  };
  const link = (text: string, url = `/${text.toLowerCase()}`) => ({
    properties: { link: { url, text } },
  });
  const HEADER = {
    contentType: 'AcmeSiteHeader',
    status: 'published',
    properties: { logo: ref(9), navigation: ref(3), cta: { url: '/contact', text: 'Contact us' } },
  };
  const NAVIGATION = {
    contentType: 'AcmeMainNavigation',
    status: 'published',
    properties: {
      groups: [
        { properties: { label: 'Products', links: [link('Fibre'), link('Wireless')] } },
        { properties: { label: 'Company', links: [link('About'), link('Careers')] } },
      ],
    },
  };
  const FOOTER = {
    contentType: 'AcmeSiteFooter',
    status: 'published',
    properties: {
      columns: [
        { properties: { heading: 'Support', links: [link('Help'), link('Status')] } },
        { properties: { heading: 'Legal', links: [link('Privacy'), link('Terms')] } },
      ],
      legal: { html: '<p>&copy; 2026 Acme Corporation</p>' },
    },
  };
  const START = {
    status: 'published',
    properties: { header: ref(1), footer: ref(2), metaTitle: 'Acme' },
    composition: [],
  };
  const RENDERED =
    '<html><body><header><a href="/">Acme</a><nav><span>Products</span><a>Fibre</a><a>Wireless</a><span>Company</span><a>About</a><a>Careers</a></nav><a>Contact us</a></header>' +
    '<main><h1>Welcome</h1></main>' +
    '<footer><h3>Support</h3><a>Help</a><a>Status</a><h3>Legal</h3><a>Privacy</a><a>Terms</a><p>© 2026 Acme Corporation</p></footer></body></html>';
  const HOME = 'https://acme-editing.vercel.app/en/';

  /** The CMS as the shell task leaves it: the start page points at the blocks, by key. */
  const cms = (over: Record<string, Answer> = {}, asked: Record<string, unknown>[] = []) => {
    const items: Record<string, Answer> = {
      [key(1)]: { code: 200, body: HEADER },
      [key(2)]: { code: 200, body: FOOTER },
      [key(3)]: { code: 200, body: NAVIGATION },
      [key(9)]: { code: 200, body: { contentType: 'ImageMedia', properties: { AltText: 'Acme' } } },
      '/content/Acme_Site': { code: 200, body: START },
      ...over,
    };
    return async (_server: string, op: string, args: Record<string, unknown>): Promise<Answer> => {
      if (op === 'application.read') return over.application ?? { code: 200, body: APP };
      asked.push(args);
      return (
        items[String(args.key ?? args.path)] ?? { code: 404, body: { error: 'Nothing there' } }
      );
    };
  };
  const run = (
    c: PlatformCheckContext,
    pages: Pages = { [HOME]: { status: 200, html: RENDERED } },
  ) => optimizelyChecks({ ...OPTIMIZELY_DEFAULTS, fetch: fetcher(pages) })['parity.chrome']!(c);

  it('passes shared blocks that hold their links and items, rendered on the start page', async () => {
    const asked: Record<string, unknown>[] = [];
    const r = await run(ctx({ blueprint, read: cms({}, asked) }));
    expect(r).toMatchObject({
      status: 'pass',
      detail:
        'The shared Site Header, Main Navigation, Site Footer hold their content (9 links, 12 items, no placeholders) and the start page of acme-editing.vercel.app renders it.',
    });
    // It follows what the start page points at, and the navigation the header points at.
    expect(asked.map((a) => a.key ?? a.path)).toEqual([
      '/content/Acme_Site',
      key(1),
      key(2),
      key(9),
      key(3),
    ]);
  });

  it('counts a link the page shows as an icon with a label, and not one only a script holds', async () => {
    const icon = RENDERED.replace(
      '<a>Contact us</a>',
      '<a aria-label="Contact us"><svg></svg></a>',
    );
    expect(
      await run(ctx({ blueprint, read: cms() }), { [HOME]: { status: 200, html: icon } }),
    ).toMatchObject({ status: 'pass' });
    // A header that only points at its logo and the navigation holds what it should.
    const bare = { ...HEADER, properties: { logo: ref(9), navigation: ref(3) } };
    expect(
      await run(ctx({ blueprint, read: cms({ [key(1)]: { code: 200, body: bare } }) })),
    ).toMatchObject({ status: 'pass' });
    const scripted = RENDERED.replace(
      /<footer>[\s\S]*<\/footer>/,
      '<footer><a>Home</a></footer><script>var f=["Support","Help","Status","Legal","Privacy","Terms"]</script>',
    );
    const r = await run(ctx({ blueprint, read: cms() }), {
      [HOME]: { status: 200, html: scripted },
    });
    expect(r.status).toBe('fail');
    expect(r.detail).toContain(
      'Site Footer holds 6 links and headings, and 6 are not on the start page ("Support", "Help", "Status", "Legal", "Privacy" and 1 more): publish the block and the start page, and check its component renders every item',
    );
  });

  it('names a block with no items, an empty item, a dead link and placeholder copy', async () => {
    const footer = {
      ...FOOTER,
      properties: {
        columns: [
          {
            properties: {
              heading: 'Column heading',
              links: [
                link('Help', '#'),
                { properties: { link: { url: null, text: 'Status' } } },
                { properties: {} },
              ],
            },
          },
        ],
      },
    };
    const navigation = { ...NAVIGATION, properties: { groups: [] } };
    const r = await run(
      ctx({
        blueprint,
        read: cms({
          [key(2)]: { code: 200, body: footer },
          [key(3)]: { code: 200, body: navigation },
        }),
      }),
    );
    expect(r.status).toBe('fail');
    for (const problem of [
      "Main Navigation has no items: create each column, group and link (or menu entry) in it, from the source site's main navigation",
      'Site Footer has 1 empty item: fill each from the source, or remove it',
      'Site Footer has links that go nowhere: "Help", "Status"',
      'Site Footer holds placeholder copy: "column heading"',
    ])
      expect(r.detail).toContain(problem);
  });

  it('fails a block that is missing, and one the start page does not show', async () => {
    // No footer anywhere: the start page points at none, and none is under /shared.
    const none = await run(
      ctx({
        blueprint,
        read: cms({
          '/content/Acme_Site': {
            code: 200,
            body: { ...START, properties: { header: ref(1) } },
          },
        }),
      }),
    );
    expect(none.status).toBe('fail');
    expect(none.detail).toContain(
      'Site Footer has no shared block: neither the start page nor a block it shows points at one of type AcmeSiteFooter, and there is none at /shared/Acme_Site/Site Footer',
    );
    // A footer that exists but nothing points at: its links are not on the page.
    const page = RENDERED.replace(/<footer>[\s\S]*<\/footer>/, '<footer><a>Home</a></footer>');
    const loose = await run(
      ctx({
        blueprint,
        read: cms({
          '/content/Acme_Site': { code: 200, body: { ...START, properties: { header: ref(1) } } },
          '/shared/Acme_Site/Site Footer': { code: 200, body: FOOTER },
        }),
      }),
      { [HOME]: { status: 200, html: page } },
    );
    expect(loose.status).toBe('fail');
    expect(loose.detail).toContain(
      'Site Footer holds 6 links and headings, and 6 are not on the start page',
    );
    expect(loose.detail).toContain('nothing the start page shows points at the block');
    // The head not answering is a failure of the new site, not something to wait for.
    expect(await run(ctx({ blueprint, read: cms() }), { [HOME]: { status: 500 } })).toMatchObject({
      status: 'fail',
      detail: 'The start page answered 500 on acme-editing.vercel.app',
    });
  });

  it('is pending, never passed, when the Blueprint or the CMS cannot be read', async () => {
    expect(await run(ctx({ read: cms() }))).toMatchObject({ status: 'pending' });
    expect(
      await run(
        ctx({
          blueprint: { collections: { components: [{ key: 'hero', name: 'Hero' }] } },
          read: cms(),
        }),
      ),
    ).toMatchObject({ status: 'pending', detail: 'The Blueprint marks no component as shared.' });
    expect(
      await run(
        ctx({
          blueprint,
          read: cms({ application: { code: 503, body: { error: 'CMS is down' } } }),
        }),
      ),
    ).toMatchObject({
      status: 'pending',
      detail: 'The application could not be read: CMS is down',
    });
    expect(
      await run(
        ctx({ blueprint, read: cms({ [key(2)]: { code: 502, body: { error: 'gateway' } } }) }),
      ),
    ).toMatchObject({
      status: 'pending',
      detail: 'An item the start page points at could not be read: gateway',
    });
  });
});

describe('Optimizely seo.titles', () => {
  const blueprint = {
    collections: {
      pages: [
        { key: 'home', name: 'Home', attrs: { path: '/' } },
        { key: 'about', name: 'About', attrs: { path: '/about' } },
        { key: 'services', name: 'Services', attrs: { path: '/services', redirect: '/' } },
        { key: 'not-found', name: '404', status: 'drop', attrs: { path: '/404', errorPage: 404 } },
      ],
    },
  };
  const html = (title: string) =>
    `<html><head><title>${title}</title></head><body><h1>Hi</h1><p>${'word '.repeat(60)}</p></body></html>`;
  const SOURCE = {
    'https://www.acme.com/': { status: 200, html: html('Acme &#8211; Broadband &amp; Telecom') },
    'https://www.acme.com/about': { status: 200, html: html('About Us | Acme') },
  };
  const inventory = async () => ({ origin: 'https://www.acme.com/' });
  /** The CMS: each page's latest version, with its status and properties. */
  const cms =
    (pages: Record<string, { status: string; properties: Record<string, unknown> }> = {}) =>
    async (_server: string, op: string, args: Record<string, unknown>): Promise<Answer> => {
      if (op === 'application.read') return { code: 200, body: APP };
      const page = pages[String(args.path)];
      return page ? { code: 200, body: page } : { code: 404, body: { error: 'Nothing there' } };
    };
  const run = (c: PlatformCheckContext, pages: Pages, asked: string[] = []) =>
    optimizelyChecks({ ...OPTIMIZELY_DEFAULTS, fetch: fetcher(pages, asked) })['seo.titles']!(c);

  it("passes pages whose <title> is the source page's, each read on the preview host", async () => {
    const asked: string[] = [];
    const r = await run(
      ctx({ blueprint, document: inventory, read: cms() }),
      {
        ...SOURCE,
        'https://acme-editing.vercel.app/en/': {
          status: 200,
          html: html('Acme – Broadband & Telecom'),
        },
        'https://acme-editing.vercel.app/en/about/': { status: 200, html: html('about us | acme') },
      },
      asked,
    );
    expect(r).toMatchObject({ status: 'pass', detail: '2 pages pass: /, /about.' });
    // The page whose visitors are redirected and the dropped 404 page have no title to compare.
    expect(asked.sort()).toEqual([
      'https://acme-editing.vercel.app/en/',
      'https://acme-editing.vercel.app/en/about/',
      'https://www.acme.com/',
      'https://www.acme.com/about',
    ]);
  });

  it('judges only the pages of the task', async () => {
    const asked: string[] = [];
    const r = await run(
      ctx({
        blueprint,
        document: inventory,
        read: cms(),
        scope: { collection: 'pages', items: ['about'] },
      }),
      {
        ...SOURCE,
        'https://acme-editing.vercel.app/en/about/': { status: 200, html: html('About Us | Acme') },
      },
      asked,
    );
    expect(r).toMatchObject({
      status: 'pass',
      detail: '/about carries its source page\'s title, "About Us | Acme".',
    });
    expect(asked).not.toContain('https://www.acme.com/');
  });

  it('says whose fault a different title is: not set, waiting for its release, or head code', async () => {
    const about = { scope: { collection: 'pages', items: ['about'] } };
    const pages = {
      ...SOURCE,
      'https://acme-editing.vercel.app/en/about/': { status: 200, html: html('Acme') },
    };
    const at = '/content/Acme_Site/about';
    const unset = await run(
      ctx({
        blueprint,
        document: inventory,
        read: cms({ [at]: { status: 'published', properties: { metaTitle: 'About' } } }),
        ...about,
      }),
      pages,
    );
    expect(unset).toMatchObject({
      status: 'fail',
      detail:
        '/about has the title "Acme"; the source page\'s is "About Us | Acme". Set it in the page\'s SEO title property, word for word',
    });
    // Set on a draft: the head shows published content only, so the <title> can't be judged yet.
    const drafted = await run(
      ctx({
        blueprint,
        document: inventory,
        read: cms({ [at]: { status: 'draft', properties: { metaTitle: 'About Us | Acme' } } }),
        ...about,
      }),
      pages,
    );
    expect(drafted.status).toBe('pending');
    expect(drafted.detail).toContain(
      '/about holds the source\'s title in metaTitle ("About Us | Acme") in a version that is not published yet',
    );
    const published = await run(
      ctx({
        blueprint,
        document: inventory,
        read: cms({ [at]: { status: 'published', properties: { metaTitle: 'About Us | Acme' } } }),
        ...about,
      }),
      pages,
    );
    expect(published.status).toBe('fail');
    expect(published.detail).toContain(
      "the head's <title> doesn't read the page's title property. That's head code",
    );
    expect(published.detail).toContain('integrate-head');
  });

  it('is pending, never passed, when the source or the inventory cannot be read', async () => {
    const about = { scope: { collection: 'pages', items: ['about'] } };
    const candidate = {
      'https://acme-editing.vercel.app/en/about/': { status: 200, html: html('About Us | Acme') },
    };
    // No inventory: nothing says where the source is.
    expect(await run(ctx({ blueprint, read: cms(), ...about }), candidate)).toMatchObject({
      status: 'pending',
      detail: 'No source inventory gives the source site to compare titles with.',
    });
    // The source doesn't answer, or answers with a bot check.
    const unread = await run(
      ctx({ blueprint, document: inventory, read: cms(), ...about }),
      candidate,
    );
    expect(unread.status).toBe('pending');
    expect(unread.detail).toContain(
      'The source page https://www.acme.com/about could not be read (404)',
    );
    const challenged = await run(ctx({ blueprint, document: inventory, read: cms(), ...about }), {
      ...candidate,
      'https://www.acme.com/about': {
        status: 200,
        html: '<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>',
      },
    });
    expect(challenged).toMatchObject({ status: 'pending' });
    expect(challenged.detail).toContain('a bot check');
    // One page failing is a failure even while another's source can't be read.
    const mixed = await run(ctx({ blueprint, document: inventory, read: cms() }), {
      'https://www.acme.com/': SOURCE['https://www.acme.com/'],
      'https://acme-editing.vercel.app/en/': { status: 200, html: html('Home') },
      ...candidate,
    });
    expect(mixed.status).toBe('fail');
    expect(mixed.detail).toContain('/: The start page does not exist in the CMS yet');
    // The new page not answering is a failure.
    expect(
      await run(ctx({ blueprint, document: inventory, read: cms(), ...about }), SOURCE),
    ).toMatchObject({
      status: 'fail',
      detail: 'https://acme-editing.vercel.app/en/about/ answered 404',
    });
  });
});

describe('Optimizely experience.redirects-resolve', () => {
  it('wants a permanent redirect for a page the Blueprint keeps as a redirecting parent', async () => {
    const redirect = (status: number, location?: string) =>
      optimizelyChecks({
        ...OPTIMIZELY_DEFAULTS,
        fetch: (async () =>
          new Response(null, { status, headers: location ? { location } : {} })) as typeof fetch,
      })['experience.redirects-resolve']!;
    const c = ctx({
      blueprint: {
        collections: {
          pages: [
            { key: 'home', name: 'Home', attrs: { path: '/' } },
            { key: 'services', name: 'Services', attrs: { path: '/services', redirect: '/' } },
            { key: 'fibre', name: 'Fibre', attrs: { path: '/services/fibre' } },
          ],
        },
      },
      read: async () => ({ code: 200, body: APP }),
    });
    expect(await redirect(308, '/')(c)).toMatchObject({ status: 'pass', data: { moved: 1 } });
    expect(await redirect(301, 'https://acme-editing.vercel.app/en/')(c)).toMatchObject({
      status: 'pass',
    });
    expect(await redirect(200)(c)).toMatchObject({
      status: 'fail',
      detail: '/services answered 200, not a permanent redirect to /',
    });
    // Visitors sent to another site: the redirect goes exactly there.
    const away = ctx({
      blueprint: {
        collections: {
          pages: [
            {
              key: 'careers',
              name: 'Careers',
              attrs: { path: '/careers', redirect: 'https://jobs.acme.com/' },
            },
          ],
        },
      },
      read: async () => ({ code: 200, body: APP }),
    });
    expect(await redirect(301, 'https://jobs.acme.com')(away)).toMatchObject({ status: 'pass' });
    expect((await redirect(301, '/jobs')(away)).detail).toContain('not https://jobs.acme.com/');
  });
});

describe('Optimizely blueprint.coverage', () => {
  const checks = createPlatforms({ sitecore: SITECORE_DEFAULTS }).get('optimizely')!.checks!;
  const inventory = async () => ({
    origin: 'https://www.acme.com',
    pages: [{ path: '/' }, { url: 'https://www.acme.com/about/' }],
  });
  /** A Blueprint as the Optimizely Solution Architect's prompt asks for it. */
  const good = () => ({
    collections: {
      components: [
        {
          key: 'hero',
          name: 'Hero',
          pilot: true,
          attrs: {
            contentType: 'AcmeHero',
            behaviour: 'section',
            content: 'page',
            properties: [
              { name: 'heading', type: 'string', required: true },
              { name: 'image', type: 'contentReference', allowedTypes: ['_image'] },
            ],
            displayTemplates: [
              { key: 'AcmeHeroDefault', name: 'Default', default: true },
              { key: 'AcmeHeroCompact', name: 'Compact' },
            ],
          },
        },
        {
          key: 'card-grid',
          name: 'Card Grid',
          attrs: {
            contentType: 'AcmeCardGrid',
            behaviour: 'both',
            properties: [{ name: 'heading', type: 'string' }],
            children: {
              contentType: 'AcmeCard',
              max: 12,
              properties: [{ name: 'title', type: 'string' }],
            },
            displayTemplates: [{ key: 'AcmeCardGridDefault', name: 'Default', default: true }],
          },
        },
        {
          key: 'site-header',
          name: 'Site Header',
          attrs: {
            contentType: 'AcmeSiteHeader',
            behaviour: 'shell',
            content: 'shared',
            shared: true,
            properties: [{ name: 'logo', type: 'contentReference', allowedTypes: ['_image'] }],
          },
        },
        {
          key: 'tile',
          name: 'Tile',
          status: 'merge',
          attrs: { mergedInto: 'card-grid' },
        },
      ],
      templates: [
        {
          key: 'landing',
          name: 'Landing Page',
          attrs: { kind: 'experience', contentType: 'AcmeLandingPage', defaultSections: ['hero'] },
        },
      ],
      pages: [
        { key: 'home', name: 'Home', attrs: { path: '/', template: 'landing' } },
        { key: 'about', name: 'About', attrs: { path: '/about', template: 'landing' } },
        {
          key: 'not-found',
          name: '404',
          status: 'drop',
          attrs: { path: '/404', errorPage: 404, reason: "The head's not-found page" },
        },
      ],
      media: [
        { key: 'hero', name: 'hero.webp', attrs: { url: 'https://cdn.acme.com/a/hero.webp' } },
      ],
    },
  });
  const run = (blueprint: unknown, over: Partial<PlatformCheckContext> = {}) =>
    checks['blueprint.coverage']!(
      ctx({ blueprint: blueprint as never, document: inventory, plan: { pilot: true }, ...over }),
    );

  it("passes a Blueprint written to this platform's model contract", async () => {
    expect(await run(good())).toMatchObject({
      status: 'pass',
      detail:
        '2 pages, 1 page type and 3 components, each with a model contract: keys with the prefix Acme, typed properties, a composition behaviour and display templates.',
    });
  });

  it("fails a Blueprint written to another platform's contract, capping what one verdict lists", async () => {
    const bp = good();
    for (const c of bp.collections.components.slice(0, 3))
      c.attrs = {
        rendering: 'Hero',
        fields: [{ name: 'heading', type: 'Single-Line Text' }],
        queryBudget: { maxItems: 4 },
      } as never;
    const r = await run(bp);
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('hero has no content type key');
    expect(r.detail).toContain('hero has no composition behaviour');
    expect(r.detail).toContain('hero has no properties');
    expect(r.detail).toMatch(/; and \d+ more\.$/);
  });

  it('checks each rule of the contract on its own', async () => {
    const broken = async (change: (bp: ReturnType<typeof good>) => void) => {
      const bp = good();
      change(bp);
      return (await run(bp)).detail;
    };
    const component = (bp: ReturnType<typeof good>, i: number) =>
      bp.collections.components[i]! as { pilot?: boolean; attrs: Record<string, unknown> };
    // Keys: named, prefixed, and no two items with the same one.
    expect(await broken((bp) => delete component(bp, 0).attrs.contentType)).toBe(
      'hero has no content type key (Acme and its name in PascalCase, such as AcmeHero).',
    );
    expect(await broken((bp) => (component(bp, 0).attrs.contentType = 'Hero'))).toBe(
      "hero's content type key Hero doesn't start with the project's prefix Acme: keys are shared by every site on the instance.",
    );
    expect(await broken((bp) => (component(bp, 1).attrs.contentType = 'AcmeHero'))).toBe(
      'hero and card-grid both use the key AcmeHero.',
    );
    // Properties: present, each with a type the platform has, references with their types.
    expect(await broken((bp) => (component(bp, 0).attrs.properties = []))).toBe(
      'hero has no properties.',
    );
    expect(
      await broken(
        (bp) =>
          (component(bp, 0).attrs.properties = [{ name: 'heading', type: 'Single-Line Text' }]),
      ),
    ).toContain(
      'hero\'s property heading has the type "Single-Line Text", which is not an Optimizely property type (string, richText,',
    );
    expect(
      await broken(
        (bp) => (component(bp, 0).attrs.properties = [{ name: 'image', type: 'contentReference' }]),
      ),
    ).toBe(
      "hero's property image (contentReference) names no allowedTypes: the push fails without them.",
    );
    // Behaviour and display templates.
    expect(await broken((bp) => delete component(bp, 0).attrs.behaviour)).toContain(
      'hero has no composition behaviour',
    );
    expect(await broken((bp) => delete component(bp, 0).attrs.displayTemplates)).toContain(
      'hero has no display template: a component editors add needs a default of its own',
    );
    expect(
      await broken(
        (bp) =>
          (component(bp, 0).attrs.displayTemplates = [
            { key: 'AcmeHeroDefault' },
            { key: 'AcmeHeroCompact' },
          ]),
      ),
    ).toBe('hero has 0 default display templates: exactly one is marked default: true.');
    expect(
      await broken(
        (bp) => (component(bp, 0).attrs.displayTemplates = [{ key: 'HeroDefault', default: true }]),
      ),
    ).toBe("hero's display template HeroDefault doesn't start with the project's prefix Acme.");
    // Child items: a limit, and a prefixed type of their own.
    expect(await broken((bp) => (component(bp, 1).attrs.children = { contentType: 'Card' }))).toBe(
      "card-grid's child items have no limit (children.max); card-grid's child type Card doesn't start with the project's prefix Acme: keys are shared by every site on the instance.",
    );
    // Shared blocks are marked.
    expect(await broken((bp) => delete component(bp, 2).attrs.shared)).toBe(
      'site-header is a shared block (behaviour "shell") not marked shared: true: shared blocks are built first, and the page types refer to their types; no component is marked shared: true: mark the header, the footer and the navigation, the blocks every page shows.',
    );
    // Page types and pages.
    expect(
      await broken((bp) => delete (bp.collections.templates[0]!.attrs as { kind?: string }).kind),
    ).toContain('template landing has no kind');
    expect(
      await broken((bp) => (bp.collections.templates[0]!.attrs.defaultSections = ['banner'])),
    ).toBe("template landing's default section banner is not a component the Blueprint builds.");
    expect(
      await broken(
        (bp) =>
          (bp.collections.pages[1]!.attrs = { path: '/contact', template: 'article' } as never),
      ),
    ).toBe('page /about is neither mapped nor dropped; page about uses unknown template article.');
    expect(await broken((bp) => bp.collections.pages.shift())).toBe(
      'page / is neither mapped nor dropped; no home page (a page with attrs.path "/"): the application is created on it, as its start page.',
    );
    // A media entry is one file.
    expect(
      await broken((bp) =>
        bp.collections.media.push({
          key: 'folder',
          name: 'a',
          attrs: { url: 'https://cdn.acme.com/a/' },
        }),
      ),
    ).toBe(
      "media folder's url is a folder (https://cdn.acme.com/a/): give the full URL of the one file it is.",
    );
  });

  it('wants a pilot slice only where the plan proves one', async () => {
    const bp = good();
    delete (bp.collections.components[0] as { pilot?: boolean }).pilot;
    expect(await run(bp)).toMatchObject({
      status: 'fail',
      detail:
        'no pilot components: mark 2 to 4 representative components the home page shows pilot: true.',
    });
    // The homepage demo's plan has no pilot: its whole Blueprint is the slice.
    expect(await run(bp, { plan: { pilot: false } })).toMatchObject({ status: 'pass' });
    // A pilot of shared blocks alone gives the pilot experience nothing to be composed from.
    (bp.collections.components[2] as { pilot?: boolean }).pilot = true;
    expect((await run(bp)).detail).toContain('no pilot component can be added to a page');
  });

  it('asks for the scope decision when Discovery read only part of the site', async () => {
    const sampled = async () => ({
      origin: 'https://www.acme.com',
      crawl: { pagesFound: 900, pagesInventoried: 2, partial: true },
      pages: [{ path: '/' }, { path: '/about' }],
    });
    const r = await run(good(), { document: sampled });
    expect(r.status).toBe('fail');
    expect(r.detail).toContain(
      "the inventory covers 2 of 900 pages found: write the Blueprint's `scope`",
    );
    const scoped = {
      ...good(),
      scope: { pagesFound: 900, approach: 'the rest is built later from these page types.' },
    };
    expect((await run(scoped, { document: sampled })).detail).toContain(
      'Covers 2 of 900 pages found: the rest is built later from these page types.',
    );
    // The homepage demo's site audit is that decision.
    const audited = async () => ({ ...(await sampled()), siteAudit: { pagesFound: 900 } });
    expect((await run(good(), { document: audited })).detail).toContain(
      'Covers 2 of 900 pages found; the site audit counts the rest.',
    );
  });

  it('fails without a Blueprint, and is pending when the inventory or the prefix cannot be read', async () => {
    expect(await run(null)).toMatchObject({
      status: 'fail',
      detail: 'No Blueprint has been written.',
    });
    const unread = await run(good(), { document: async () => null });
    expect(unread.status).toBe('pending');
    expect(unread.detail).toContain('no page inventory could be read');
    expect(await run(good(), { target: { ...target, typePrefix: '' } })).toMatchObject({
      status: 'pending',
    });
  });
});

describe('Optimizely discovery checks', () => {
  const at = (body: string, url: string, status = 200) => {
    const res = new Response(body, { status });
    Object.defineProperty(res, 'url', { value: url });
    return res;
  };
  const page = (title: string, body: string) =>
    `<html><head><title>${title}</title><meta name="description" content="About ${title}."></head><body>${body}</body></html>`;
  const layout = (names: string[]) =>
    `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { layoutData: names.map((componentName) => ({ componentName })) },
    })}</script>`;
  /** The source: a contact form, /services a redirect home, and layout data it embeds. */
  const SOURCE: Record<string, () => Response> = {
    'https://src.example/': () =>
      at(
        page(
          'Acme',
          `<h1>Welcome</h1><img src="https://cdn.acme-media.com/hero.jpg">${layout(['HeroBanner', 'Container'])}`,
        ),
        'https://src.example/',
      ),
    'https://src.example/contact': () =>
      at(
        page(
          'Contact',
          '<h1>Contact</h1><form id="gform_2" action="/contact/"><input name="email"></form>',
        ),
        'https://src.example/contact',
      ),
    'https://src.example/services': () =>
      at(page('Acme', '<h1>Welcome</h1>'), 'https://src.example/'),
  };
  const checks = createPlatforms({
    sitecore: SITECORE_DEFAULTS,
    optimizely: {
      ...OPTIMIZELY_DEFAULTS,
      fetch: (async (u: string | URL | Request) =>
        SOURCE[String(u)]?.() ?? at('', String(u), 404)) as typeof fetch,
    },
  }).get('optimizely')!.checks!;
  const inventory = {
    origin: 'https://src.example',
    crawl: { pagesFound: 2, pagesInventoried: 2, partial: false, sampling: 'every page found' },
    pages: [
      { path: '/', title: 'Acme', description: 'About Acme.' },
      { path: '/contact', title: 'Contact', description: 'About Contact.' },
    ],
    forms: [{ id: 'gform_2', by: 'Gravity Forms', pages: ['/contact'], fields: ['Email'] }],
    redirects: [{ from: '/services', to: '/', status: 301 }],
    layoutData: { pages: ['/'], components: ['HeroBanner', 'Container'] },
    mediaHosts: ['https://cdn.acme-media.com/'],
  };
  const input = (
    blueprint: unknown,
    docs: Record<string, unknown> = { 'page-inventory': inventory },
  ) => ctx({ blueprint: blueprint as never, document: async (id) => docs[id] ?? null });
  const decided = () => ({
    collections: {
      components: [
        {
          key: 'hero',
          name: 'Hero',
          attrs: { contentType: 'AcmeHero', sourceComponents: ['HeroBanner'] },
        },
        {
          key: 'contact-form',
          name: 'Contact Form',
          attrs: {
            contentType: 'AcmeContactForm',
            forms: [{ id: 'gform_2', pages: ['/contact'], fields: ['Email'] }],
          },
        },
      ],
      pages: [
        { key: 'home', name: 'Home', attrs: { path: '/' } },
        { key: 'contact', name: 'Contact', attrs: { path: '/contact' } },
        { key: 'services', name: 'Services', attrs: { path: '/services', redirect: '/' } },
        {
          key: 'not-found',
          name: 'Not found',
          status: 'drop',
          attrs: { path: '/404', errorPage: 404, reason: "The head's not-found page shows it" },
        },
      ],
      media: [
        { key: 'hero', name: 'hero.jpg', attrs: { url: 'https://cdn.acme-media.com/hero.jpg' } },
      ],
    },
  });

  it('checks the page inventory against the source, as on any platform', async () => {
    expect(await checks['discovery.inventory']!(input(null))).toMatchObject({ status: 'pass' });
    const bare = { ...inventory, forms: [], redirects: [], mediaHosts: [] };
    const r = await checks['discovery.inventory']!(input(null, { 'page-inventory': bare }));
    expect(r.status).toBe('fail');
    expect(r.detail).toContain("forms the inventory doesn't record: form#gform_2 on /contact");
    expect(r.detail).toContain("media on 1 host the inventory doesn't name: cdn.acme-media.com");
  });

  it("passes a Blueprint that decides forms, redirects and the 404 page this platform's way", async () => {
    expect(await checks['discovery.blueprint']!(input(decided()))).toMatchObject({
      status: 'pass',
      detail:
        '2 source pages compared with the Blueprint: 1 form accounted for, 1 redirect decided, the 404 page left to the head, 1 source component mapped, media hosts named.',
    });
    // A third-party form the component embeds is the Director's to decide: it is counted.
    const embedded = decided();
    embedded.collections.components[1]!.attrs.forms = [
      { id: 'gform_2', pages: ['/contact'], builtBy: 'director', service: 'HubSpot' } as never,
    ];
    expect((await checks['discovery.blueprint']!(input(embedded))).detail).toContain(
      '1 form accounted for (1 Director item)',
    );
  });

  it('says what is true of forms, redirects and the 404 page on this platform', async () => {
    const bp = decided();
    bp.collections.components.pop();
    bp.collections.pages[2]!.attrs = { path: '/services' } as never;
    bp.collections.pages.pop();
    const r = await checks['discovery.blueprint']!(input(bp));
    expect(r.status).toBe('fail');
    for (const problem of [
      'the Blueprint doesn\'t say what happens to the 404 page: add a page with attrs.path "/404", attrs.errorPage: 404, status "drop" and attrs.reason. On this platform the 404 page is the head\'s not-found page',
      "forms on the source the Blueprint doesn't account for: form#gform_2 on /contact. No component renders forms, and the SDK has no built-in one on this platform",
      'source URLs that redirect elsewhere with no decision: /services (services) redirects to / on the source. For each, keep its page with attrs.redirect naming where visitors go when the pages under it need it as their parent, or drop it (status "drop", attrs.reason). Redirects are the head\'s on this platform',
    ])
      expect(r.detail).toContain(problem);
    expect(r.detail).not.toContain('SitecoreAI');

    // A 404 page kept as a page, and a form component marked as a built-in the platform lacks.
    const kept = decided();
    kept.collections.pages[3] = {
      key: 'not-found',
      name: 'Not found',
      attrs: { path: '/page-not-found', errorPage: 404 },
    } as never;
    (kept.collections.components[1]!.attrs as Record<string, unknown>).builtIn = true;
    const k = await checks['discovery.blueprint']!(input(kept));
    expect(k.status).toBe('fail');
    expect(k.detail).toContain(
      "not-found (/page-not-found) is the 404 page, kept as a page. On this platform the 404 page is the head's not-found page",
    );
    expect(k.detail).toContain(
      'Contact Form is marked attrs.builtIn, but the SDK has no built-in form on this platform',
    );
  });

  it('is pending without a Blueprint, or without a source to compare it with', async () => {
    expect((await checks['discovery.blueprint']!(input(null))).status).toBe('pending');
    expect(await checks['discovery.blueprint']!(input(decided(), {}))).toMatchObject({
      status: 'pending',
      detail:
        'No page inventory gives the source site, so no source page was compared; the 404 page is decided',
    });
  });
});
