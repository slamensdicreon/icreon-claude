import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { ProjectIntakeInput } from '@lw/contracts';
import {
  DEFAULT_ORGANIZATION,
  githubSubject,
  InMemoryEventStore,
  MemoryIntegrationStore,
  MemoryOrganizationStore,
  MemoryVault,
  Projections,
} from '@lw/events';
import { loadCatalog } from '@lw/playbook-sdk';
import { createPlatforms } from '@lw/platforms';
import { SITECORE_DEFAULTS } from '@lw/connectors';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { IntakeService } from '../src/intake';

const PLAYBOOKS = fileURLToPath(new URL('../../../playbooks', import.meta.url));
const SECRET = 'env-secret-value-WXYZ';

/** A fake Sitecore that accepts one environment client and one preview Context ID. */
const fakeSitecore = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
  if (url.endsWith('/oauth/token'))
    return body.client_id === 'env-id' && body.client_secret === SECRET
      ? json(200, { access_token: 'jwt', expires_in: 900 })
      : json(401, { error: 'access_denied' });
  if (url.includes('/sitecore/api/authoring/graphql/v1/'))
    return json(200, { data: { sites: [{ name: 'site' }] } });
  if (/sitecoreContextId=ctx-preview-1234/.test(url))
    return json(200, { data: { site: { siteInfoCollection: [] } } });
  return json(404, {});
}) as typeof fetch;

const intake = (name: string): ProjectIntakeInput => ({
  playbookId: 'sitecoreai-migration',
  name,
  client: name,
  budgets: { usd: 900, tokens: 6_000_000, hours: 200 },
  source: { repo: null, branch: 'main', url: 'https://www.example.com' },
  target: {
    cmHost: 'https://xmc-tenant.sitecorecloud.io',
    siteCollection: 'site',
    site: 'site',
    languages: ['en'],
    hostingProject: `${name.toLowerCase().replace(/\W+/g, '-')}-website`,
  },
  brief: { personalization: 'no', accessibility: 'WCAG 2.2 AA', codeExtraction: 'Yes' },
  credentials: {
    'sitecore-environment': { clientId: 'env-id', clientSecret: SECRET },
    'edge-preview': { contextId: 'ctx-preview-1234' },
  },
});

/** Each person signs in with their own API key, recorded under their login. */
const KEYS = { alice: 'a1', bob: 'b2', carol: 'c3' } as const;
type Who = keyof typeof KEYS;
const keyOf = (who: Who) => `lwk_${KEYS[who].repeat(20)}`;

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function start() {
  const store = new InMemoryEventStore();
  const projections = new Projections(store);
  await projections.start();
  const orgs = new MemoryOrganizationStore();
  // Alice is Icreon's; Bob is Acme's; Carol signs in but belongs nowhere.
  const acme = await orgs.create({ name: 'Acme Corp', slug: 'acme' });
  await orgs.setMember(DEFAULT_ORGANIZATION, githubSubject('alice'), 'director', 'test');
  await orgs.setMember(acme.id, githubSubject('bob'), 'director', 'test');
  const playbooks = await loadCatalog(PLAYBOOKS);
  for (const e of playbooks.values()) e.playbook.manifest.intake.source.repo = 'optional';
  app = await buildApp({
    store,
    projections,
    commands: () => undefined,
    organizations: orgs,
    intake: new IntakeService({
      store,
      catalog: playbooks,
      platforms: createPlatforms({ sitecore: { ...SITECORE_DEFAULTS, fetch: fakeSitecore } }),
      vault: new MemoryVault(),
      connections: new MemoryIntegrationStore(),
      organizations: orgs,
    }),
    auth: {
      clientId: 'client-1',
      clientSecret: 'shh',
      publicUrl: 'https://api.example.com',
      appUrl: 'https://app.example.com',
      operators: ['alice'],
      apiKeys: (Object.keys(KEYS) as Who[]).map((login) => ({
        login,
        sha256: createHash('sha256').update(keyOf(login)).digest('hex'),
      })),
      sessionSecret: 'x'.repeat(40),
      secureCookies: true,
    },
  });
  return { store, projections, orgs, acme };
}

const as =
  (who: Who, headers: Record<string, string> = {}) =>
  async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => {
    const r = await app!.inject({
      method,
      url,
      payload: payload as object,
      headers: { authorization: `Bearer ${keyOf(who)}`, ...headers },
    });
    return { status: r.statusCode, body: r.json() as any };
  };

describe('organizations', () => {
  it('files each project under its creator’s organization and shows it to that one only', async () => {
    const { orgs, acme } = await start();
    const alice = as('alice');
    const bob = as('bob');
    const a = await alice('POST', '/projects', intake('Icreon site'));
    const b = await bob('POST', '/projects', intake('Acme site'));
    expect([a.status, b.status]).toEqual([201, 201]);
    const [ours, theirs] = [a.body.projectId as string, b.body.projectId as string];
    const owners = await orgs.ownersOf([ours, theirs]);
    expect(owners.get(ours)).toBe(DEFAULT_ORGANIZATION);
    expect(owners.get(theirs)).toBe(acme.id);

    const ids = async (call: ReturnType<typeof as>, url: string) =>
      ((await call('GET', url)).body as { id?: string; projectId?: string }[]).map(
        (p) => p.projectId ?? p.id,
      );
    expect(await ids(alice, '/projects')).toEqual([ours]);
    expect(await ids(bob, '/projects')).toEqual([theirs]);
    expect(await ids(bob, '/portfolio')).toEqual([theirs]);
    const overview = (await bob('GET', '/portfolio/overview')).body;
    expect(overview.projects.map((p: { projectId: string }) => p.projectId)).toEqual([theirs]);

    // Another organization's project answers as if it didn't exist, on every project route.
    for (const url of [
      `/projects/${ours}/mission-control`,
      `/projects/${ours}/plan`,
      `/projects/${ours}/settings`,
      `/projects/${ours}/remix`,
    ]) {
      const r = await bob('GET', url);
      expect([url, r.status, r.body.error?.code]).toEqual([url, 404, 'unknown_project']);
    }
    expect((await alice('GET', `/projects/${ours}/mission-control`)).status).toBe(200);
    const write = await bob('PUT', `/projects/${ours}/brief`, { key: 'x', answer: 'y' });
    expect(write.status).toBe(404);
  });

  it('keeps saved connections in their organization', async () => {
    await start();
    const alice = as('alice');
    const bob = as('bob');
    const ours = (await alice('POST', '/projects', intake('Icreon site'))).body.projectId;
    // Bob can't save a connection from Icreon's project…
    const stolen = await bob('POST', '/connections', { name: 'Tenant', fromProject: ours });
    expect(stolen.status).toBe(404);
    const saved = await alice('POST', '/connections', { name: 'Tenant', fromProject: ours });
    expect(saved.status).toBe(201);
    const id = saved.body.connectionId as string;
    expect((await alice('GET', '/connections')).body.map((c: { id: string }) => c.id)).toEqual([
      id,
    ]);
    // …nor see it, nor start a project from it, nor rotate its secret.
    expect((await bob('GET', '/connections')).body).toEqual([]);
    const { credentials: _, ...rest } = intake('Acme site');
    const reuse = await bob('POST', '/projects', { ...rest, credentials: {}, connectionId: id });
    expect([reuse.status, reuse.body.error?.code]).toEqual([404, 'unknown_connection']);
    const rotate = await bob('PUT', `/connections/${id}/credentials/sitecore-environment`, {
      secret: { clientId: 'env-id', clientSecret: SECRET },
    });
    expect(rotate.status).toBe(404);
  });

  it('turns away people who belong nowhere, and organizations they aren’t in', async () => {
    await start();
    const carol = await as('carol')('GET', '/projects');
    expect([carol.status, carol.body.error.code]).toEqual([403, 'no_organization']);
    const elsewhere = await as('alice', { 'x-lw-organization': 'acme' })('GET', '/projects');
    expect([elsewhere.status, elsewhere.body.error.code]).toEqual([403, 'not_a_member']);
    expect((await as('alice', { 'x-lw-organization': 'icreon' })('GET', '/projects')).status).toBe(
      200,
    );
    expect((await as('carol')('GET', '/health')).status).toBe(200);
  });

  it('acts in the organization asked for when someone belongs to several', async () => {
    const { acme, orgs } = await start();
    await orgs.setMember(acme.id, githubSubject('alice'), 'watcher', 'test');
    const theirs = (await as('bob')('POST', '/projects', intake('Acme site'))).body.projectId;
    const inAcme = as('alice', { 'x-lw-organization': acme.id });
    expect((await inAcme('GET', '/projects')).body.map((p: any) => p.id)).toEqual([theirs]);
    expect((await as('alice')('GET', '/projects')).body).toEqual([]);
    const me = (await inAcme('GET', '/me/organizations')).body;
    expect(me.current).toEqual({ id: acme.id, name: 'Acme Corp', slug: 'acme', role: 'watcher' });
    expect(me.organizations.map((o: { slug: string; role: string }) => [o.slug, o.role])).toEqual([
      ['icreon', 'director'],
      ['acme', 'watcher'],
    ]);
  });

  it('gives a project written without an owner (a demo, a seed) to Icreon', async () => {
    const { store } = await start();
    await store.append('prj-demo', [
      {
        type: 'project.status',
        actor: { kind: 'system', id: 'seed' },
        subject: { kind: 'project', id: 'prj-demo' },
        severity: 'routine',
        data: { status: 'running' },
      },
    ]);
    expect((await as('bob')('GET', '/projects/prj-demo/mission-control')).status).toBe(404);
    expect((await as('bob')('GET', '/projects')).body).toEqual([]);
  });
});
