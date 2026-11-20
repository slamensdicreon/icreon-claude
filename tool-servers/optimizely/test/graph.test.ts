import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OptimizelyGraphToolServer, signature } from '../src';

const ctx = { projectId: 'p', token: 'single-key', role: 'deployment-engineer', taskId: 't' };
const page = (base: string | null, route: string, key: string, version = '1') => ({
  _metadata: {
    key,
    displayName: route,
    locale: 'en',
    version,
    status: 'Published',
    types: ['AcmeExperience'],
    url: { base, default: route },
  },
});

const server = (
  answer: (body: { query: string }, headers: Headers) => unknown,
  hosts = ['acme.vercel.app'],
) => {
  const seen: { authorization: string; query: string }[] = [];
  const fetch = (async (_: unknown, init?: RequestInit) => {
    const headers = new Headers(init!.headers);
    const body = JSON.parse(String(init!.body)) as { query: string };
    seen.push({ authorization: headers.get('authorization') ?? '', query: body.query });
    const out = answer(body, headers);
    return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200 });
  }) as typeof globalThis.fetch;
  const s = new OptimizelyGraphToolServer({
    facts: async () => ({ hosts, languages: ['en'] }),
    hmac: async () => ({ appKey: 'app', secret: Buffer.from('secret').toString('base64') }),
    fetch,
  });
  return { s, seen };
};

describe('optimizely-graph', () => {
  it("lists only this application's routes: one index holds every application", async () => {
    const { s, seen } = server(() => ({
      data: {
        _Page: {
          items: [
            page('https://acme.vercel.app', '/en/', 'a'),
            page('https://acme.vercel.app', '/en/about/', 'b'),
            page('https://localhost:3000', '/en/', 'c'),
            page(null, '/en/', 'd'),
          ],
        },
      },
    }));
    const r = await s.call('graph.routes', {}, ctx);
    expect(r.code).toBe(200);
    expect(
      (r.body as { routes: { route: string; key: string }[] }).routes.map((x) => x.key),
    ).toEqual(['a', 'b']);
    expect(seen[0]!.authorization).toBe('epi-single single-key');
    const all = await s.call('graph.routes', { all: true }, ctx);
    expect((all.body as { routes: unknown[] }).routes).toHaveLength(4);
  });

  it('says why there are no routes before a host is registered', async () => {
    const { s, seen } = server(() => ({ data: {} }), []);
    const r = await s.call('graph.routes', {}, ctx);
    expect(r).toMatchObject({ code: 200, body: { routes: [] } });
    expect(r.summary).toContain('hostname.add');
    expect(seen).toHaveLength(0);
  });

  it("finds an item by route on this application's host, or reports it is not indexed", async () => {
    const { s } = server(({ query }) => ({
      data: {
        _Content: {
          items: query.includes('"/en/"')
            ? [
                page('https://localhost:3000', '/en/', 'theirs'),
                page('https://acme.vercel.app', '/en/', 'ours'),
              ]
            : [],
        },
      },
    }));
    expect(await s.call('graph.item', { path: '/en' }, ctx)).toMatchObject({
      code: 200,
      body: { indexed: true, key: 'ours', status: 'Published' },
    });
    expect(await s.call('graph.item', { key: 'f'.repeat(32) }, ctx)).toMatchObject({
      code: 404,
      body: { indexed: false },
    });
    expect((await s.call('graph.item', {}, ctx)).code).toBe(422);
  });

  it('signs a request for drafts and never sends the single key with it', async () => {
    const { s, seen } = server(() => ({ data: { _Content: { total: 3 } } }));
    const r = await s.call('graph.query', { query: '{ _Content { total } }', drafts: true }, ctx);
    expect(r).toMatchObject({ code: 200, body: { data: { _Content: { total: 3 } } } });
    expect(seen[0]!.authorization).toMatch(/^epi-hmac app:\d+:[0-9a-f-]{36}:[A-Za-z0-9+/=]+$/);
    expect(seen[0]!.authorization).not.toContain('single-key');
  });

  it('refuses anything but a query, and passes on what Graph rejects', async () => {
    const { s, seen } = server(() => ({ errors: [{ message: 'Unknown type "Nope"' }] }));
    expect((await s.call('graph.query', { query: 'mutation { delete }' }, ctx)).code).toBe(422);
    expect(seen).toHaveLength(0);
    const r = await s.call('graph.query', { query: '{ Nope { total } }' }, ctx);
    expect(r.code).toBe(422);
    expect(JSON.stringify(r.body)).toContain('Unknown type');
  });

  it('names the key to fix when Graph refuses it', async () => {
    const { s } = server(() => new Response('', { status: 401 }));
    const r = await s.call('graph.query', { query: '{ _Content { total } }' }, ctx);
    expect(r.code).toBe(401);
    expect(JSON.stringify(r.body)).toContain('single key');
  });

  it('builds the signature Optimizely Graph documents', () => {
    const secret = Buffer.from('s3cret').toString('base64');
    const body = '{"query":"{ a }"}';
    const header = signature(
      'app',
      secret,
      'POST',
      'https://cg.optimizely.com/content/v2?x=1',
      body,
      () => 1700000000000,
      () => 'nonce',
    );
    const message = `appPOST/content/v2?x=11700000000000nonce${createHash('md5').update(body).digest('base64')}`;
    const expected = createHmac('sha256', Buffer.from(secret, 'base64'))
      .update(message)
      .digest('base64');
    expect(header).toBe(`epi-hmac app:1700000000000:nonce:${expected}`);
  });
});
