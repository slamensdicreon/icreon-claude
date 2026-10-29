import { fileURLToPath } from 'node:url';
import { IntakeFacts } from '@lw/contracts';
import { SITECORE_DEFAULTS } from '@lw/connectors';
import { loadCatalog } from '@lw/playbook-sdk';
import { describe, expect, it } from 'vitest';
import { createPlatforms, IntakeError, intakeSpec, sitecoreTarget, validateTarget } from '../src';

const PLAYBOOKS = fileURLToPath(new URL('../../playbooks', import.meta.url));
const platforms = createPlatforms({ sitecore: SITECORE_DEFAULTS });

describe('platform packs', () => {
  it('give every playbook in the catalog its intake fields and credentials', async () => {
    const catalog = await loadCatalog(PLAYBOOKS);
    for (const { playbook } of catalog.values()) {
      const pack = platforms.get(playbook.manifest.platform);
      expect(pack, `${playbook.manifest.id} names a platform pack`).toBeDefined();
      expect(() => intakeSpec(playbook, pack!)).not.toThrow();
    }
  });

  it('check target values against the intake the playbook declares', async () => {
    const catalog = await loadCatalog(PLAYBOOKS);
    const pack = platforms.get('sitecoreai')!;
    const spec = intakeSpec(catalog.get('sitecoreai-migration')!.playbook, pack);
    const target = pack.normalize(
      validateTarget(spec, {
        cmHost: 'https://xmc-globex.sitecorecloud.io/',
        siteCollection: 'Brands',
        site: 'globex',
        languages: 'en, es-US',
        hostingProject: 'globex-site',
        stray: 'ignored',
      }),
    );
    expect(target).toEqual({
      cmHost: 'xmc-globex.sitecorecloud.io',
      siteCollection: 'Brands',
      site: 'globex',
      languages: ['en', 'es-US'],
      hostingProject: 'globex-site',
    });
    expect(pack.bindings(target)).toMatchObject({
      sitePath: '/sitecore/content/Brands/globex',
      project: 'Brands/globex',
    });
    expect(pack.toolCredential('sitecore-authoring')?.credentialId).toBe('sitecore-environment');
    expect(pack.toolCredential('github')).toBeUndefined();
    expect(() =>
      validateTarget(spec, { cmHost: 'x', site: 'globex', hostingProject: 'Bad Name' }),
    ).toThrow(IntakeError);
  });

  it('give the head the stored editing secret first, and say why when there is none', async () => {
    const pack = platforms.get('sitecoreai')!;
    const target = {
      cmHost: 'xmc-acme.sitecorecloud.io',
      siteCollection: 'Brands',
      site: 'acme',
      languages: ['en'],
    };
    const env = (stored: string | null) =>
      pack.headEnv!(target, 'production', {
        credential: async (id) => (id === 'editing-secret' && stored ? { secret: stored } : null),
        editingSecret: async () => ({ problem: 'The Deploy API returned no editing secret.' }),
      });
    const withStored = await env('stored-editing-secret-123');
    expect(withStored.vars).toContainEqual({
      key: 'SITECORE_RENDER_ON_REQUEST',
      value: 'true',
      sensitive: false,
    });
    expect(withStored.vars).toContainEqual({
      key: 'SITECORE_EDITING_SECRET',
      value: 'stored-editing-secret-123',
      sensitive: true,
    });
    expect((await env(null)).missing).toContain(
      'the editing secret: The Deploy API returned no editing secret.',
    );
    const check = pack.credentials['editing-secret']!.check;
    expect((await check({ secret: 'short' }, target)).ok).toBe(false);
    expect((await check({ secret: 'stored-editing-secret-123' }, target)).ok).toBe(true);
  });

  it('read intake recorded before playbooks declared their own as SitecoreAI targets', () => {
    const legacy = IntakeFacts.parse({
      repo: 'slamensdicreon/dycom-ansco-associates',
      branch: 'main',
      cmHost: 'xmc-example.sitecorecloud.io',
      siteCollection: 'Brands',
      site: 'ansco',
      languages: ['en'],
      hosting: { provider: 'vercel', project: 'dycom-ansco-associates' },
    });
    expect(legacy).toMatchObject({
      platform: 'sitecoreai',
      repo: 'slamensdicreon/dycom-ansco-associates',
    });
    expect(sitecoreTarget(legacy)).toEqual({
      cmHost: 'xmc-example.sitecorecloud.io',
      siteCollection: 'Brands',
      site: 'ansco',
      languages: ['en'],
      hostingProject: 'dycom-ansco-associates',
    });
  });
});

describe('SitecoreAI checks', () => {
  const pack = platforms.get('sitecoreai')!;
  const target = {
    cmHost: 'xmc.sitecorecloud.io',
    siteCollection: 'Brands',
    site: 'ansco',
    languages: ['en'],
  };
  /** A tenant as item paths, with children and fields. */
  const tenant = (items: Record<string, { id?: string; fields?: Record<string, string> }>) => {
    const reads: string[] = [];
    const read = async (_s: string, _op: string, args: Record<string, unknown>) => {
      const path = String(args.path);
      reads.push(path);
      const it = items[path];
      if (!it) return { code: 404, body: {} };
      const children = Object.keys(items)
        .filter((p) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/'))
        .map((p) => ({ itemId: items[p]!.id ?? p, name: p.split('/').at(-1)!, path: p }));
      return {
        code: 200,
        body: {
          itemId: it.id ?? path,
          name: path.split('/').at(-1),
          path,
          children: { nodes: children },
          fields: {
            nodes: Object.entries(it.fields ?? {}).map(([name, value]) => ({ name, value })),
          },
        },
      };
    };
    return { read, reads };
  };
  const ctx = (
    read: ReturnType<typeof tenant>['read'],
    blueprint: unknown,
    scope: { collection: string | null; items: string[] } = { collection: null, items: [] },
  ) => ({
    projectId: 'p',
    target,
    scope,
    blueprint: blueprint as never,
    read,
    credential: async () => null,
    document: async () => null,
  });

  it('checks renderings exist in the project folder and are offered in Available Renderings', async () => {
    const r = '/sitecore/layout/Renderings/Project/Brands/ansco';
    const t = tenant({
      [r]: {},
      [`${r}/Hero`]: { id: '{AAAA-1}' },
      [`${r}/Cards`]: { id: '{BBBB-2}' },
      '/sitecore/content/Brands/ansco/Presentation/Available Renderings': {},
      '/sitecore/content/Brands/ansco/Presentation/Available Renderings/Page Content': {
        fields: { Renderings: '{AAAA-1}' },
      },
    });
    const bp = {
      collections: {
        components: [
          { key: 'hero', name: 'Hero', attrs: { rendering: 'Hero' } },
          { key: 'cards', name: 'Cards', attrs: { rendering: 'Cards' } },
          { key: 'old', name: 'Old', status: 'drop' },
        ],
      },
    };
    const res = await pack.checks!['structural.renderings']!(ctx(t.read, bp));
    expect(res.status).toBe('fail');
    expect(res.detail).toBe(
      "Cards ({BBBB-2}) isn't in Available Renderings: none of Page Content lists that ID.",
    );

    // A registration task is checked on its own component, whose rendering may be a
    // { name, componentName } model contract rather than a plain name.
    const contract = {
      collections: {
        components: [
          {
            key: 'hero',
            name: 'Hero',
            attrs: { rendering: { name: 'Hero', componentName: 'Hero' } },
          },
          { key: 'cards', name: 'Cards', attrs: { rendering: { componentName: 'Cards' } } },
          { key: 'tabs', name: 'Tabs', attrs: { rendering: 'Tabs' } },
        ],
      },
    };
    const own = await pack.checks!['structural.renderings']!(
      ctx(t.read, contract, { collection: 'components', items: ['hero'] }),
    );
    expect(own).toMatchObject({ status: 'pass' });
    const all = await pack.checks!['structural.renderings']!(ctx(t.read, contract));
    expect(all.detail).toBe(
      "Cards ({BBBB-2}) isn't in Available Renderings: none of Page Content lists that ID; rendering Tabs not under " +
        r +
        '.',
    );
    expect(all.detail).not.toContain('[object Object]');
  });

  it('names duplicate renderings, and reads groups kept in folders', async () => {
    const r = '/sitecore/layout/Renderings/Project/Brands/ansco';
    const groups = '/sitecore/content/Brands/ansco/Presentation/Available Renderings';
    const t = tenant({
      [r]: {},
      [`${r}/Rich Text`]: { id: '{CCCC-3}' },
      [`${r}/Content`]: {},
      [`${r}/Content/Rich Text`]: { id: '{DDDD-4}' },
      [`${r}/Hero`]: { id: '{AAAA-1}' },
      [groups]: {},
      [`${groups}/Brand`]: {},
      [`${groups}/Brand/Heroes`]: { fields: { Renderings: '{AAAA-1}' } },
    });
    const bp = {
      collections: {
        components: [
          { key: 'hero', name: 'Hero', attrs: { rendering: 'Hero' } },
          { key: 'rich-text', name: 'Rich Text', attrs: { rendering: 'Rich Text' } },
        ],
      },
    };
    const res = await pack.checks!['structural.renderings']!(ctx(t.read, bp));
    expect(res.detail).toBe(
      `2 renderings named Rich Text (${r}/Rich Text {CCCC-3}, ${r}/Content/Rich Text {DDDD-4}): keep one, delete the others, and offer the one kept.`,
    );
  });

  it("checks insert options on each template's standard values against the Blueprint", async () => {
    const root = '/sitecore/templates/Project/Brands/ansco';
    const items = {
      [root]: {},
      [`${root}/Pages`]: {},
      // Set on the template item itself, where Sitecore ignores it.
      [`${root}/Pages/Corporate Page`]: { id: '{C0-1}', fields: { __Masters: '{C0-1}|{CA-2}' } },
      [`${root}/Pages/Corporate Page/__Standard Values`]: { fields: { __Masters: '{C0-1}' } },
      [`${root}/Pages/Careers Page`]: { id: '{CA-2}' },
      [`${root}/Pages/Careers Page/__Standard Values`]: { fields: { __Masters: '{CA-2}' } },
    };
    const bp = {
      collections: {
        templates: [
          {
            key: 'corporate-page',
            name: 'Corporate Page',
            attrs: { insertOptions: ['corporate-page', 'careers-page'] },
          },
          { key: 'careers-page', name: 'Careers Page', attrs: { insertOptions: ['careers-page'] } },
          // Merged into Corporate Page: no template of its own.
          { key: 'faq', name: 'FAQ', status: 'merge', attrs: { mergedInto: 'corporate-page' } },
        ],
      },
    };
    const res = await pack.checks!['structural.templates']!(ctx(tenant(items).read, bp));
    expect(res.detail).toBe(
      `Corporate Page's insert options (__Masters on ${root}/Pages/Corporate Page/__Standard Values) are {C0-1}; the Blueprint wants Corporate Page {C0-1} and Careers Page {CA-2}, missing Careers Page.`,
    );
    items[`${root}/Pages/Corporate Page/__Standard Values`].fields.__Masters = '{c0-1}|{ca-2}';
    const ok = await pack.checks!['structural.templates']!(ctx(tenant(items).read, bp));
    expect(ok).toEqual({
      status: 'pass',
      detail:
        '2 templates exist with standard values, and their insert options match the Blueprint; 1 merged into others, as the Blueprint says.',
    });
  });

  it('checks each page has components on a layout Sitecore can read', async () => {
    const home = '/sitecore/content/Brands/ansco/Home';
    const layout = (id: string) =>
      `<r><d id="{FE5D7FDF-89C0-4D99-9AA3-B5FBD009C9F3}" l="{96E5F4BA-A2CF-4A4C-A4E7-64DA88226362}"><r uid="{9A1C0000-0000-4000-8000-000000000001}" id="${id}" ph="headless-main" /></d></r>`;
    const items: Record<string, { fields?: Record<string, string> }> = {
      [`${home}/about`]: { fields: { __Renderings: layout('{A1B2C3D40000400080000000000000AA}') } },
      [`${home}/careers`]: { fields: { __Renderings: layout('').replace(/<r uid[^>]*\/>/, '') } },
    };
    const bp = {
      collections: {
        pages: [
          { key: 'about', name: 'About', attrs: { path: '/about' } },
          { key: 'careers', name: 'Careers', attrs: { path: '/careers' } },
        ],
      },
    };
    const res = await pack.checks!['structural.layouts']!(ctx(tenant(items).read, bp));
    expect(res).toEqual({
      status: 'fail',
      detail:
        "/about: 1 of 1 components point at their rendering or datasource by an ID Sitecore can't read (32 bare hex digits); place them again with layout.compose; /careers has no components on its layout.",
    });
    items[`${home}/about`]!.fields!.__Renderings = layout('{A1B2C3D4-0000-4000-8000-0000000000AA}');
    items[`${home}/careers`] = items[`${home}/about`]!;
    expect(await pack.checks!['structural.layouts']!(ctx(tenant(items).read, bp))).toEqual({
      status: 'pass',
      detail: '2 pages have components on a layout Sitecore can read.',
    });
  });

  it('loads each page on the editing host and names the ones that fail to render', async () => {
    const seen: string[] = [];
    const checks = createPlatforms({
      sitecore: {
        ...SITECORE_DEFAULTS,
        fetch: (async (url: string | URL | Request) => {
          seen.push(String(url));
          return new Response('', { status: String(url).endsWith('/about') ? 500 : 200 });
        }) as typeof fetch,
      },
    }).get('sitecoreai')!.checks!;
    const bp = {
      collections: {
        pages: [
          { key: 'home', name: 'Home', attrs: { path: '/' } },
          { key: 'about', name: 'About', attrs: { path: '/about' } },
        ],
      },
    };
    const res = await checks['head.pages-render']!({
      ...ctx(tenant({}).read, bp),
      target: { ...target, hostingProject: 'Ansco-Site' },
    });
    expect(seen).toEqual([
      'https://ansco-site-editing.vercel.app/',
      'https://ansco-site-editing.vercel.app/about',
    ]);
    expect(res).toEqual({
      status: 'fail',
      detail:
        "/about answered 500 on https://ansco-site-editing.vercel.app: a component throws while rendering; the head's runtime log names it.",
    });
  });

  it('fails an editing host that serves pages from a cached render', async () => {
    const checks = createPlatforms({
      sitecore: {
        ...SITECORE_DEFAULTS,
        fetch: (async () =>
          new Response('', { status: 200, headers: { 'x-vercel-cache': 'HIT' } })) as typeof fetch,
      },
    }).get('sitecoreai')!.checks!;
    const bp = { collections: { pages: [{ key: 'home', name: 'Home', attrs: { path: '/' } }] } };
    const res = await checks['head.pages-render']!({
      ...ctx(tenant({}).read, bp),
      target: { ...target, hostingProject: 'Ansco-Site' },
    });
    expect(res.status).toBe('fail');
    expect(res.detail).toContain('served from a cached render');
    expect(res.detail).toContain('SITECORE_RENDER_ON_REQUEST=true');
  });

  it('fails pages whose header or footer slot renders empty on the editing host', async () => {
    const page = (header: string) =>
      `<header><div id="header">${header}</div></header><main></main><footer><div id="footer"><nav>links</nav></div></footer>`;
    let html = page('');
    const checks = createPlatforms({
      sitecore: {
        ...SITECORE_DEFAULTS,
        fetch: (async () => new Response(html, { status: 200 })) as typeof fetch,
      },
    }).get('sitecoreai')!.checks!;
    const run = () =>
      checks['head.header-footer']!({
        ...ctx(tenant({}).read, null),
        target: { ...target, hostingProject: 'ansco-site' },
      });
    const res = await run();
    expect(res.status).toBe('fail');
    expect(res.detail).toContain('/ has no header');
    expect(res.detail).not.toContain('no footer');
    html = page('<nav class="SiteHeader">Home</nav>');
    expect((await run()).status).toBe('pass');
  });

  it('checks the header and footer on pages that exist, skipping ones not migrated yet', async () => {
    const page =
      '<header><div id="header"><nav>Home</nav></div></header><footer><div id="footer"><nav>links</nav></div></footer>';
    let home = 200;
    const checks = createPlatforms({
      sitecore: {
        ...SITECORE_DEFAULTS,
        fetch: (async (url: string | URL | Request) =>
          String(url).endsWith('.app/')
            ? new Response(page, { status: home })
            : new Response('', { status: 404 })) as typeof fetch,
      },
    }).get('sitecoreai')!.checks!;
    const bp = {
      collections: {
        pages: ['about', 'safety'].map((k) => ({ key: k, name: k, attrs: { path: `/${k}` } })),
      },
    };
    const run = () =>
      checks['head.header-footer']!({
        ...ctx(tenant({}).read, bp),
        target: { ...target, hostingProject: 'lambert-cable' },
      });
    expect(await run()).toEqual({
      status: 'pass',
      detail:
        'The header and footer render on 1 page of https://lambert-cable-editing.vercel.app; /about, /safety not created yet.',
    });
    home = 404;
    const res = await run();
    expect(res.status).toBe('fail');
    expect(res.detail).toContain('/ answered 404');
  });

  it('compares each rendered page with its source: text, headings, items, placeholders, header', async () => {
    const rsc = (fields: unknown) =>
      `<script>self.__next_f.push([1,${JSON.stringify(JSON.stringify({ componentName: 'CardGrid', fields }))}])</script>`;
    const pages: Record<string, string> = {
      'https://src.example/about/':
        '<h1>About Ansco</h1><h2>Our Services</h2><p>Telecommunications engineering construction wireless splicing</p>',
      'https://ansco-site-editing.vercel.app/about': `<header><div id="header"><nav>Home</nav></div></header><h1>About Ansco</h1><p>Section heading</p>${rsc({ heading: { value: 'x' } })}<footer><div id="footer"></div></footer>`,
    };
    const checks = createPlatforms({
      sitecore: {
        ...SITECORE_DEFAULTS,
        fetch: (async (url: string | URL | Request) =>
          new Response(pages[String(url)] ?? '', {
            status: pages[String(url)] ? 200 : 404,
          })) as typeof fetch,
      },
    }).get('sitecoreai')!.checks!;
    const bp = {
      collections: {
        pages: [{ key: 'about', name: 'About', attrs: { path: '/about' } }],
        components: [
          {
            key: 'cards',
            name: 'Card Grid',
            attrs: { rendering: 'CardGrid', children: { max: 8 } },
          },
        ],
      },
    };
    const run = () =>
      checks['parity.render']!({
        ...ctx(tenant({}).read, bp),
        target: { ...target, hostingProject: 'ansco-site' },
        document: async (id: string) =>
          id === 'page-inventory' ? { origin: 'https://src.example' } : null,
      });
    const res = await run();
    expect(res.status).toBe('fail');
    expect(res.detail).toContain('/about has no footer');
    expect(res.detail).toContain('placeholder copy: "Section heading"');
    expect(res.detail).toContain('/about: CardGrid renders no items');
    expect(res.detail).toMatch(/shows \d+% of the source page's text/);
    expect(res.detail).toContain('missing headings: Our Services');

    pages['https://ansco-site-editing.vercel.app/about'] =
      `<header><div id="header"><nav>Home</nav></div></header><h1>About Ansco</h1><h2>Our Services</h2><p>Telecommunications engineering construction wireless splicing</p>${rsc({ data: { datasource: { children: { results: [{}] } } } })}<footer><div id="footer"><p>Ansco</p></div></footer>`;
    const ok = await run();
    expect(ok).toEqual({ status: 'pass', detail: 'Rendered parity with the source: /about 100%.' });
  });

  it('compares each page with the source as a visitor sees it, and names the differences', async () => {
    const bp = {
      collections: {
        pages: [
          { key: 'home', name: 'Home', attrs: { path: '/' } },
          { key: 'about', name: 'About', attrs: { path: '/about' } },
        ],
      },
    };
    const asked: unknown[] = [];
    const base = {
      ...ctx(tenant({}).read, bp),
      target: { ...target, hostingProject: 'Ansco-Site' },
      document: async (id: string) =>
        id === 'page-inventory' ? { origin: 'https://src.example/' } : null,
    };
    const check = pack.checks!['parity.visual']!;
    expect((await check(base)).status).toBe('pending');

    const res = await check({
      ...base,
      compareScreens: async (page) => {
        asked.push(page);
        return page.path === '/about'
          ? {
              verdict: 'differs',
              differences: [
                'Mission section: source shows three filled cards; new page shows empty white boxes',
              ],
              tokens: 10,
            }
          : { verdict: 'match', differences: [], tokens: 10 };
      },
    });
    expect(asked).toEqual([
      {
        path: '/',
        source: 'https://src.example/',
        candidate: 'https://ansco-site-editing.vercel.app/',
      },
      {
        path: '/about',
        source: 'https://src.example/about/',
        candidate: 'https://ansco-site-editing.vercel.app/about',
      },
    ]);
    expect(res).toEqual({
      status: 'fail',
      detail:
        "/about doesn't look like the source: Mission section: source shows three filled cards; new page shows empty white boxes.",
    });

    const ok = await check({
      ...base,
      compareScreens: async (page) =>
        page.path === '/about'
          ? { error: 'no screenshot' }
          : { verdict: 'match', differences: [], tokens: 10 },
    });
    expect(ok).toEqual({
      status: 'pass',
      detail:
        "1 page looks like the source on https://ansco-site-editing.vercel.app; 1 couldn't be compared.",
    });
  });

  it('requires a Component Query on every rendering whose component lists child items', async () => {
    const r = '/sitecore/layout/Renderings/Project/Brands/ansco';
    const items: Record<string, { id?: string; fields?: Record<string, string> }> = {
      [r]: {},
      [`${r}/CardGrid`]: { id: '{C1}', fields: {} },
      [`${r}/Hero`]: { id: '{H1}' },
    };
    const bp = {
      collections: {
        components: [
          {
            key: 'cards',
            name: 'Card Grid',
            attrs: { rendering: 'CardGrid', children: { max: 8 } },
          },
          { key: 'hero', name: 'Hero', attrs: { rendering: 'Hero' } },
        ],
      },
    };
    const res = await pack.checks!['structural.component-queries']!(ctx(tenant(items).read, bp));
    expect(res.status).toBe('fail');
    expect(res.detail).toContain(
      'CardGrid lists child items but its rendering has no Component Query',
    );
    items[`${r}/CardGrid`]!.fields = {
      ComponentQuery:
        'query { datasource: item(path: $datasource) { children(first: 8) { results { id } } } }',
    };
    expect(
      (await pack.checks!['structural.component-queries']!(ctx(tenant(items).read, bp))).status,
    ).toBe('pass');
    // No `first`: the default page, as nested children must be read to stay under Edge's limit.
    items[`${r}/CardGrid`]!.fields = {
      ComponentQuery:
        'query { datasource: item(path: $datasource) { children { results { id children { results { id } } } } } }',
    };
    expect(
      (await pack.checks!['structural.component-queries']!(ctx(tenant(items).read, bp))).status,
    ).toBe('pass');
    items[`${r}/CardGrid`]!.fields = {
      ComponentQuery:
        'query { datasource: item(path: $datasource) { title: field(name: "title") { jsonValue } } }',
    };
    expect(
      (await pack.checks!['structural.component-queries']!(ctx(tenant(items).read, bp))).detail,
    ).toContain("CardGrid's Component Query doesn't read the datasource's children");
  });

  it("checks the site, Home and the project's own folders", async () => {
    const site = '/sitecore/content/Brands/ansco';
    const t = tenant({
      [site]: {},
      [`${site}/Home`]: {},
      '/sitecore/templates/Project/Brands/ansco': {},
      '/sitecore/layout/Renderings/Project/Brands/ansco': {},
    });
    const res = await pack.checks!['structural.site']!(ctx(t.read, null));
    expect(res).toEqual({
      status: 'fail',
      detail: "/sitecore/media library/Project/Brands/ansco doesn't exist.",
    });
  });

  it('leaves Experience Edge checks pending without a live Context ID', async () => {
    const res = await pack.checks!['routes.resolve']!(ctx(tenant({}).read, null));
    expect(res.status).toBe('pending');
  });

  it('measures content parity on Experience Edge against the source re-crawl', async () => {
    const layouts: Record<string, unknown> = {
      '/': {
        sitecore: {
          route: {
            fields: { Title: { value: 'Ansco' } },
            placeholders: {
              main: [{ fields: { Text: { value: '<p>one two three four five</p>' } } }],
            },
          },
        },
      },
      '/about': { sitecore: { route: { fields: { Title: { value: 'Elsewhere' } } } } },
    };
    const edge = (async (_u: string | URL | Request, init?: RequestInit) => {
      const { variables } = JSON.parse(String(init!.body)) as { variables: { path: string } };
      const rendered = layouts[variables.path];
      return new Response(
        JSON.stringify({ data: { layout: rendered ? { item: { rendered } } : null } }),
      );
    }) as typeof fetch;
    const p = createPlatforms({ sitecore: { ...SITECORE_DEFAULTS, fetch: edge } }).get(
      'sitecoreai',
    )!;
    const res = await p.checks!['parity.page']!({
      projectId: 'p',
      target,
      scope: { collection: null, items: [] },
      blueprint: {
        collections: {
          pages: [
            { key: 'home', name: 'Home', attrs: { path: '/' } },
            { key: 'about', name: 'About', attrs: { path: '/about' } },
            { key: 'gone', name: 'Gone', status: 'drop', attrs: { path: '/gone' } },
          ],
        },
      },
      read: async () => ({ code: 404, body: {} }),
      credential: async () => ({ contextId: 'ctx-preview' }),
      document: async (id) =>
        id === 'parity-inventory'
          ? {
              pages: [
                { path: '/', title: 'Ansco | Home', words: 5 },
                { path: '/about', title: 'About us', words: 40 },
                { path: '/gone', title: 'Gone', words: 10 },
              ],
            }
          : null,
    });
    expect(res.status).toBe('fail');
    expect(res.data).toMatchObject({
      parity: 50,
      pages: [
        { path: '/', ok: true, targetWords: 6 },
        { path: '/about', ok: false, problem: 'title not found' },
      ],
    });
  });
});
