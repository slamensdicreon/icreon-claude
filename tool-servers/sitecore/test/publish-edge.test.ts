import { describe, expect, it } from 'vitest';
import { SitecoreAuthoringToolServer } from '../src';

const facts = {
  cmHost: 'xmc-acme.sitecorecloud.io',
  siteCollection: 'Brands',
  site: 'ansco',
  languages: ['en'],
  sourceHosts: [],
};
const ctx = { projectId: 'p', token: 'jwt', role: 'deployment-engineer', taskId: 'publish-edge' };
const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

describe('publishing follow-up', () => {
  it('reads a publishing operation until it is done', async () => {
    const fetch = (async (_: unknown, init?: RequestInit) => {
      const { query } = JSON.parse(String(init!.body)) as { query: string };
      expect(query).toContain('publishingStatus(publishingOperationId: "op-1")');
      return ok({ publishingStatus: { state: 'COMPLETE', isDone: true, isFailed: false } });
    }) as typeof globalThis.fetch;
    const server = new SitecoreAuthoringToolServer({ facts: async () => facts, fetch });
    expect(server.catalog['publish.status']).toMatchObject({ mutates: false });
    expect(await server.call('publish.status', { operationId: 'op-1' }, ctx)).toMatchObject({
      code: 200,
      body: { isDone: true, state: 'COMPLETE' },
      summary: 'Publishing done (COMPLETE)',
    });
  });

  it('checks routes on Experience Edge with the Context ID it keeps to itself', async () => {
    const seen: string[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://edge-platform.sitecorecloud.io');
      expect(url.searchParams.get('sitecoreContextId')).toBe('ctx-live');
      const { variables } = JSON.parse(String(init!.body)) as {
        variables: { site: string; path: string };
      };
      expect(variables.site).toBe('ansco');
      seen.push(variables.path);
      return ok({ layout: { item: variables.path === '/gone' ? null : { name: 'x' } } });
    }) as typeof globalThis.fetch;
    const server = new SitecoreAuthoringToolServer({
      facts: async () => facts,
      fetch,
      edgeContextId: async (_, live) => (live ? 'ctx-live' : null),
    });
    const r = await server.call('edge.routes', { paths: ['/', '/about', '/gone', '/about'] }, ctx);
    expect(r).toMatchObject({
      code: 200,
      body: { endpoint: 'live', found: ['/', '/about'], missing: ['/gone'] },
    });
    expect(JSON.stringify(r)).not.toContain('ctx-live');
    expect(seen).toEqual(['/', '/about', '/gone']);
    // No preview Context ID stored: says so.
    expect(await server.call('edge.routes', { paths: ['/'], live: false }, ctx)).toMatchObject({
      code: 409,
    });
  });
});
