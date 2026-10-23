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

function fakeCm(items: Record<string, string>) {
  const queries: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toBe(
      'https://xmc-acme.sitecorecloud.io/sitecore/api/authoring/graphql/v1/',
    );
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer jwt');
    const { query } = JSON.parse(String(init!.body)) as { query: string };
    queries.push(query);
    const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
    if (/sites \{/.test(query))
      return ok({ sites: [{ name: 'ansco', rootPath: '/sitecore/content/Brands/ansco' }] });
    if (/createItem\(/.test(query))
      return ok({ createItem: { item: { itemId: 'new', path: '/x/new' } } });
    const path = /path: "([^"]+)"/.exec(query)?.[1];
    if (/item\(where/.test(query)) {
      if (path && items[path]) return ok({ item: { itemId: items[path], name: 'n', path } });
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
    expect(await s.call('site.create', { collection: 'Brands', site: 'ansco' }, ctx)).toMatchObject(
      {
        code: 200,
        body: { exists: true },
      },
    );
    expect((await s.call('site.create', { collection: 'Brands', site: 'other' }, ctx)).code).toBe(
      409,
    );
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
    expect((await evil.call('item.read', {}, ctx)).code).toBe(403);
  });
});
