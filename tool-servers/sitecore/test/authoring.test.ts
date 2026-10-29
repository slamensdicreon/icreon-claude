import { describe, expect, it } from 'vitest';
import { SitecoreAuthoringToolServer } from '../src';

const facts = {
  cmHost: 'xmc-acme.sitecorecloud.io',
  siteCollection: 'Brands',
  site: 'ansco',
  languages: ['en'],
  sourceHosts: ['www.acme.com'],
};
const ctx = { projectId: 'p', token: 'jwt', role: 'tenant-provisioner', taskId: 't' };

/**
 * A CM that remembers what is created and updated. `drop` makes the next mutation succeed but
 * lose its response (a timeout); `ignore` makes it fail silently (stored values unchanged).
 */
const INHERITED = new Set(['Datasource Template', 'Renderings']);

function fakeCm(
  items: Record<string, string>,
  opts: { drop?: boolean; ignoreUpdate?: boolean } = {},
) {
  const queries: string[] = [];
  const values = new Map<string, Map<string, string>>();
  const fieldsOf = (q: string) =>
    new Map(
      [...q.matchAll(/\{ name: "([^"]+)", value: "((?:[^"\\]|\\.)*)" \}/g)].map((m) => [
        m[1]!,
        JSON.parse(`"${m[2]}"`) as string,
      ]),
    );
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe(
      'https://xmc-acme.sitecorecloud.io/sitecore/api/authoring/graphql/v1/',
    );
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer jwt');
    const { query } = JSON.parse(String(init!.body)) as { query: string };
    queries.push(query);
    const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
    const lost = () => {
      opts.drop = false;
      throw new TypeError('fetch failed');
    };
    if (/sites \{/.test(query))
      return ok({ sites: [{ name: 'ansco', rootPath: '/sitecore/content/Brands/ansco' }] });
    if (/createItem\(/.test(query)) {
      const name = /name: "([^"]+)"/.exec(query)![1]!;
      const parentId = /parent: "([^"]+)"/.exec(query)![1]!;
      const parentPath = Object.keys(items).find((k) => items[k] === parentId)!;
      const path = `${parentPath}/${name}`;
      items[path] = `id-${name}`;
      values.set(path, fieldsOf(query));
      if (opts.drop) lost();
      return ok({ createItem: { item: { itemId: items[path], path } } });
    }
    if (/renameItem\(/.test(query)) {
      const id = /itemId: "([^"]+)"/.exec(query)![1]!;
      const name = /newName: "([^"]+)"/.exec(query)![1]!;
      const from = Object.keys(items).find((k) => items[k] === id)!;
      const to = `${from.slice(0, from.lastIndexOf('/'))}/${name}`;
      items[to] = id;
      delete items[from];
      values.set(to, values.get(from) ?? new Map());
      return ok({ renameItem: { item: { itemId: id } } });
    }
    if (/configurePageDesigns\(/.test(query)) {
      // As Sitecore stores it: URL-encoded, the design IDs encoded twice.
      const pairs = [...query.matchAll(/templateId: "([^"]+)", pageDesignId: "([^"]+)"/g)];
      const value = pairs
        .map(([, t, d]) => `%7b${t!.slice(1, -1)}%7d%3d%257B${d!.slice(1, -1)}%257D`)
        .join('%26');
      const at = Object.keys(items).find((k) => k.endsWith('/Page Designs'))!;
      if (!opts.ignoreUpdate) values.set(at, new Map([['TemplatesMapping', value]]));
      return ok({ configurePageDesigns: true });
    }
    if (/updateItem\(/.test(query)) {
      const path = /path: "([^"]+)"/.exec(query)![1]!;
      // As Sitecore does: IDs are stored uppercase, in braces.
      const stored = (v: string) =>
        /^\{?[0-9a-f-]{36}\}?(\|\{?[0-9a-f-]{36}\}?)*$/i.test(v)
          ? v
              .split('|')
              .map((g) => `{${g.replace(/[{}]/g, '').toUpperCase()}}`)
              .join('|')
          : v.startsWith('<r')
            ? // Layout: rewritten with uppercase IDs in braces, the s: prefix and its own ordering.
              v
                .replace(
                  /([a-z]+)="\{?([0-9a-f-]{36})\}?"/gi,
                  (_, a: string, g: string) => `s:${a}="{${g.toUpperCase()}}"`,
                )
                .replace(/ ph="([^"]*)"/g, ' s:ph="$1"')
                .replace(/\/>/g, ' s:uid="{00000000-0000-4000-8000-0000000000AA}" />')
            : v;
      if (!opts.ignoreUpdate) {
        if (!values.has(path)) values.set(path, new Map());
        for (const [k, v] of fieldsOf(query)) values.get(path)!.set(k, stored(v));
      }
      if (opts.drop) lost();
      return ok({ updateItem: { item: { itemId: items[path], name: 'n' } } });
    }
    const bare = (id: string) => id.replace(/[{}-]/g, '').toLowerCase();
    const byId = /where: \{ database: "master", itemId: "([^"]+)"/.exec(query)?.[1];
    const path = byId
      ? Object.keys(items).find((k) => bare(items[k]!) === bare(byId))
      : /path: "([^"]+)"/.exec(query)?.[1];
    if (/item\(where/.test(query)) {
      if (path && items[path]) {
        const stored = values.get(path) ?? new Map<string, string>();
        // Single fields by name, under the aliases asked for.
        const single = Object.fromEntries(
          [...query.matchAll(/(f\d+): field\(name: "([^"]+)"\) \{ value \}/g)].map((m) => [
            m[1]!,
            stored.has(m[2]!) ? { value: stored.get(m[2]!)! } : null,
          ]),
        );
        return ok({
          item: {
            itemId: items[path],
            name: 'n',
            path,
            ...single,
            fields: {
              // Fields from base templates come back only when inherited fields are asked for;
              // standard fields (__…) fall outside the first page of the list, as on a real item.
              nodes: [...stored]
                .filter(([name]) => !/ownFields: true/.test(query) || !INHERITED.has(name))
                .filter(([name]) => !name.startsWith('__'))
                .map(([name, value]) => ({ name, value })),
            },
          },
        });
      }
      return ok({ item: null });
    }
    return new Response(JSON.stringify({ errors: [{ message: 'nope' }] }), { status: 200 });
  }) as typeof globalThis.fetch;
  return { fetch, queries };
}

describe('SitecoreAuthoringToolServer', () => {
  it('confirms an existing site and lists sites', async () => {
    const cm = fakeCm({});
    const s = new SitecoreAuthoringToolServer({ facts: async () => facts, fetch: cm.fetch });
    expect(await s.call('site.verify', { collection: 'Brands', site: 'ansco' }, ctx)).toMatchObject(
      {
        code: 200,
        body: { exists: true },
      },
    );
    // No arguments: the project's own site, from intake.
    expect((await s.call('site.verify', {}, ctx)).code).toBe(200);
    expect((await s.call('site.verify', { collection: 'Brands', site: 'other' }, ctx)).code).toBe(
      409,
    );
    // A read under both names: audit entries from before the rename mustn't look like writes.
    expect(s.catalog['site.verify']!.mutates).toBe(false);
    expect(s.catalog['site.create']!.mutates).toBe(false);
  });

  it('resolves parent and template by path before creating an item', async () => {
    const cm = fakeCm({
      '/sitecore/content/Brands/ansco/Home': 'home-id',
      '/sitecore/templates/Project/Brands/Page': 'tpl-id',
    });
    const s = new SitecoreAuthoringToolServer({ facts: async () => facts, fetch: cm.fetch });
    const r = await s.call(
      'item.create',
      {
        parentPath: '/sitecore/content/Brands/ansco/Home',
        name: 'About',
        templatePath: '/sitecore/templates/Project/Brands/Page',
        fields: [{ name: 'Title', value: 'About "us"' }],
      },
      ctx,
    );
    expect(r.code).toBe(200);
    const create = cm.queries.find((q) => q.includes('createItem'))!;
    expect(create).toContain('templateId: "tpl-id"');
    expect(create).toContain('parent: "home-id"');
    expect(create).toContain('value: "About \\"us\\""');
  });

  it('reads every write back, reuses an existing item, and reconciles a dropped request', async () => {
    const home = '/sitecore/content/Brands/ansco/Home';
    const tpl = '/sitecore/templates/Project/Brands/Page';
    const create = {
      parentPath: home,
      name: 'Contact',
      templatePath: tpl,
      fields: [{ name: 'Title', value: 'Contact' }],
    };
    // The response is lost, but the item was created: read-back confirms it, nothing is redone.
    const cm = fakeCm({ [home]: 'home-id', [tpl]: 'tpl-id' }, { drop: true });
    const s = new SitecoreAuthoringToolServer({ facts: async () => facts, fetch: cm.fetch });
    const r = await s.call('item.create', create, ctx);
    expect(r).toMatchObject({ code: 200, body: { verified: true, reconciled: true } });
    // A second create finds it and doesn't duplicate it.
    const again = await s.call('item.create', create, ctx);
    expect(again).toMatchObject({ code: 200, body: { existed: true } });
    expect(cm.queries.filter((q) => q.includes('createItem'))).toHaveLength(1);

    // An update the CM silently ignored is caught by the read-back.
    const quiet = fakeCm({ [home]: 'home-id', [tpl]: 'tpl-id' }, { ignoreUpdate: true });
    const s2 = new SitecoreAuthoringToolServer({ facts: async () => facts, fetch: quiet.fetch });
    await s2.call('item.create', create, ctx);
    const u = await s2.call(
      'item.update',
      { path: `${home}/Contact`, fields: [{ name: 'Title', value: 'Talk to us' }] },
      ctx,
    );
    expect(u).toMatchObject({
      code: 409,
      body: { verified: false, mismatches: ['Title (reads "Contact")'] },
    });

    // Inherited fields read back, and IDs stored uppercase in braces match what was written.
    const cm3 = fakeCm({ [home]: 'home-id', [tpl]: 'tpl-id' });
    const s3 = new SitecoreAuthoringToolServer({ facts: async () => facts, fetch: cm3.fetch });
    await s3.call('item.create', create, ctx);
    const inherited = await s3.call(
      'item.update',
      {
        path: `${home}/Contact`,
        fields: [
          { name: 'Datasource Template', value: '/sitecore/templates/Project/Brands/ansco/Hero' },
          {
            name: 'Renderings',
            value: 'a1b2c3d4-0000-4000-8000-000000000001|{a1b2c3d4-0000-4000-8000-000000000002}',
          },
        ],
      },
      ctx,
    );
    expect(inherited).toMatchObject({ code: 200, body: { verified: true } });
    const read = await s3.call('item.read', { path: `${home}/Contact` }, ctx);
    expect(JSON.stringify(read.body)).toContain('Datasource Template');
    // Standard fields such as insert options are read by name.
    await s3.call(
      'item.update',
      {
        path: `${home}/Contact`,
        fields: [{ name: '__Masters', value: 'a1b2c3d4-0000-4000-8000-000000000003' }],
      },
      ctx,
    );
    // Layout is compared by what it means: Sitecore rewrites the XML it stores.
    const layout = (ds: string) =>
      `<r xmlns:xsd="http://www.w3.org/2001/XMLSchema"><d id="{fe5d7fdf-89c0-4d99-9aa3-b5fbd009c9f3}" l="{96e5f4ba-a2cf-4a4c-a4e7-64da88226362}"><r id="{a1b2c3d4-0000-4000-8000-000000000004}" ph="headless-main" ds="${ds}" /></d></r>`;
    const sv = await s3.call(
      'item.update',
      {
        path: `${home}/Contact`,
        fields: [{ name: '__Renderings', value: layout('local:/Data/Hero') }],
      },
      ctx,
    );
    expect(sv).toMatchObject({ code: 200, body: { verified: true } });
    expect(
      (
        await s3.call(
          'item.update',
          { path: `${home}/Contact`, fields: [{ name: '__Renderings', value: layout('') }] },
          ctx,
        )
      ).code,
    ).toBe(200);
    const masters = await s3.call(
      'item.read',
      { path: `${home}/Contact`, fields: ['__Masters', 'Nope'] },
      ctx,
    );
    expect(masters.body).toMatchObject({
      fields: { nodes: [{ name: '__Masters', value: '{A1B2C3D4-0000-4000-8000-000000000003}' }] },
      notOnItem: ['Nope'],
    });
  });

  it('adds IDs to the list as stored at the write, keeping what another task added', async () => {
    const group = '/sitecore/content/Brands/ansco/Presentation/Available Renderings/Ansco';
    const cm = fakeCm({ [group]: 'group-id' });
    const s = new SitecoreAuthoringToolServer({ facts: async () => facts, fetch: cm.fetch });
    const one = '{A1B2C3D4-0000-4000-8000-000000000001}';
    const two = 'a1b2c3d4-0000-4000-8000-000000000002';
    await s.call('item.update', { path: group, fields: [{ name: 'Renderings', value: one }] }, ctx);
    // Another registrar read the list before this write; adding keeps the ID written since.
    const r = await s.call(
      'item.update',
      { path: group, fields: [{ name: 'Renderings', value: two, add: true }] },
      ctx,
    );
    expect(r).toMatchObject({ code: 200, body: { verified: true } });
    const again = await s.call(
      'item.update',
      { path: group, fields: [{ name: 'Renderings', value: `{${two.toUpperCase()}}`, add: true }] },
      ctx,
    );
    expect(again.code).toBe(200);
    const read = await s.call('item.read', { path: group, fields: ['Renderings'] }, ctx);
    expect(read.body).toMatchObject({
      fields: {
        nodes: [{ name: 'Renderings', value: `${one}|{${two.toUpperCase()}}` }],
      },
    });
    const notIds = await s.call(
      'item.update',
      { path: group, fields: [{ name: 'Renderings', value: 'Hero', add: true }] },
      ctx,
    );
    expect(notIds.code).toBe(422);
  });

  it("stores a rendering's Parameters Template as the template's ID when given its path", async () => {
    const rendering = '/sitecore/layout/Renderings/Project/Brands/ansco/SnippetGrid';
    const params = '/sitecore/templates/Project/Brands/ansco/SnippetGrid Parameters';
    const cm = fakeCm({ [rendering]: 'r-id', [params]: '4b05bee0-d501-4c49-9053-4ee45fe3b11e' });
    const s = new SitecoreAuthoringToolServer({ facts: async () => facts, fetch: cm.fetch });
    const r = await s.call(
      'item.update',
      { path: rendering, fields: [{ name: 'Parameters Template', value: params }] },
      ctx,
    );
    expect(r.code).toBe(200);
    const update = cm.queries.find((q) => q.includes('updateItem'))!;
    expect(update).toContain('{4B05BEE0-D501-4C49-9053-4EE45FE3B11E}');
    expect(update).not.toContain('SnippetGrid Parameters');
  });

  it('renames an item, keeping its ID, and reads it back under the new name', async () => {
    const tpl = '/sitecore/templates/Project/Brands/ansco/Pages/Ansco Page';
    const cm = fakeCm({ [tpl]: 'tpl-id' });
    const s = new SitecoreAuthoringToolServer({ facts: async () => facts, fetch: cm.fetch });
    const r = await s.call('item.rename', { path: tpl, name: 'Corporate Page' }, ctx);
    expect(r).toMatchObject({
      code: 200,
      body: {
        itemId: 'tpl-id',
        path: '/sitecore/templates/Project/Brands/ansco/Pages/Corporate Page',
      },
    });
    expect((await s.call('item.rename', { path: tpl, name: 'a/b' }, ctx)).code).toBe(422);
  });

  it('maps page templates to page designs and reads the encoded mapping back', async () => {
    const designs = '/sitecore/content/Brands/ansco/Presentation/Page Designs';
    const tpl = '/sitecore/templates/Project/Brands/ansco/Pages/Corporate Page';
    const items = {
      [designs]: 'aaaaaaaabbbbccccddddeeeeeeeeeeee',
      [`${designs}/Default`]: '5f0f6f34b74849f38338f1aeacee43ee',
      [tpl]: 'c029d916f6ed4cba9bcb2c679fd14800',
    };
    const mappings = [{ templatePath: tpl, pageDesignPath: `${designs}/Default` }];
    const cm = fakeCm({ ...items });
    const s = new SitecoreAuthoringToolServer({ facts: async () => facts, fetch: cm.fetch });
    const r = await s.call('page-designs.map', { pageDesignsPath: designs, mappings }, ctx);
    expect(r).toMatchObject({ code: 200, body: { mapped: 1 } });
    expect(cm.queries.find((q) => q.includes('configurePageDesigns'))).toContain(
      'siteName: "ansco", mapping: [{ templateId: "{C029D916-F6ED-4CBA-9BCB-2C679FD14800}", pageDesignId: "{5F0F6F34-B748-49F3-8338-F1AEACEE43EE}" }]',
    );
    // A mapping that doesn't stick is reported, not called done.
    const lost = fakeCm({ ...items }, { ignoreUpdate: true });
    const s2 = new SitecoreAuthoringToolServer({ facts: async () => facts, fetch: lost.fetch });
    expect(
      (await s2.call('page-designs.map', { pageDesignsPath: designs, mappings }, ctx)).code,
    ).toBe(409);
    // Page designs come from the site's own Page Designs item.
    const elsewhere = [{ templatePath: tpl, pageDesignPath: '/sitecore/content/Other/Default' }];
    expect(
      (await s.call('page-designs.map', { pageDesignsPath: designs, mappings: elsewhere }, ctx))
        .code,
    ).toBe(422);
  });

  it('places components on a page from paths, with valid layout XML, and reads it back', async () => {
    const page = '/sitecore/content/Brands/ansco/Home/about';
    const hero = '/sitecore/layout/Renderings/Project/Brands/ansco/Hero Banner';
    const ds = `${page}/Data/Hero`;
    // The authoring API answers with IDs as 32 bare hex digits.
    const cm = fakeCm({
      [page]: 'page-id',
      [hero]: 'a1b2c3d40000400080000000000000aa',
      [ds]: 'a1b2c3d40000400080000000000000bb',
      '/sitecore/layout/Renderings/Project/Brands/ansco/Stats': 'a1b2c3d40000400080000000000000cc',
    });
    const s = new SitecoreAuthoringToolServer({ facts: async () => facts, fetch: cm.fetch });
    const r = await s.call(
      'layout.compose',
      {
        path: page,
        renderings: [
          { rendering: hero, placeholder: 'headless-main', datasource: ds },
          {
            rendering: '{A1B2C3D4-0000-4000-8000-0000000000CC}',
            placeholder: 'headless-main',
            parameters: { Styles: 'compact' },
          },
        ],
      },
      ctx,
    );
    expect(r).toMatchObject({ code: 200, body: { renderings: 2, verified: true } });
    const written = cm.queries.find((q) => q.includes('updateItem'))!;
    expect(written).toContain(
      'id=\\"{A1B2C3D4-0000-4000-8000-0000000000AA}\\" par=\\"\\" ph=\\"headless-main\\"',
    );
    expect(written).toContain('ds=\\"{A1B2C3D4-0000-4000-8000-0000000000BB}\\"');
    expect(written).toContain('par=\\"Styles=compact\\"');
    expect(written).toContain('{ name: \"__Final Renderings\", value: \"\" }');
    // An ID no item has is refused rather than written as a reference to nothing.
    const ghost = await s.call(
      'layout.compose',
      {
        path: page,
        renderings: [
          { rendering: 'ffffffff000040008000000000000000', placeholder: 'headless-main' },
        ],
      },
      ctx,
    );
    expect(ghost).toMatchObject({ code: 404 });
    // Hand-written XML with bare-hex IDs is written with IDs Sitecore can read.
    await s.call(
      'layout.compose',
      {
        path: page,
        renderingsXml:
          '<r><d id="{FE5D7FDF-89C0-4D99-9AA3-B5FBD009C9F3}" l="{96E5F4BA-A2CF-4A4C-A4E7-64DA88226362}"><r uid="{9a1c0000-0000-4000-8000-000000000001}" id="a1b2c3d40000400080000000000000aa" ph="headless-main" /></d></r>',
      },
      ctx,
    );
    expect(cm.queries.filter((q) => q.includes('updateItem')).at(-1)).toContain(
      'id=\\\"{A1B2C3D4-0000-4000-8000-0000000000AA}\\\"',
    );
    // Hand-written XML without rendering IDs is refused: Page builder would show nothing.
    const bare = await s.call(
      'layout.compose',
      {
        path: page,
        renderingsXml:
          '<r><d id="{FE5D7FDF-89C0-4D99-9AA3-B5FBD009C9F3}"><r uid="{1}" s="{2}" ph="headless-main" /></d></r>',
      },
      ctx,
    );
    expect(bare).toMatchObject({ code: 422 });
  });

  it('reads every child of a folder, not just the first page', async () => {
    const kids = Array.from({ length: 45 }, (_, i) => ({
      itemId: `id-${i}`,
      name: i === 44 ? 'Pages' : `Component${String(i).padStart(2, '0')}`,
      path: `/sitecore/templates/Project/Brands/ansco/${i === 44 ? 'Pages' : `Component${i}`}`,
      template: { name: i === 44 ? 'Template Folder' : 'Template' },
    }));
    const cm = (takesSize: boolean) => {
      const queries: string[] = [];
      const answer = (async (_: string | URL | Request, init?: RequestInit) => {
        const { query } = JSON.parse(String(init!.body)) as { query: string };
        queries.push(query);
        const sized = /children\(first: (\d+)\)/.exec(query);
        if (sized && !takesSize)
          return new Response(
            JSON.stringify({ errors: [{ message: 'Unknown argument "first"' }] }),
          );
        const item = {
          itemId: 'root',
          name: 'ansco',
          path: '/sitecore/templates/Project/Brands/ansco',
          fields: { nodes: [] },
          // The API's default page is 10.
          children: { nodes: kids.slice(0, sized ? Number(sized[1]) : 10) },
        };
        return new Response(JSON.stringify({ data: { item } }));
      }) as typeof globalThis.fetch;
      return { fetch: answer, queries };
    };
    const big = cm(true);
    const s = new SitecoreAuthoringToolServer({ facts: async () => facts, fetch: big.fetch });
    const r = await s.call(
      'item.read',
      { path: '/sitecore/templates/Project/Brands/ansco', children: true },
      ctx,
    );
    const names = (r.body as { children: { nodes: { name: string }[] } }).children.nodes;
    expect(names).toHaveLength(45);
    expect(names.at(-1)!.name).toBe('Pages');
    // An API that doesn't take a page size still answers, with its default page.
    const old = cm(false);
    const s2 = new SitecoreAuthoringToolServer({ facts: async () => facts, fetch: old.fetch });
    const r2 = await s2.call(
      'item.read',
      { path: '/sitecore/templates/Project/Brands/ansco', children: true },
      ctx,
    );
    expect(r2.code).toBe(200);
    expect(old.queries).toHaveLength(2);
  });

  it('reports a missing item and refuses hosts outside SitecoreAI', async () => {
    const cm = fakeCm({});
    const s = new SitecoreAuthoringToolServer({ facts: async () => facts, fetch: cm.fetch });
    expect(await s.call('item.read', { path: '/sitecore/content/x' }, ctx)).toMatchObject({
      code: 404,
    });
    const evil = new SitecoreAuthoringToolServer({
      facts: async () => ({ ...facts, cmHost: 'evil.example.com' }),
      fetch: cm.fetch,
    });
    expect((await evil.call('site.list', {}, ctx)).code).toBe(403);
  });
});
