import { describe, expect, it } from 'vitest';
import { SitecoreAuthoringToolServer } from '../src';

const facts = {
  cmHost: 'xmc-acme.sitecorecloud.io',
  siteCollection: 'Brands',
  site: 'ansco',
  languages: ['en'],
  sourceHosts: [],
};
const ctx = { projectId: 'p', token: 'jwt', role: 'deployment-engineer', taskId: 't' };
const HOSTS = '/sitecore/system/Settings/Services/Rendering Hosts';
const GROUPING = '/sitecore/content/Brands/ansco/Settings/Site Grouping';
const URLS = {
  'Server side rendering engine endpoint URL': 'https://eh.sitecorecloud.io/api/editing/render',
  'Server side rendering engine application URL': 'https://eh.sitecorecloud.io',
  'Server side rendering engine configuration URL':
    'https://eh.sitecorecloud.io/api/editing/config',
};

/** A tenant with the environment's Default host, Ansco's Site Grouping item and another site's. */
function tenant(setting: string, field = 'RenderingHost') {
  type Item = { id: string; template: string; fields: Record<string, string> };
  const items = new Map<string, Item>([
    [HOSTS, { id: 'hosts-id', template: 'folder', fields: {} }],
    [`${HOSTS}/Default`, { id: 'default-id', template: 'host-tpl', fields: { ...URLS } }],
    [GROUPING, { id: 'g-id', template: 'folder', fields: {} }],
    [
      `${GROUPING}/ansco`,
      {
        id: 'ansco-g',
        template: 'grouping',
        fields: { SiteName: 'ansco', [field]: setting },
      },
    ],
  ]);
  const children = (path: string) =>
    [...items.entries()]
      .filter(([p]) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes('/'))
      .map(([p, it]) => ({
        itemId: it.id,
        name: p.split('/').at(-1),
        path: p,
        template: { templateId: it.template },
        fields: { nodes: Object.entries(it.fields).map(([name, value]) => ({ name, value })) },
      }));
  const fieldsOf = (q: string) =>
    Object.fromEntries(
      [...q.matchAll(/\{ name: "([^"]+)", value: "((?:[^"\\]|\\.)*)" \}/g)].map((m) => [
        m[1]!,
        JSON.parse(`"${m[2]}"`) as string,
      ]),
    );
  const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
  const fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
    const query = (JSON.parse(String(init!.body)) as { query: string }).query;
    if (/createItem\(/.test(query)) {
      const name = /name: "([^"]+)"/.exec(query)![1]!;
      const template = /templateId: "([^"]+)"/.exec(query)![1]!;
      items.set(`${HOSTS}/${name}`, { id: `${name}-host`, template, fields: fieldsOf(query) });
      return ok({ createItem: { item: { itemId: `${name}-host`, path: `${HOSTS}/${name}` } } });
    }
    if (/updateItem\(/.test(query)) {
      const path = /path: "([^"]+)"/.exec(query)![1]!;
      Object.assign(items.get(path)!.fields, fieldsOf(query));
      return ok({ updateItem: { item: { itemId: items.get(path)!.id, name: 'n' } } });
    }
    const path = /path: "([^"]+)"/.exec(query)![1]!;
    const it = items.get(path);
    if (!it) return ok({ item: null });
    const single = Object.fromEntries(
      [...query.matchAll(/(f\d+): field\(name: "([^"]+)"\) \{ value \}/g)].map((m) => [
        m[1]!,
        m[2]! in it.fields ? { value: it.fields[m[2]!]! } : null,
      ]),
    );
    return ok({
      item: {
        itemId: it.id,
        path,
        ...single,
        children: { nodes: children(path) },
        fields: { nodes: Object.entries(it.fields).map(([name, value]) => ({ name, value })) },
      },
    });
  }) as typeof globalThis.fetch;
  return { fetch, items };
}

describe('rendering hosts', () => {
  it("points the project's site at its own head, leaving the environment's host alone", async () => {
    // As on a new site: SitecoreAI's `RenderingHost` field, empty (the default host).
    const t = tenant('');
    const s = new SitecoreAuthoringToolServer({ facts: async () => facts, fetch: t.fetch });
    const before = await s.call('rendering-host.read', {}, ctx);
    expect(before.summary).toBe(
      'ansco renders through the default host (no setting); 1 rendering host: Default',
    );

    const r = await s.call(
      'rendering-host.set',
      { url: 'https://ansco-editing.vercel.app/x' },
      ctx,
    );
    expect(r.code).toBe(200);
    expect(t.items.get(`${HOSTS}/ansco`)).toMatchObject({
      template: 'host-tpl',
      fields: {
        'Server side rendering engine endpoint URL':
          'https://ansco-editing.vercel.app/api/editing/render',
        'Server side rendering engine application URL': 'https://ansco-editing.vercel.app',
        'Server side rendering engine configuration URL':
          'https://ansco-editing.vercel.app/api/editing/config',
      },
    });
    expect(t.items.get(`${GROUPING}/ansco`)!.fields.RenderingHost).toBe('ansco');
    // The environment's own host is untouched.
    expect(t.items.get(`${HOSTS}/Default`)!.fields).toEqual(URLS);

    // Again: the host item is updated, not duplicated.
    const again = await s.call('rendering-host.set', { url: 'https://ansco-2.vercel.app' }, ctx);
    expect(again.code).toBe(200);
    expect(
      t.items.get(`${HOSTS}/ansco`)!.fields['Server side rendering engine application URL'],
    ).toBe('https://ansco-2.vercel.app');
  });

  it('writes the setting as an ID when that is how it is stored', async () => {
    const t = tenant(
      '{11111111-2222-3333-4444-555555555555}',
      'Predefined application rendering host',
    );
    const s = new SitecoreAuthoringToolServer({ facts: async () => facts, fetch: t.fetch });
    expect((await s.call('rendering-host.set', { url: 'https://a.vercel.app' }, ctx)).code).toBe(
      200,
    );
    expect(t.items.get(`${GROUPING}/ansco`)!.fields['Predefined application rendering host']).toBe(
      'ansco-host',
    );
    expect((await s.call('rendering-host.set', { url: 'http://a.vercel.app' }, ctx)).code).toBe(
      422,
    );
  });

  it("creates nothing when the site's setting can't be found", async () => {
    const t = tenant('', 'Something else');
    const s = new SitecoreAuthoringToolServer({ facts: async () => facts, fetch: t.fetch });
    const r = await s.call('rendering-host.set', { url: 'https://a.vercel.app' }, ctx);
    expect(r).toMatchObject({ code: 422 });
    expect(t.items.has(`${HOSTS}/ansco`)).toBe(false);
  });
});
