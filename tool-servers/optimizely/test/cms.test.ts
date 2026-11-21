import { MemoryBlobStore } from '@lw/tool-gateway';
import { describe, expect, it } from 'vitest';
import {
  OptimizelyCmsToolServer,
  ROOT_CONTAINER,
  applicationKey,
  contentRef,
  keyForPath,
  type OptimizelyFacts,
} from '../src';
import { fakeCms } from './fake';

const facts: OptimizelyFacts = {
  cmsUrl: 'https://app-acme.cms.optimizely.com',
  application: 'acme_site',
  applicationName: 'Acme Site',
  typePrefix: 'Acme',
  languages: ['en'],
  sourceHosts: ['www.acme.com'],
  headHosts: ['acme.vercel.app', 'acme-editing.vercel.app', 'www.acme.com'],
};
const ctx = { projectId: 'p', token: 'jwt', role: 'content-migrator', taskId: 't' };
const TYPES = { AcmeExperience: '_experience', AcmeHero: '_component', AcmeHeader: '_component' };
const key = (path: string) => keyForPath(facts.cmsUrl, path);

const setup = async (opts: Parameters<typeof fakeCms>[0] = {}) => {
  const cms = fakeCms({ types: TYPES, ...opts });
  const blobs = new MemoryBlobStore();
  const server = new OptimizelyCmsToolServer({ facts: async () => facts, fetch: cms.fetch, blobs });
  const call = (op: string, args: Record<string, unknown> = {}) => server.call(op, args, ctx);
  return { cms, server, call, blobs };
};
const withApp = async (opts: Parameters<typeof fakeCms>[0] = {}) => {
  const s = await setup(opts);
  expect((await s.call('application.create', { entryType: 'AcmeExperience' })).code).toBe(201);
  return s;
};

describe('keys and names', () => {
  it('derives an application key the API accepts', () => {
    expect(applicationKey('Acme Site')).toBe('Acme_Site');
    expect(applicationKey('microsoft-demo')).toBe('microsoft_demo');
    expect(applicationKey('2024 site')).toBe('_2024_site');
  });

  it('gives one path one key, whatever its case or trailing slash', () => {
    expect(key('/shared/acme_site/Site Header')).toBe(key('/shared/ACME_SITE/site header/'));
    expect(key('/shared/acme_site/Site Header')).toMatch(/^[0-9a-f]{32}$/);
    expect(key('/shared/acme_site/Site Header')).not.toBe(key('/shared/acme_site/Site Footer'));
  });

  it('marks what changes, releases and reads', async () => {
    const { server } = await setup();
    expect(server.catalog['content.read']).toMatchObject({ mutates: false, pathArgs: ['path'] });
    expect(server.catalog['content.create']).toMatchObject({ mutates: true, pathArgs: ['path'] });
    expect(server.catalog['content.publish']).toMatchObject({ releases: true });
    expect(server.catalog['hostname.add']).toMatchObject({ releases: true });
    expect(Object.values(server.catalog).some((o) => o.destructive)).toBe(false);
  });
});

describe('the application', () => {
  it('is created with its start page and assets of its own, once', async () => {
    const { cms, call } = await setup();
    const made = await call('application.create', { entryType: 'AcmeExperience' });
    expect(made).toMatchObject({ code: 201, body: { key: 'acme_site', created: true } });
    const start = cms.content.get(key('/content/acme_site'))!;
    expect(start.node).toMatchObject({ container: ROOT_CONTAINER, contentType: 'AcmeExperience' });
    expect(start.versions[0]).toMatchObject({
      locale: 'en',
      displayName: 'Acme Site',
      routeSegment: 'acme-site',
    });
    expect(cms.applications.get('acme_site')).toMatchObject({
      entryPoint: contentRef(key('/content/acme_site')),
      useApplicationSpecificAssets: true,
      usePreviewTokens: true,
    });
    expect(await call('application.create', { entryType: 'AcmeExperience' })).toMatchObject({
      code: 200,
      body: { created: false },
    });
    expect(cms.applications.size).toBe(1);
  });

  it("refuses a start page of another team's type, or one not pushed yet", async () => {
    const { call } = await setup();
    expect(await call('application.create', { entryType: 'BlankExperience' })).toMatchObject({
      code: 422,
    });
    const missing = await call('application.create', { entryType: 'AcmeLanding' });
    expect(missing.code).toBe(422);
    expect(JSON.stringify(missing.body)).toContain('push the content model first');
    expect((await call('application.create', { entryType: 'AcmeHero' })).code).toBe(422);
  });

  it('says who can fix it when the API key has no content rights', async () => {
    const { call } = await setup({ denyContent: true });
    const r = await call('application.create', { entryType: 'AcmeExperience' });
    expect(r.code).toBe(403);
    expect(JSON.stringify(r.body)).toContain('Set Access Rights');
  });

  it('takes only hosts the head is deployed on: one primary, one preview', async () => {
    const { cms, call } = await withApp();
    const hosts = () => cms.applications.get('acme_site')!.hosts;
    expect((await call('hostname.add', { host: 'evil.example.com' })).code).toBe(422);
    // Graph has no routes without a primary host: the preview host comes second.
    expect(
      (await call('hostname.add', { host: 'acme-editing.vercel.app', use: 'preview' })).code,
    ).toBe(409);
    expect(await call('hostname.add', { host: 'acme.vercel.app' })).toMatchObject({ code: 200 });
    expect(hosts()).toEqual([
      { authority: 'acme.vercel.app', type: 'primary', preferredUrlScheme: 'https' },
    ]);
    const patches = () => cms.calls.filter((c) => c.method === 'PATCH').length;
    const before = patches();
    await call('hostname.add', { host: 'acme.vercel.app' });
    expect(patches()).toBe(before);
    const preview = await call('hostname.add', { host: 'acme-editing.vercel.app', use: 'preview' });
    expect(preview.summary).toBe('acme-editing.vercel.app is now the preview host of acme_site');
    expect(hosts()).toEqual([
      { authority: 'acme.vercel.app', type: 'primary', preferredUrlScheme: 'https' },
      { authority: 'acme-editing.vercel.app', type: 'preview', preferredUrlScheme: 'https' },
    ]);
    // A new primary replaces the one before; the preview host stays.
    const moved = await call('hostname.add', { host: 'www.acme.com' });
    expect(moved.summary).toContain('it was acme.vercel.app');
    expect(hosts()).toEqual([
      { authority: 'acme-editing.vercel.app', type: 'preview', preferredUrlScheme: 'https' },
      { authority: 'www.acme.com', type: 'primary', preferredUrlScheme: 'https' },
    ]);
    await call('hostname.remove', { host: 'acme-editing.vercel.app' });
    expect(hosts()).toEqual([
      { authority: 'www.acme.com', type: 'primary', preferredUrlScheme: 'https' },
    ]);
  });

  it("points live preview at the head's preview route", async () => {
    const { cms, call } = await withApp();
    await call('preview.configure', {});
    expect(cms.applications.get('acme_site')!.previewUrlFormats).toEqual({
      any: '{host}/preview?key={key}&ver={version}&loc={locale}&ctx={context}',
    });
  });
});

describe('content', () => {
  it('creates a shared block in the application’s assets, folders on the way', async () => {
    const { cms, call } = await withApp();
    const r = await call('content.create', {
      path: '/shared/acme_site/Site Header',
      contentType: 'AcmeHeader',
      properties: {
        searchLabel: 'Search',
        logo: '/media/acme_site/Brand/logo.png',
        cart: { url: 'https://www.acme.com/cart', text: 'Cart' },
        links: [{ contentType: 'AcmeHero', properties: { heading: 'One' } }],
      },
    });
    const headerKey = key('/shared/acme_site/Site Header');
    expect(r).toMatchObject({
      code: 201,
      body: { key: headerKey, ref: contentRef(headerKey), created: true },
    });
    const header = cms.content.get(headerKey)!;
    const folder = cms.content.get(String(header.node.container))!;
    expect(folder.node).toMatchObject({
      contentType: 'SysContentFolder',
      container: 'a'.repeat(32),
    });
    expect(folder.versions[0]).toMatchObject({ displayName: 'Shared' });
    expect(header.versions[0]!.properties).toEqual({
      searchLabel: { value: 'Search' },
      logo: { value: contentRef(key('/media/acme_site/Brand/logo.png')) },
      cart: { value: { url: 'https://www.acme.com/cart', text: 'Cart' } },
      // An item of a list names no type: the list's content type says what it is.
      links: { value: [{ properties: { heading: { value: 'One' } } }] },
    });
    // A block has no route.
    expect(header.versions[0]).not.toHaveProperty('routeSegment');
  });

  it('changes the draft in place when the path exists, and starts a new one only once published', async () => {
    const { cms, call } = await withApp();
    const args = {
      path: '/shared/acme_site/Site Header',
      contentType: 'AcmeHeader',
      properties: { a: '1' },
    };
    await call('content.create', args);
    const again = await call('content.create', { ...args, properties: { b: '2' } });
    expect(again).toMatchObject({ code: 200, body: { created: false, version: '1' } });
    const item = cms.content.get(key('/shared/acme_site/Site Header'))!;
    // One draft, never two: an editor opens the draft, and a stale one hides the real page.
    expect(item.versions).toHaveLength(1);
    expect(item.versions[0]!.properties).toEqual({ a: { value: '1' }, b: { value: '2' } });
    await call('content.publish', args);
    await call('content.update', { path: args.path, properties: { c: '3' } });
    expect(item.versions.map((v) => v.status)).toEqual(['published', 'draft']);
    expect(item.versions[1]!.properties).toEqual({
      a: { value: '1' },
      b: { value: '2' },
      c: { value: '3' },
    });
    expect((await call('content.create', { ...args, contentType: 'AcmeHero' })).code).toBe(409);
  });

  it("stays inside the project's application and its own types", async () => {
    const { cms, call } = await withApp();
    const before = cms.content.size;
    expect(
      (await call('content.create', { path: '/content/other_site/x', contentType: 'AcmeHero' }))
        .code,
    ).toBe(403);
    expect(
      (await call('content.create', { path: '/shared/acme_site/x', contentType: 'HeroBlock' }))
        .code,
    ).toBe(422);
    expect(
      (
        await call('content.create', {
          path: '/shared/acme_site/x',
          contentType: 'AcmeHero',
          properties: { image: '/media/other_site/a.png' },
        })
      ).code,
    ).toBe(403);
    expect(
      (
        await call('content.create', {
          path: '/shared/acme_site/x',
          contentType: 'AcmeHero',
          properties: { cards: [{ contentType: 'TheirCard', properties: {} }] },
        })
      ).code,
    ).toBe(422);
    expect(
      (await call('content.create', { path: '/content/acme_site', contentType: 'AcmeExperience' }))
        .code,
    ).toBe(422);
    expect(
      (
        await call('content.create', {
          path: '/content/acme_site/a/b',
          contentType: 'AcmeExperience',
        })
      ).code,
    ).toBe(409);
    expect(cms.content.size).toBe(before);
  });

  it('composes the start page, keeping its properties and stable section ids', async () => {
    const { cms, call } = await withApp();
    await call('content.update', { path: '/content/acme_site', properties: { metaTitle: 'Acme' } });
    const nodes = [
      {
        name: 'Hero',
        contentType: 'AcmeHero',
        displayTemplate: 'AcmeHeroDefault',
        settings: { tone: 'navy' },
        properties: { heading: 'Hi' },
      },
      { name: 'Second hero', contentType: 'AcmeHero', properties: { heading: 'Again' } },
    ];
    const r = await call('composition.write', { path: '/content/acme_site', nodes });
    expect(r).toMatchObject({ code: 200, body: { status: 'draft' } });
    const start = cms.content.get(key('/content/acme_site'))!;
    const latest = start.versions[start.versions.length - 1] as {
      properties: unknown;
      composition: { nodeType: string; layoutType: string; nodes: Record<string, unknown>[] };
    };
    expect(latest.properties).toEqual({ metaTitle: { value: 'Acme' } });
    expect(latest.composition).toMatchObject({ nodeType: 'experience', layoutType: 'outline' });
    expect(latest.composition.nodes[0]).toMatchObject({
      displayName: 'Hero',
      nodeType: 'component',
      displaySettings: { displayTemplate: 'AcmeHeroDefault', settings: { tone: 'navy' } },
      component: { contentType: 'AcmeHero', properties: { heading: { value: 'Hi' } } },
    });
    expect(latest.composition.nodes[1]).not.toHaveProperty('displaySettings');
    // The empty start page application.create made is the one draft, filled in place.
    expect(start.versions).toHaveLength(1);
    const firstIds = latest.composition.nodes.map((n) => n.id);
    await call('composition.write', { path: '/content/acme_site', nodes });
    const after = start.versions[start.versions.length - 1] as typeof latest;
    expect(after.composition.nodes.map((n) => n.id)).toEqual(firstIds);
    expect(
      (
        await call('composition.write', {
          path: '/content/acme_site',
          nodes: [{ name: 'x', contentType: 'Teaser' }],
        })
      ).code,
    ).toBe(422);
  });

  it('publishes the latest draft, and says so when there is nothing new', async () => {
    const { cms, call } = await withApp();
    const first = await call('content.publish', { path: '/content/acme_site' });
    expect(first).toMatchObject({ code: 200, body: { status: 'published', version: '1' } });
    const publishes = () => cms.calls.filter((c) => c.path.endsWith(':publish')).length;
    expect(publishes()).toBe(1);
    const again = await call('content.publish', { path: '/content/acme_site' });
    expect(again.summary).toContain('already published');
    expect(publishes()).toBe(1);
    expect((await call('content.publish', { path: '/content/acme_site/missing' })).code).toBe(404);
  });

  it('says what each route is composed of, named as the Blueprint names components', async () => {
    const { call } = await withApp();
    await call('composition.write', {
      path: '/content/acme_site',
      nodes: [
        {
          name: 'Welcome',
          contentType: 'AcmeHero',
          properties: {
            heading: 'Hello there',
            image: '/media/acme_site/a.png',
            body: { html: '<p>Body <b>copy</b></p>' },
            cards: [
              {
                properties: {
                  heading: 'Card one',
                  link: { url: 'https://x.example/', text: 'Go' },
                },
              },
            ],
          },
        },
      ],
    });
    const r = await call('page.components', { paths: ['/', '/missing'] });
    expect(r).toMatchObject({
      code: 200,
      body: {
        pages: [
          {
            path: '/',
            components: [
              {
                component: 'Hero',
                placeholder: 'Welcome',
                text: 'Hello there Body copy Card one Go',
              },
            ],
          },
          { path: '/missing', components: null },
        ],
      },
    });
  });

  it('gives the addresses Visual Builder opens, once the application has a host', async () => {
    const { call } = await withApp();
    expect((await call('content.previews', { path: '/content/acme_site' })).code).toBe(404);
    await call('hostname.add', { host: 'acme.vercel.app' });
    const r = await call('content.previews', { path: '/content/acme_site' });
    expect(r).toMatchObject({ code: 200, body: { version: '1', status: 'draft' } });
    const { preview, edit } = r.body as { preview: string; edit: string };
    expect(preview).toContain('https://acme.vercel.app/preview?key=');
    expect(preview).toContain('ctx=preview');
    expect(edit).toBe(preview.replace('ctx=preview', 'ctx=edit'));
  });

  it('reads an item back as plain values', async () => {
    const { call } = await withApp();
    await call('composition.write', {
      path: '/content/acme_site',
      nodes: [
        {
          name: 'Hero',
          contentType: 'AcmeHero',
          displayTemplate: 'AcmeHeroDefault',
          properties: { heading: 'Hi' },
        },
      ],
    });
    const r = await call('content.read', { path: '/content/acme_site', children: true });
    expect(r).toMatchObject({
      code: 200,
      body: {
        path: '/content/acme_site',
        contentType: 'AcmeExperience',
        status: 'draft',
        composition: [
          {
            name: 'Hero',
            contentType: 'AcmeHero',
            displayTemplate: 'AcmeHeroDefault',
            properties: { heading: 'Hi' },
          },
        ],
        children: [],
      },
    });
    expect((await call('content.read', { path: '/content/acme_site/nope' })).code).toBe(404);
    expect((await call('content.read', {})).code).toBe(422);
  });

  it('creates a blueprint, and updates it when asked again', async () => {
    const { cms, call } = await withApp();
    const args = {
      name: 'Landing page',
      contentType: 'AcmeExperience',
      nodes: [{ name: 'Hero', contentType: 'AcmeHero' }],
    };
    expect(await call('blueprint.create', args)).toMatchObject({
      code: 201,
      body: { created: true },
    });
    expect(await call('blueprint.create', args)).toMatchObject({
      code: 200,
      body: { created: false },
    });
    expect(cms.blueprints.size).toBe(1);
    const [stored] = [...cms.blueprints.keys()];
    expect(stored).toMatch(/^[0-9a-f]{32}$/);
    expect((await call('blueprint.create', { ...args, contentType: 'BlankExperience' })).code).toBe(
      422,
    );
  });
});

describe('media', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const AVIF = new Uint8Array([
    0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0, 0,
  ]);

  it('uploads a stored file with its alt text, names it by its bytes, and publishes it', async () => {
    const { cms, call, blobs } = await withApp();
    const ref = await blobs.put('p', 'assets/hero.bin', PNG);
    const r = await call('media.upload', {
      path: '/media/acme_site/Home/hero.jpg',
      ref,
      alt: 'A hero',
    });
    const k = key('/media/acme_site/Home/hero.png');
    expect(r).toMatchObject({
      code: 201,
      body: {
        path: '/media/acme_site/Home/hero.png',
        key: k,
        ref: contentRef(k),
        fileName: 'hero.png',
        uploaded: true,
      },
    });
    expect(cms.uploads).toEqual([{ name: 'hero.png', type: 'image/png', bytes: PNG.length }]);
    const item = cms.content.get(k)!;
    expect(item.node.contentType).toBe('ImageMedia');
    expect(item.versions[0]).toMatchObject({
      status: 'published',
      properties: { AltText: { value: 'A hero' } },
    });
    // Media/Home under the application's assets.
    const home = cms.content.get(String(item.node.container))!;
    expect(home.versions[0]).toMatchObject({ displayName: 'Home' });
    expect(cms.content.get(String(home.node.container))!.versions[0]).toMatchObject({
      displayName: 'Media',
    });
    expect(
      await call('media.upload', { path: '/media/acme_site/Home/hero.png', ref }),
    ).toMatchObject({
      code: 200,
      body: { uploaded: false },
    });
    expect(cms.uploads).toHaveLength(1);
  });

  it('wants alt text with an upload, and gives it to an image that is already there', async () => {
    const { cms, call, blobs } = await withApp();
    const ref = await blobs.put('p', 'assets/icon.bin', PNG);
    const path = '/media/acme_site/icons/icon.png';
    const none = await call('media.upload', { path, ref });
    expect(none.code).toBe(422);
    expect(JSON.stringify(none.body)).toContain('Give `alt`');
    expect(cms.uploads).toHaveLength(0);
    await call('media.upload', { path, ref, alt: 'An icon' });
    const item = cms.content.get(key(path))!;
    // The same words again change nothing.
    const same = await call('media.upload', { path, ref, alt: 'An icon' });
    expect(same).toMatchObject({ code: 200, body: { uploaded: false, alt: 'An icon' } });
    expect(item.versions).toHaveLength(1);
    // Other words: a new published version of the same file, never a second upload.
    const set = await call('media.upload', { path, ref, alt: 'A laptop icon' });
    expect(set).toMatchObject({ code: 200, body: { uploaded: false, altSet: true } });
    expect(set.summary).toContain('its alt text is now "A laptop icon"');
    expect(item.versions.at(-1)).toMatchObject({
      status: 'published',
      properties: { AltText: { value: 'A laptop icon' } },
    });
    expect(cms.uploads).toHaveLength(1);
  });

  it('refuses AVIF, files of other projects and hosts that are not the source', async () => {
    const { cms, call, blobs } = await withApp();
    const avif = await blobs.put('p', 'assets/a.avif', AVIF);
    const r = await call('media.upload', { path: '/media/acme_site/a.avif', ref: avif });
    expect(r.code).toBe(422);
    expect(JSON.stringify(r.body)).toContain('WebP, PNG or JPEG');
    expect(
      (
        await call('media.upload', {
          path: '/media/acme_site/a.png',
          ref: 'blob://other/assets/a.png',
        })
      ).code,
    ).toBe(422);
    expect(
      (
        await call('media.upload', {
          path: '/media/acme_site/a.png',
          sourceUrl: 'https://elsewhere.example/a.png',
        })
      ).code,
    ).toBe(422);
    expect((await call('media.upload', { path: '/media/other_site/a.png', ref: avif })).code).toBe(
      403,
    );
    expect(cms.uploads).toHaveLength(0);
  });
});
