import { fileURLToPath } from 'node:url';
import { ConnectionView, RemixDraft, type ProjectIntakeInput } from '@lw/contracts';
import { InMemoryEventStore, MemoryIntegrationStore, MemoryVault, Projections } from '@lw/events';
import { loadCatalog } from '@lw/playbook-sdk';
import { createPlatforms } from '@lw/platforms';
import { OPTIMIZELY_DEFAULTS, SITECORE_DEFAULTS } from '@lw/connectors';
import type { FastifyInstance } from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { IntakeService } from '../src/intake';

const PLAYBOOKS = fileURLToPath(new URL('../../../playbooks', import.meta.url));
const SECRET = 'env-secret-value-WXYZ';

/** A fake Sitecore: one environment client, one CM host, and two Context IDs that work. */
const fakeSitecore = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
  if (url.endsWith('/oauth/token'))
    return body.client_id === 'env-id' && body.client_secret === SECRET
      ? json(200, { access_token: 'jwt', expires_in: 900 })
      : json(401, { error: 'access_denied' });
  if (url.startsWith('https://xmc-globex.sitecorecloud.io/sitecore/api/authoring/graphql/v1/'))
    return json(200, { data: { sites: [{ name: 'globex' }] } });
  if (/sitecoreContextId=ctx-preview-(1234|5678)/.test(url))
    return json(200, { data: { site: { siteInfoCollection: [] } } });
  return json(404, {});
}) as typeof fetch;

const first: ProjectIntakeInput = {
  playbookId: 'sitecoreai-migration',
  name: 'Globex site',
  client: 'Globex',
  budgets: { usd: 900, tokens: 6_000_000, hours: 200 },
  source: { repo: null, branch: 'main', url: 'https://www.globex.example' },
  target: {
    cmHost: 'https://xmc-globex.sitecorecloud.io',
    siteCollection: 'globex',
    site: 'globex',
    languages: ['en'],
    hostingProject: 'globex-website',
  },
  brief: { personalization: 'no', accessibility: 'WCAG 2.2 AA', codeExtraction: 'Yes' },
  credentials: {
    'sitecore-environment': { clientId: 'env-id', clientSecret: SECRET },
    'edge-preview': { contextId: 'ctx-preview-1234' },
  },
};

const CMS_SECRET = 'cms-secret-value-QRST';

/** A fake Optimizely: one REST API key on the gateway, and two Graph single keys that work. */
const fakeOptimizely = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  const authorization = new Headers(init?.headers).get('authorization') ?? '';
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
  if (url === 'https://api.cms.optimizely.com/oauth/token')
    return body.client_id === 'cms-id' && body.client_secret === CMS_SECRET
      ? json(200, { access_token: 'jwt', expires_in: 300 })
      : json(401, { error: 'invalid_client' });
  if (url.startsWith('https://api.cms.optimizely.com/v1/contenttypes'))
    return authorization === 'Bearer jwt'
      ? json(200, { items: [], totalItemCount: 0 })
      : json(401, {});
  if (url === 'https://cg.optimizely.com/content/v2')
    return /^epi-single graph-key-(1234|5678)$/.test(authorization)
      ? json(200, { data: { _Content: { total: 3 } } })
      : json(401, {});
  return json(404, {});
}) as typeof fetch;

/** A whole site on Optimizely CMS (SaaS): its own application, type prefix and Vercel project. */
const firstOptimizely: ProjectIntakeInput = {
  playbookId: 'optimizely-saas-migration',
  name: 'Globex website',
  client: 'Globex',
  budgets: { usd: 900, tokens: 6_000_000, hours: 200 },
  source: { repo: null, branch: 'main', url: 'https://www.globex.example' },
  target: {
    cmsUrl: 'https://app-globex123.cms.optimizely.com',
    application: 'Globex Website',
    typePrefix: 'Globex',
    languages: ['en'],
    hostingProject: 'globex-website',
  },
  brief: { experimentation: 'no', accessibility: 'WCAG 2.2 AA', codeExtraction: 'Yes' },
  credentials: {
    'cms-api-client': { clientId: 'cms-id', clientSecret: CMS_SECRET },
    'graph-single-key': { singleKey: 'graph-key-1234' },
  },
};

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function start() {
  const store = new InMemoryEventStore();
  const projections = new Projections(store);
  await projections.start();
  const connections = new MemoryIntegrationStore();
  const playbooks = await loadCatalog(PLAYBOOKS);
  // The live site is optional for this test: the playbook asks for a repository otherwise.
  for (const e of playbooks.values()) e.playbook.manifest.intake.source.repo = 'optional';
  app = await buildApp({
    store,
    projections,
    commands: () => undefined,
    intake: new IntakeService({
      store,
      catalog: playbooks,
      platforms: createPlatforms({
        sitecore: { ...SITECORE_DEFAULTS, fetch: fakeSitecore },
        optimizely: { ...OPTIMIZELY_DEFAULTS, fetch: fakeOptimizely },
      }),
      vault: new MemoryVault(),
      connections,
    }),
  });
  return { projections, connections };
}

const call = async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => {
  const r = await app!.inject({ method, url, payload: payload as object });
  return { status: r.statusCode, body: r.json() as any, text: r.body };
};

it('saves a tenant as a connection, starts the next site from it, and rotates a secret for every site on it', async () => {
  const { projections } = await start();
  const a = await call('POST', '/projects', first);
  expect(a.status).toBe(201);
  const ansco = a.body.projectId as string;

  // Save the first project's tenant: shared facts and secrets, sealed again to the connection.
  const saved = await call('POST', '/connections', { name: 'Globex tenant', fromProject: ansco });
  expect(saved.status).toBe(201);
  const id = saved.body.connectionId as string;
  let list = ConnectionView.array().parse((await call('GET', '/connections')).body);
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({
    id,
    name: 'Globex tenant',
    platform: 'sitecoreai',
    target: { cmHost: 'xmc-globex.sitecorecloud.io', siteCollection: 'globex', languages: ['en'] },
    createdFrom: { projectId: ansco, name: 'Globex site' },
    projects: [],
  });
  expect(list[0]!.credentials.map((c) => c.credentialId).sort()).toEqual([
    'edge-preview',
    'sitecore-environment',
  ]);
  expect(list[0]!.target).not.toHaveProperty('site');
  // Secrets never leave the server: hints only.
  const raw = (await call('GET', '/connections')).text;
  expect(raw).not.toContain(SECRET);
  expect(raw).not.toContain('ctx-preview-1234');

  // Standing approvals: only the playbook's release steps; a remix carries them over.
  expect(
    (await call('PUT', `/projects/${ansco}/settings/standingApprovals`, { value: ['site-crawl'] }))
      .status,
  ).toBe(422);
  expect(
    (await call('PUT', `/projects/${ansco}/settings/standingApprovals`, { value: ['deploy-code'] }))
      .status,
  ).toBe(200);

  // Remix: same playbook, client, brief and connection; the site is left to fill.
  const draft = RemixDraft.parse((await call('GET', `/projects/${ansco}/remix`)).body);
  expect(draft.standingApprovals).toEqual(['deploy-code']);
  expect(draft).toMatchObject({
    playbookId: 'sitecoreai-migration',
    connectionId: id,
    client: 'Globex',
    brief: { personalization: 'no', accessibility: 'WCAG 2.2 AA' },
    providedCredentials: ['sitecore-environment', 'edge-preview'],
  });
  expect(draft.target).not.toHaveProperty('site');
  expect(draft.target).not.toHaveProperty('hostingProject');

  // The next site: no secrets typed, only what is its own.
  const b = await call('POST', '/projects', {
    playbookId: draft.playbookId,
    name: 'Globex careers',
    client: draft.client,
    budgets: draft.budgets,
    source: { repo: null, branch: 'main', url: 'https://careers.globex.example' },
    target: { site: 'globex-careers', hostingProject: 'globex-careers' },
    brief: draft.brief,
    connectionId: id,
    credentials: {},
    standingApprovals: draft.standingApprovals,
  });
  expect(b.status).toBe(201);
  const careers = b.body.projectId as string;
  await projections.catchUpAll();
  const sb = projections.get(careers)!;
  expect(sb.settings.standingApprovals).toEqual(['deploy-code']);
  expect(sb.intake).toMatchObject({
    connectionId: id,
    target: { cmHost: 'xmc-globex.sitecorecloud.io', site: 'globex-careers' },
  });
  expect(sb.credentials['sitecore-environment']).toMatchObject({ ok: true });
  expect(sb.credentials['edge-preview']).toMatchObject({ ok: true });
  const before = sb.credentials['edge-preview']!.reference;
  list = ConnectionView.array().parse((await call('GET', '/connections')).body);
  expect(list[0]!.projects.map((p) => p.name)).toEqual(['Globex careers']);

  // A secret that fails its check changes nothing; a good one reaches every site using it.
  expect(
    (
      await call('PUT', `/connections/${id}/credentials/edge-preview`, {
        secret: { contextId: 'nope' },
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await call('PUT', `/connections/${id}/credentials/edge-preview`, {
        secret: { contextId: 'ctx-preview-5678' },
      })
    ).status,
  ).toBe(200);
  await projections.catchUpAll();
  const after = projections.get(careers)!.credentials['edge-preview']!;
  expect(after.reference).not.toBe(before);
  expect(after.hint).toBe('5678');
  // The project the connection was saved from keeps its own sealed copy.
  expect(projections.get(ansco)!.credentials['edge-preview']!.hint).toBe('1234');
});

it('refuses a connection for another platform, or one that does not exist', async () => {
  await start();
  const r = await call('POST', '/projects', { ...first, connectionId: 'con-missing' });
  expect(r.status).toBe(404);
  expect((await call('POST', '/connections', { name: 'x', fromProject: 'nope' })).status).toBe(404);
});

it('remixes a site onto the homepage demo: same connection and client, the demo’s budgets and brief', async () => {
  const { projections } = await start();
  const globex = (await call('POST', '/projects', first)).body.projectId as string;
  const saved = await call('POST', '/connections', { name: 'Globex tenant', fromProject: globex });
  const id = saved.body.connectionId as string;

  const draft = RemixDraft.parse(
    (await call('GET', `/projects/${globex}/remix?playbook=sitecoreai-homepage-demo`)).body,
  );
  expect(draft).toMatchObject({
    playbookId: 'sitecoreai-homepage-demo',
    from: { projectId: globex, name: 'Globex site' },
    connectionId: id,
    client: 'Globex',
    // The demo's own budgets, not the website project's.
    budgets: { usd: 300, tokens: 20_000_000, hours: 10 },
    providedCredentials: ['sitecore-environment', 'edge-preview'],
  });
  // The demo doesn't ask about personalization or accessibility targets.
  expect(draft.brief).not.toHaveProperty('personalization');
  expect(draft.brief).not.toHaveProperty('accessibility');

  // The prospect's homepage demo, on the same tenant: only its own site and hosting.
  const demo = await call('POST', '/projects', {
    playbookId: draft.playbookId,
    name: 'Initech homepage demo',
    client: 'Initech',
    budgets: draft.budgets,
    source: { repo: null, branch: 'main', url: 'https://www.initech.example' },
    target: { site: 'initech-demo', hostingProject: 'initech-demo' },
    brief: draft.brief,
    connectionId: id,
    credentials: {},
    standingApprovals: draft.standingApprovals,
  });
  expect(demo.status).toBe(201);
  await projections.catchUpAll();
  const s = projections.get(demo.body.projectId as string)!;
  expect(s.playbook?.id).toBe('sitecoreai-homepage-demo');
  expect(s.intake).toMatchObject({
    connectionId: id,
    target: { cmHost: 'xmc-globex.sitecorecloud.io', site: 'initech-demo' },
  });
  expect(s.credentials['sitecore-environment']).toMatchObject({ ok: true });

  // Another platform's playbook can't take the connection.
  const other = await call('GET', `/projects/${globex}/remix?playbook=optimizely-saas-migration`);
  expect(other.status).toBe(422);
  expect(JSON.stringify(other.body)).toContain('another platform');
  // An unknown playbook is a 404.
  expect((await call('GET', `/projects/${globex}/remix?playbook=nope`)).status).toBe(404);
});

it('saves an Optimizely instance as a connection, starts the next application from it, and rotates a key for every project on it', async () => {
  const { projections } = await start();
  const a = await call('POST', '/projects', firstOptimizely);
  expect(a.status).toBe(201);
  const globex = a.body.projectId as string;

  // Save the first project's instance: what every application on it shares, and its keys.
  const saved = await call('POST', '/connections', {
    name: 'Globex instance',
    fromProject: globex,
  });
  expect(saved.status).toBe(201);
  const id = saved.body.connectionId as string;
  let list = ConnectionView.array().parse((await call('GET', '/connections')).body);
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({
    id,
    name: 'Globex instance',
    platform: 'optimizely',
    target: { cmsUrl: 'https://app-globex123.cms.optimizely.com', languages: ['en'] },
    createdFrom: { projectId: globex, name: 'Globex website' },
    projects: [],
  });
  expect(list[0]!.credentials.map((c) => c.credentialId).sort()).toEqual([
    'cms-api-client',
    'graph-single-key',
  ]);
  // The application, its type prefix and its Vercel project are each project's own.
  for (const own of ['application', 'typePrefix', 'hostingProject'])
    expect(list[0]!.target).not.toHaveProperty(own);
  // Secrets never leave the server: hints only.
  const raw = (await call('GET', '/connections')).text;
  expect(raw).not.toContain(CMS_SECRET);
  expect(raw).not.toContain('graph-key-1234');

  // Standing approvals: only the playbook's release steps; a remix carries them over.
  expect(
    (await call('PUT', `/projects/${globex}/settings/standingApprovals`, { value: ['crawl-site'] }))
      .status,
  ).toBe(422);
  expect(
    (
      await call('PUT', `/projects/${globex}/settings/standingApprovals`, {
        value: ['migrate-pages-{key}'],
      })
    ).status,
  ).toBe(200);

  // Remix: same playbook, client, brief and connection; the application is left to fill.
  const draft = RemixDraft.parse((await call('GET', `/projects/${globex}/remix`)).body);
  expect(draft.standingApprovals).toEqual(['migrate-pages-{key}']);
  expect(draft).toMatchObject({
    playbookId: 'optimizely-saas-migration',
    connectionId: id,
    client: 'Globex',
    brief: { experimentation: 'no', accessibility: 'WCAG 2.2 AA' },
    target: { cmsUrl: 'https://app-globex123.cms.optimizely.com', languages: ['en'] },
    providedCredentials: ['cms-api-client', 'graph-single-key'],
  });
  for (const own of ['application', 'typePrefix', 'hostingProject'])
    expect(draft.target).not.toHaveProperty(own);

  // The next application on the instance: no secrets typed, only what is its own.
  const b = await call('POST', '/projects', {
    playbookId: draft.playbookId,
    name: 'Globex careers',
    client: draft.client,
    budgets: draft.budgets,
    source: { repo: null, branch: 'main', url: 'https://careers.globex.example' },
    target: {
      application: 'Globex Careers',
      typePrefix: 'GlobexCareers',
      hostingProject: 'globex-careers',
    },
    brief: draft.brief,
    connectionId: id,
    credentials: {},
    standingApprovals: draft.standingApprovals,
  });
  expect(b.status).toBe(201);
  const careers = b.body.projectId as string;
  await projections.catchUpAll();
  const sb = projections.get(careers)!;
  expect(sb.playbook?.id).toBe('optimizely-saas-migration');
  expect(sb.settings.standingApprovals).toEqual(['migrate-pages-{key}']);
  expect(sb.intake).toMatchObject({
    platform: 'optimizely',
    connectionId: id,
    target: {
      cmsUrl: 'https://app-globex123.cms.optimizely.com',
      languages: ['en'],
      application: 'Globex Careers',
      typePrefix: 'GlobexCareers',
      hostingProject: 'globex-careers',
    },
  });
  expect(sb.credentials['cms-api-client']).toMatchObject({ ok: true });
  expect(sb.credentials['graph-single-key']).toMatchObject({ ok: true });
  const before = sb.credentials['graph-single-key']!.reference;
  list = ConnectionView.array().parse((await call('GET', '/connections')).body);
  expect(list[0]!.projects.map((p) => p.name)).toEqual(['Globex careers']);

  // A key that fails its check changes nothing; a good one reaches every project using it.
  expect(
    (
      await call('PUT', `/connections/${id}/credentials/graph-single-key`, {
        secret: { singleKey: 'nope' },
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await call('PUT', `/connections/${id}/credentials/graph-single-key`, {
        secret: { singleKey: 'graph-key-5678' },
      })
    ).status,
  ).toBe(200);
  await projections.catchUpAll();
  const after = projections.get(careers)!.credentials['graph-single-key']!;
  expect(after.reference).not.toBe(before);
  expect(after.hint).toBe('5678');
  // The project the connection was saved from keeps its own sealed copy.
  expect(projections.get(globex)!.credentials['graph-single-key']!.hint).toBe('1234');
});

it('keeps a connection to its own platform, both ways', async () => {
  await start();
  const sitecore = (await call('POST', '/projects', first)).body.projectId as string;
  const optimizely = (await call('POST', '/projects', firstOptimizely)).body.projectId as string;
  const tenant = (
    await call('POST', '/connections', { name: 'Globex tenant', fromProject: sitecore })
  ).body.connectionId as string;
  const instance = (
    await call('POST', '/connections', { name: 'Globex instance', fromProject: optimizely })
  ).body.connectionId as string;
  const list = ConnectionView.array().parse((await call('GET', '/connections')).body);
  expect(list.map((c) => [c.name, c.platform]).sort()).toEqual([
    ['Globex instance', 'optimizely'],
    ['Globex tenant', 'sitecoreai'],
  ]);

  // An Optimizely project can't start from a SitecoreAI tenant, nor the other way round.
  const onTenant = await call('POST', '/projects', {
    ...firstOptimizely,
    name: 'Globex shop',
    credentials: {},
    connectionId: tenant,
  });
  expect(onTenant.status).toBe(422);
  expect(JSON.stringify(onTenant.body)).toContain('Globex tenant is a sitecoreai connection');
  const onInstance = await call('POST', '/projects', {
    ...first,
    name: 'Globex shop',
    credentials: {},
    connectionId: instance,
  });
  expect(onInstance.status).toBe(422);
  expect(JSON.stringify(onInstance.body)).toContain('Globex instance is a optimizely connection');
  // An Optimizely whole-site project can't be remixed onto a SitecoreAI playbook.
  const other = await call(
    'GET',
    `/projects/${optimizely}/remix?playbook=sitecoreai-homepage-demo`,
  );
  expect(other.status).toBe(422);
  expect(JSON.stringify(other.body)).toContain('another platform');
});

it('remixes an Optimizely site onto the Optimizely homepage demo: same instance and client, the demo’s budgets and brief', async () => {
  const { projections } = await start();
  const globex = (await call('POST', '/projects', firstOptimizely)).body.projectId as string;
  const saved = await call('POST', '/connections', {
    name: 'Globex instance',
    fromProject: globex,
  });
  const id = saved.body.connectionId as string;

  const draft = RemixDraft.parse(
    (await call('GET', `/projects/${globex}/remix?playbook=optimizely-homepage-demo`)).body,
  );
  expect(draft).toMatchObject({
    playbookId: 'optimizely-homepage-demo',
    from: { projectId: globex, name: 'Globex website' },
    connectionId: id,
    client: 'Globex',
    // The demo's own budgets, not the website project's.
    budgets: { usd: 300, tokens: 20_000_000, hours: 10 },
    // The instance carries over: its URL, its locales and its keys.
    target: { cmsUrl: 'https://app-globex123.cms.optimizely.com', languages: ['en'] },
    providedCredentials: ['cms-api-client', 'graph-single-key'],
  });
  // The application, the type prefix and the Vercel project are the demo's own: left to fill.
  expect(Object.keys(draft.target).sort()).toEqual(['cmsUrl', 'languages']);
  // The demo doesn't ask about Experimentation or accessibility targets.
  expect(draft.brief).not.toHaveProperty('experimentation');
  expect(draft.brief).not.toHaveProperty('accessibility');

  // The prospect's homepage demo, on the same instance: only its own application and hosting.
  const demo = await call('POST', '/projects', {
    playbookId: draft.playbookId,
    name: 'Initech homepage demo',
    client: 'Initech',
    budgets: draft.budgets,
    source: { repo: null, branch: 'main', url: 'https://www.initech.example' },
    target: { application: 'Initech Demo', typePrefix: 'Initech', hostingProject: 'initech-demo' },
    brief: draft.brief,
    connectionId: id,
    credentials: {},
    standingApprovals: draft.standingApprovals,
  });
  expect(demo.status).toBe(201);
  await projections.catchUpAll();
  const s = projections.get(demo.body.projectId as string)!;
  expect(s.playbook?.id).toBe('optimizely-homepage-demo');
  expect(s.intake).toMatchObject({
    platform: 'optimizely',
    connectionId: id,
    target: {
      cmsUrl: 'https://app-globex123.cms.optimizely.com',
      application: 'Initech Demo',
      typePrefix: 'Initech',
      hostingProject: 'initech-demo',
    },
  });
  expect(s.credentials['cms-api-client']).toMatchObject({ ok: true });
  expect(s.credentials['graph-single-key']).toMatchObject({ ok: true });
  const list = ConnectionView.array().parse((await call('GET', '/connections')).body);
  expect(list[0]!.projects.map((p) => p.name)).toEqual(['Initech homepage demo']);

  // The demo without its own application or prefix is refused: the connection doesn't supply them.
  const bare = await call('POST', '/projects', {
    playbookId: draft.playbookId,
    name: 'Umbrella homepage demo',
    client: 'Umbrella',
    budgets: draft.budgets,
    source: { repo: null, branch: 'main', url: 'https://www.umbrella.example' },
    target: { hostingProject: 'umbrella-demo' },
    brief: draft.brief,
    connectionId: id,
    credentials: {},
  });
  expect(bare.status).toBe(422);
  expect(JSON.stringify(bare.body)).toMatch(/Application/);
  expect(JSON.stringify(bare.body)).toMatch(/Content type prefix/);

  // Another platform's playbook can't take the connection; an unknown playbook is a 404.
  const other = await call('GET', `/projects/${globex}/remix?playbook=sitecoreai-migration`);
  expect(other.status).toBe(422);
  expect(JSON.stringify(other.body)).toContain('another platform');
  expect((await call('GET', `/projects/${globex}/remix?playbook=nope`)).status).toBe(404);
});
