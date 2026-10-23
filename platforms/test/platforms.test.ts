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
  const ctx = (read: ReturnType<typeof tenant>['read'], blueprint: unknown) => ({
    projectId: 'p',
    target,
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
    expect(res.detail).toBe("Cards isn't in Available Renderings.");
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
