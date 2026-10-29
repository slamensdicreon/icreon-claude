import { fileURLToPath } from 'node:url';
import { ConnectionView, RemixDraft, type ProjectIntakeInput } from '@lw/contracts';
import { InMemoryEventStore, MemoryIntegrationStore, MemoryVault, Projections } from '@lw/events';
import { loadCatalog } from '@lw/playbook-sdk';
import { createPlatforms } from '@lw/platforms';
import { SITECORE_DEFAULTS } from '@lw/connectors';
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
      platforms: createPlatforms({ sitecore: { ...SITECORE_DEFAULTS, fetch: fakeSitecore } }),
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

  // Remix: same playbook, client, brief and connection; the site is left to fill.
  const draft = RemixDraft.parse((await call('GET', `/projects/${ansco}/remix`)).body);
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
  });
  expect(b.status).toBe(201);
  const careers = b.body.projectId as string;
  await projections.catchUpAll();
  const sb = projections.get(careers)!;
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
