import { describe, expect, it } from 'vitest';
import { HostingToolServer, type HostingRecord } from '../src';

function fakeVercel(
  opts: { existing?: { repo: string }; production?: { alias: string; state: string } } = {},
) {
  let editingAt: string | undefined;
  let slowReads = 0;
  const calls: { method: string; path: string; body: unknown }[] = [];
  let project: Record<string, unknown> | null = opts.existing
    ? {
        id: 'prj_1',
        name: 'acme-site',
        rootDirectory: 'examples/basic-nextjs',
        link: {
          type: 'github',
          org: opts.existing.repo.split('/')[0],
          repo: opts.existing.repo.split('/')[1],
        },
        ssoProtection: { deploymentType: 'preview' },
        ...(opts.production ? { targets: { production: { alias: [opts.production.alias] } } } : {}),
      }
    : null;
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path: url.pathname, body });
    if (url.searchParams.get('teamId') !== 'team_x')
      return json(403, { error: { message: 'team' } });
    if (new Headers(init?.headers).get('authorization') !== 'Bearer vt') return json(401, {});
    const p = url.pathname;
    if (/^\/v9\/projects\/(acme-site|prj_1)$/.test(p) && method === 'GET')
      return project ? json(200, project) : json(404, { error: { message: 'Not found' } });
    if (p === '/v11/projects' && method === 'POST') {
      project = {
        id: 'prj_1',
        name: body.name,
        rootDirectory: body.rootDirectory,
        link: {
          type: 'github',
          org: body.gitRepository.repo.split('/')[0],
          repo: body.gitRepository.repo.split('/')[1],
        },
        ssoProtection: { deploymentType: 'preview' },
      };
      return json(200, project);
    }
    if (p === '/v9/projects/prj_1' && method === 'PATCH') {
      Object.assign(project!, body);
      return json(200, project);
    }
    if (p === '/v10/projects/prj_1/env' && method === 'GET') return json(200, { envs: [] });
    if (p === '/v6/deployments' && method === 'GET')
      return json(200, {
        deployments: opts.production
          ? [
              {
                uid: 'dpl_9',
                url: 'acme-site-abc.vercel.app',
                state: opts.production.state,
                target: 'production',
                meta: { githubCommitRef: 'main' },
              },
            ]
          : [],
      });
    if (p === '/v10/projects/acme-site/env' && method === 'POST')
      return json(201, { created: body, failed: [] });
    if (p === '/v13/deployments' && method === 'POST')
      return json(200, { id: 'dpl_9', url: 'acme-site-abc.vercel.app', readyState: 'QUEUED' });
    if (p === '/v13/deployments/dpl_int')
      return json(200, {
        id: 'dpl_int',
        name: 'acme-site',
        url: 'acme-site-int.vercel.app',
        readyState: 'READY',
        createdAt: 2000,
        meta: { githubCommitRef: 'launchworks/integration' },
      });
    if (p === '/v13/deployments/dpl_slow')
      return json(200, {
        id: 'dpl_slow',
        name: 'acme-site',
        url: 'acme-site-slow.vercel.app',
        readyState: ++slowReads < 3 ? 'BUILDING' : 'READY',
        meta: { githubCommitRef: 'launchworks/port-hero' },
      });
    if (p === '/v13/deployments/dpl_stuck')
      return json(200, { id: 'dpl_stuck', name: 'acme-site', readyState: 'BUILDING' });
    if (p === '/v13/deployments/dpl_old')
      return json(200, { id: 'dpl_old', name: 'acme-site', readyState: 'READY', createdAt: 1000 });
    if (p === '/v13/deployments/dpl_new')
      return json(200, { id: 'dpl_new', name: 'acme-site', readyState: 'READY', createdAt: 3000 });
    if (p === '/v4/aliases/acme-site-editing.vercel.app')
      return json(200, { deploymentId: editingAt });
    if (p === '/v2/deployments/dpl_int/aliases' && method === 'POST')
      return json(200, { alias: (body as { alias: string }).alias });
    if (p === '/v13/deployments/dpl_9')
      return json(200, {
        id: 'dpl_9',
        name: 'acme-site',
        url: 'acme-site-abc.vercel.app',
        readyState: 'READY',
        target: 'production',
        alias: ['acme-site.vercel.app'],
        meta: { githubCommitRef: 'main' },
      });
    return json(404, { error: { message: `no ${method} ${p}` } });
  }) as typeof globalThis.fetch;
  return { fetch, calls, editingAt: (id: string) => void (editingAt = id) };
}

const ctx = {
  projectId: 'p1',
  token: 'no-external-credential',
  role: 'deployment-engineer',
  taskId: 't',
};

function server(fetch: typeof globalThis.fetch, records: HostingRecord[] = []) {
  return new HostingToolServer({
    logTiming: { windowMs: 2_000, graceMs: 50 },
    waitTiming: { pollMs: 5, maxMs: 60 },
    token: 'vt',
    teamId: 'team_x',
    facts: async () => ({
      project: 'acme-site',
      repo: 'icreon-launchworks/acme-site-sitecoreai',
      branch: 'main',
      rootDirectory: 'examples/basic-nextjs',
    }),
    env: async (_id, target) => ({
      vars: [
        { key: 'NEXT_PUBLIC_DEFAULT_SITE_NAME', value: 'acme', sensitive: false },
        { key: 'SITECORE_EDITING_SECRET', value: `secret-${target}`, sensitive: true },
      ],
      missing: ['the preview Context ID'],
    }),
    record: async (_id, r) => void records.push(r),
    fetch,
  });
}

describe('HostingToolServer', () => {
  it('creates the Vercel project linked to the build repo, turns protection off, and reads it back', async () => {
    const v = fakeVercel();
    const r = await server(v.fetch).call('project.create', {}, ctx);
    expect(r).toMatchObject({
      code: 200,
      body: {
        created: true,
        repository: 'icreon-launchworks/acme-site-sitecoreai',
        protection: 'off',
        problems: [],
      },
    });
    expect(v.calls.find((c) => c.method === 'POST')!.body).toMatchObject({
      framework: 'nextjs',
      rootDirectory: 'examples/basic-nextjs',
      gitRepository: { type: 'github', repo: 'icreon-launchworks/acme-site-sitecoreai' },
    });
    expect(v.calls.find((c) => c.method === 'PATCH')!.body).toMatchObject({ ssoProtection: null });
  });

  it('refuses a same-named project linked to another repository', async () => {
    const v = fakeVercel({ existing: { repo: 'someone/else' } });
    const r = await server(v.fetch).call('project.create', {}, ctx);
    expect(r.code).toBe(422);
    expect(v.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('sets variables from the project, sensitive ones as sensitive, and never returns values', async () => {
    const v = fakeVercel({ existing: { repo: 'icreon-launchworks/acme-site-sitecoreai' } });
    const r = await server(v.fetch).call('env.set', { target: 'both' }, ctx);
    expect(r.code).toBe(200);
    expect(JSON.stringify(r)).not.toContain('secret-');
    expect(r.body).toMatchObject({ missing: ['the preview Context ID'] });
    const posts = v.calls
      .filter((c) => c.path.endsWith('/env'))
      .map((c) => c.body as { type: string; key: string; target: string[] }[]);
    expect(posts).toHaveLength(2);
    expect(posts[0]!.find((x) => x.key === 'SITECORE_EDITING_SECRET')).toMatchObject({
      type: 'sensitive',
      target: ['preview'],
    });
  });

  it('deploys only agent branches as previews, the default branch to production, and records a ready deployment', async () => {
    const v = fakeVercel({ existing: { repo: 'icreon-launchworks/acme-site-sitecoreai' } });
    const records: HostingRecord[] = [];
    const s = server(v.fetch, records);
    expect((await s.call('deploy.preview', { ref: 'main' }, ctx)).code).toBe(422);
    const d = await s.call('deploy.production', {}, ctx);
    expect(d.body).toMatchObject({ deploymentId: 'dpl_9', target: 'production', ref: 'main' });
    expect(v.calls.at(-1)!.body).toMatchObject({
      target: 'production',
      gitSource: {
        type: 'github',
        org: 'icreon-launchworks',
        repo: 'acme-site-sitecoreai',
        ref: 'main',
      },
    });
    const st = await s.call('deploy.status', { deploymentId: 'dpl_9' }, ctx);
    expect(st.body).toMatchObject({ state: 'READY', url: 'https://acme-site.vercel.app' });
    // A ready integration preview takes the editing host's fixed address.
    v.editingAt('dpl_old');
    const int = await s.call('deploy.status', { deploymentId: 'dpl_int' }, ctx);
    expect(int.body).toMatchObject({
      state: 'READY',
      editingHost: 'https://acme-site-editing.vercel.app',
      url: 'https://acme-site-editing.vercel.app',
    });
    expect(v.calls.at(-1)).toMatchObject({
      method: 'POST',
      path: '/v2/deployments/dpl_int/aliases',
      body: { alias: 'acme-site-editing.vercel.app' },
    });
    // An older integration build never takes the address back from a newer one.
    v.editingAt('dpl_new');
    const late = await s.call('deploy.status', { deploymentId: 'dpl_int' }, ctx);
    expect(late.body).toMatchObject({ editingHost: null });
    expect(late.summary).toContain(
      'a newer integration build (dpl_new) is already the editing host',
    );
    expect(records[0]).toEqual({
      projectId: 'p1',
      url: 'https://acme-site.vercel.app',
      deployment: {
        id: 'dpl_9',
        url: 'https://acme-site.vercel.app',
        target: 'production',
        ref: 'main',
      },
    });
  });

  it('waits for a deployment to settle when asked, and says when it is still building', async () => {
    const v = fakeVercel({ existing: { repo: 'icreon-launchworks/acme-site-sitecoreai' } });
    const s = server(v.fetch);
    const once = await s.call('deploy.status', { deploymentId: 'dpl_slow' }, ctx);
    expect(once.body).toMatchObject({ state: 'BUILDING' });
    const settled = await s.call('deploy.status', { deploymentId: 'dpl_slow', wait: true }, ctx);
    expect(settled.body).toMatchObject({
      state: 'READY',
      url: 'https://acme-site-slow.vercel.app',
    });
    expect(v.calls.filter((c) => c.path === '/v13/deployments/dpl_slow')).toHaveLength(3);
    const stuck = await s.call('deploy.status', { deploymentId: 'dpl_stuck', wait: true }, ctx);
    expect(stuck.body).toMatchObject({ state: 'BUILDING' });
    expect(stuck.summary).toContain('call deploy.status with wait again');
  });

  it('records the production address when reading the project finds a ready production deployment', async () => {
    const existing = { repo: 'icreon-launchworks/acme-site-sitecoreai' };
    const building: HostingRecord[] = [];
    await server(
      fakeVercel({ existing, production: { alias: 'acme-site.vercel.app', state: 'BUILDING' } })
        .fetch,
      building,
    ).call('project.read', {}, ctx);
    expect(building).toEqual([]);
    const records: HostingRecord[] = [];
    const r = await server(
      fakeVercel({ existing, production: { alias: 'acme-site.vercel.app', state: 'READY' } }).fetch,
      records,
    ).call('project.read', {}, ctx);
    expect(r.body).toMatchObject({ productionUrl: 'https://acme-site.vercel.app' });
    expect(records).toEqual([
      {
        projectId: 'p1',
        url: 'https://acme-site.vercel.app',
        deployment: {
          id: 'dpl_9',
          url: 'https://acme-site.vercel.app',
          target: 'production',
          ref: 'main',
        },
      },
    ]);
  });
});

describe('logs.runtime', () => {
  /**
   * Vercel's runtime log is a live tail: nothing until a request comes in. This fake emits the
   * render's lines only once the page has been requested, as the real one does.
   */
  function tailing(opts: { refuse?: boolean; quiet?: boolean } = {}) {
    let requested: () => void = () => undefined;
    const pageAsked = new Promise<void>((r) => (requested = r));
    const seen: string[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push(`${url.host}${url.pathname}`);
      const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
      if (url.host === 'acme-site-editing.vercel.app') {
        requested();
        return new Response(
          '<html><head><title>500: Internal Server Error</title></head><body>Application error (Digest: 2817391044)</body></html>',
          { status: 500 },
        );
      }
      if (url.pathname === '/v9/projects/acme-site')
        return json(200, { id: 'prj_1', name: 'acme-site', rootDirectory: null });
      if (url.pathname === '/v4/aliases/acme-site-editing.vercel.app')
        return json(200, { deploymentId: 'dpl_ed' });
      if (url.pathname === '/v1/projects/prj_1/deployments/dpl_ed/runtime-logs') {
        if (opts.refuse) return json(403, { error: { message: 'plan' } });
        const enc = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          async start(c) {
            await pageAsked;
            if (!opts.quiet) {
              c.enqueue(
                enc.encode(
                  `${JSON.stringify({ level: 'info', message: 'GET /about', requestPath: '/about', responseStatusCode: 500, timestampInMs: 1 })}\n{"level":"error","message":"Error: Cannot read properties of undefined (reading 'jsonValue')\\n    at HeroBanner (HeroBanner.tsx:14)","requestPath":"/about"}\n`,
                ),
              );
            }
            // A live tail stays open; the reader stops it.
            await new Promise((r) => init?.signal?.addEventListener('abort', r));
            c.close();
          },
        });
        return new Response(body, { status: 200 });
      }
      return json(404, {});
    }) as typeof globalThis.fetch;
    return { fetch, seen };
  }

  it('reproduces a page on the editing host and returns the error the server logged', async () => {
    const { fetch, seen } = tailing();
    const r = await server(fetch).call('logs.runtime', { path: '/about' }, ctx);
    expect(r.code).toBe(200);
    expect(r.body).toMatchObject({
      deploymentId: 'dpl_ed',
      tail: 'open',
      page: { status: 500, digest: '2817391044', title: '500: Internal Server Error' },
      lines: [
        { level: 'info', path: '/about', status: 500 },
        { level: 'error', message: expect.stringContaining('at HeroBanner (HeroBanner.tsx:14)') },
      ],
    });
    expect(r.summary).toBe(
      '/about on acme-site-editing.vercel.app: answered 500; 2 log lines, 1 error',
    );
    // The tail was opened before the page was requested.
    expect(
      seen.indexOf('api.vercel.com/v1/projects/prj_1/deployments/dpl_ed/runtime-logs'),
    ).toBeLessThan(seen.indexOf('acme-site-editing.vercel.app/about'));
    const errorsOnly = await server(tailing().fetch).call(
      'logs.runtime',
      { path: '/about', level: 'error' },
      ctx,
    );
    expect((errorsOnly.body as { lines: unknown[] }).lines).toHaveLength(1);
  });

  it("still gives the page's status and digest when the log says nothing or can't be read", async () => {
    const quiet = await server(tailing({ quiet: true }).fetch).call(
      'logs.runtime',
      { path: '/about' },
      ctx,
    );
    expect(quiet.body).toMatchObject({ lines: [], page: { status: 500 } });
    expect((quiet.body as { note: string }).note).toMatch(/No log lines arrived/);
    const refused = await server(tailing({ refuse: true }).fetch).call(
      'logs.runtime',
      { path: '/about' },
      ctx,
    );
    expect(refused.body).toMatchObject({ tail: 'refused (403)', page: { status: 500 } });
    expect((refused.body as { note: string }).note).toMatch(/could not be read/);
    expect((await server(tailing().fetch).call('logs.runtime', { path: 'about' }, ctx)).code).toBe(
      422,
    );
  }, 30_000);
});

describe('storage.blob', () => {
  /** Vercel's storage API with the acme-site project and whatever stores the test starts with. */
  function fakeStorage(stores: Record<string, unknown>[]) {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method, path: url.pathname, body });
      const p = url.pathname;
      if (p === '/v9/projects/acme-site') return json(200, { id: 'prj_1', name: 'acme-site' });
      if (p === '/v1/storage/stores' && method === 'GET') return json(200, { stores });
      if (p === '/v1/storage/stores/blob' && method === 'POST') {
        const store = { id: 'store_new', type: 'blob', name: body.name, access: body.access };
        stores.push(store);
        return json(201, { store });
      }
      if (/^\/v1\/storage\/stores\/[^/]+\/connections$/.test(p) && method === 'POST')
        return json(201, {});
      return json(404, { error: { message: `no ${method} ${p}` } });
    }) as typeof globalThis.fetch;
    return { fetch, calls };
  }

  it('creates a private store for the project and connects it, without showing its token', async () => {
    const v = fakeStorage([]);
    const r = await server(v.fetch).call('storage.blob', {}, ctx);
    expect(r).toMatchObject({
      code: 200,
      body: { store: 'acme-site-data', created: true, connected: true, access: 'private' },
    });
    expect(v.calls.find((c) => c.path === '/v1/storage/stores/blob')?.body).toEqual({
      name: 'acme-site-data',
      access: 'private',
    });
    expect(v.calls.find((c) => c.path.endsWith('/connections'))?.body).toMatchObject({
      projectId: 'prj_1',
      environments: ['production', 'preview'],
    });
    expect(JSON.stringify(r)).not.toMatch(/vercel_blob_rw/i);
  });

  it('keeps a store already connected to the project, and creates nothing', async () => {
    const v = fakeStorage([
      {
        id: 'store_old',
        type: 'blob',
        name: 'set-up-by-hand',
        access: 'private',
        projectsMetadata: [{ projectId: 'prj_1' }],
      },
    ]);
    const r = await server(v.fetch).call('storage.blob', {}, ctx);
    expect(r).toMatchObject({ code: 200, body: { store: 'set-up-by-hand', created: false } });
    expect(v.calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('refuses a public store, which would expose the head data', async () => {
    const v = fakeStorage([
      { id: 'store_pub', type: 'blob', name: 'acme-site-data', access: 'public' },
    ]);
    const r = await server(v.fetch).call('storage.blob', {}, ctx);
    expect(r.code).toBeGreaterThanOrEqual(400);
    expect(v.calls.some((c) => c.path.endsWith('/connections'))).toBe(false);
  });
});
