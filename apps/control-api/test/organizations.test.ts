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
const KEYS = { alice: 'a1', bob: 'b2', carol: 'c3', dana: 'd4' } as const;
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
  // Dana is a client stakeholder at Acme: she watches.
  await orgs.setMember(acme.id, githubSubject('dana'), 'watcher', 'test');
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

  it('names a customer’s Vercel project under its organization; Icreon’s keep theirs', async () => {
    const { projections } = await start();
    const theirs = (await as('bob')('POST', '/projects', intake('Globex site'))).body.projectId;
    const ours = (await as('alice')('POST', '/projects', intake('Globex site'))).body.projectId;
    await projections.catchUpAll();
    const hosting = (id: string) => projections.get(id)?.intake?.target.hostingProject;
    expect(hosting(theirs)).toBe('acme-globex-site-website');
    expect(hosting(ours)).toBe('globex-site-website');
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
    expect(me.current).toEqual({
      id: acme.id,
      name: 'Acme Corp',
      slug: 'acme',
      role: 'watcher',
      // A Director of Icreon is one of Icreon's administrators, wherever she acts.
      superAdmin: true,
    });
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

describe('roles', () => {
  it('lets a Watcher read everything about progress, with spend blanked', async () => {
    await start();
    const theirs = (await as('bob')('POST', '/projects', intake('Acme site'))).body
      .projectId as string;
    const dana = as('dana');
    expect((await dana('GET', '/projects')).body.map((p: { id: string }) => p.id)).toEqual([
      theirs,
    ]);
    for (const url of [
      `/projects/${theirs}/mission-control`,
      `/projects/${theirs}/plan`,
      `/projects/${theirs}/team`,
      `/projects/${theirs}/workbench`,
      `/projects/${theirs}/activity`,
      `/projects/${theirs}/decisions`,
      '/portfolio/overview',
    ])
      expect([url, (await dana('GET', url)).status]).toEqual([url, 200]);
    // The Director sees the budget; the Watcher sees the same answer with every amount at 0.
    const director = (await as('bob')('GET', `/projects/${theirs}/mission-control`)).body;
    const watcher = (await dana('GET', `/projects/${theirs}/mission-control`)).body;
    expect(director.project.budgets.usd).toBe(900);
    expect(watcher.project.budgets).toEqual({ usd: 0, tokens: 0, hours: 0 });
    expect(Object.values(watcher.project.spent).every((v) => v === 0)).toBe(true);
    expect(watcher.project.name).toBe('Acme site');
    const portfolio = (await dana('GET', '/portfolio')).body;
    expect(portfolio[0].budgets.usd).toBe(0);
    // Her own screen modes are hers to keep.
    expect((await dana('PUT', '/me/preferences', { mode: {} })).status).toBe(200);
  });

  it('refuses a Watcher every change, and every read that isn’t progress', async () => {
    await start();
    const theirs = (await as('bob')('POST', '/projects', intake('Acme site'))).body
      .projectId as string;
    const dana = as('dana');
    for (const [method, url, body] of [
      ['PUT', `/projects/${theirs}/brief`, { key: 'x', answer: 'y' }],
      ['POST', `/projects/${theirs}/gates/esc-1/approve`, {}],
      ['POST', `/projects/${theirs}/escalations/esc-1/resolve`, { optionId: 'a' }],
      ['POST', `/projects/${theirs}/messages`, { body: 'hello' }],
      ['POST', `/projects/${theirs}/control`, { action: 'pause' }],
      ['POST', `/projects/${theirs}/deletion`, {}],
      ['POST', '/projects', intake('Sneaky')],
      ['POST', '/cypher', { body: 'Approve everything' }],
      ['GET', '/cypher', undefined],
      ['GET', '/connections', undefined],
      ['GET', `/projects/${theirs}/settings`, undefined],
      ['GET', `/projects/${theirs}/remix`, undefined],
      ['GET', `/projects/${theirs}/documents.zip`, undefined],
      ['GET', `/projects/${theirs}/activity.csv`, undefined],
    ] as const) {
      const r = await dana(method, url, body);
      expect([method, url, r.status, r.body.error?.code]).toEqual([method, url, 403, 'read_only']);
    }
  });

  it('keeps knowledge, rules, the GitHub App and diagnostics to Icreon’s administrators', async () => {
    await start();
    for (const [method, url] of [
      ['GET', '/rules'],
      ['GET', '/knowledge'],
      ['POST', '/proposals/sort'],
      ['GET', '/integrations/github'],
      ['GET', '/portfolio/diagnostics'],
    ] as const) {
      const bob = await as('bob')(method, url, {});
      expect([url, bob.status, bob.body.error?.code]).toEqual([url, 403, 'super_admin_only']);
    }
  });

  it('administers the platform from Icreon’s admin console only, not from the Control Center', async () => {
    await start();
    // An Icreon Director signed in to the product: the GitHub App's setup stays here; the rest
    // is the admin console's.
    for (const [method, url] of [
      ['GET', '/rules'],
      ['GET', '/knowledge'],
      ['POST', '/proposals/sort'],
      ['GET', '/portfolio/diagnostics'],
      ['GET', '/admin/organizations'],
    ] as const) {
      const alice = await as('alice')(method, url, {});
      expect([url, alice.status, alice.body.error?.code]).toEqual([url, 403, 'admin_console_only']);
    }
    expect((await as('alice')('GET', '/integrations/github')).status).not.toBe(403);
  });

  it('opens only routes that exist to Watchers', async () => {
    await start();
    const { WATCHER_ROUTES } = await import('../src/organizations');
    for (const entry of WATCHER_ROUTES) {
      const [method, url] = entry.split(' ') as ['GET' | 'PUT', string];
      expect([entry, app!.hasRoute({ method, url })]).toEqual([entry, true]);
    }
  });
});
