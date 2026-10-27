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
    if (/updateItem\(/.test(query)) {
      const path = /path: "([^"]+)"/.exec(query)![1]!;
      // As Sitecore does: IDs are stored uppercase, in braces.
      const stored = (v: string) =>
        /^\{?[0-9a-f-]{36}\}?(\|\{?[0-9a-f-]{36}\}?)*$/i.test(v)
          ? v
              .split('|')
              .map((g) => `{${g.replace(/[{}]/g, '').toUpperCase()}}`)
              .join('|')
          : v;
      if (!opts.ignoreUpdate)
        for (const [k, v] of fieldsOf(query)) values.get(path)?.set(k, stored(v));
      if (opts.drop) lost();
      return ok({ updateItem: { item: { itemId: items[path], name: 'n' } } });
    }
    const path = /path: "([^"]+)"/.exec(query)?.[1];
    if (/item\(where/.test(query)) {
      if (path && items[path])
        return ok({
          item: {
            itemId: items[path],
            name: 'n',
            path,
            fields: {
              // Fields from base templates come back only when inherited fields are asked for.
              nodes: [...(values.get(path) ?? new Map())]
                .filter(([name]) => !/ownFields: true/.test(query) || !INHERITED.has(name))
                .map(([name, value]) => ({ name, value })),
            },
          },
        });
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
