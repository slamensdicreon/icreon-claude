import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { ProjectIntakeInput } from '@lw/contracts';
import {
  DEFAULT_ORGANIZATION,
  githubSubject,
  InMemoryEventStore,
  MemoryIntegrationStore,
  MemoryLicenseStore,
  MemoryOrganizationStore,
  MemoryTombstoneStore,
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

/** Icreon's admin console: its key, acting as Steve (steve@icreon.com). */
const CONSOLE = 'console-key-'.padEnd(48, 'k');
const consoleAuth = {
  adminConsoleKey: CONSOLE,
  consoleActor: async (email: string) =>
    email === 'steve@icreon.com' ? githubSubject('steve') : null,
};
const consoleHeaders = {
  authorization: `Bearer ${CONSOLE}`,
  'x-lw-actor-email': 'steve@icreon.com',
  'x-lw-organization': DEFAULT_ORGANIZATION,
};

const keyOf = (who: string) => `lwk_${createHash('sha256').update(who).digest('hex').slice(0, 40)}`;
const DAY = 86_400_000;
const T0 = Date.parse('2026-11-11T12:00:00Z');

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
  const acme = await orgs.create({ name: 'Acme Corp', slug: 'acme' });
  await orgs.setMember(DEFAULT_ORGANIZATION, githubSubject('steve'), 'director', 'test');
  await orgs.setMember(acme.id, githubSubject('bob'), 'director', 'test');
  const playbooks = await loadCatalog(PLAYBOOKS);
  for (const e of playbooks.values()) e.playbook.manifest.intake.source.repo = 'optional';
  const clock = { now: T0 };
  const controls: [string, string][] = [];
  const asked: string[] = [];
  app = await buildApp({
    store,
    projections,
    now: () => clock.now,
    // Every project "runs" here: the reconciler's pauses and resumes are recorded.
    commands: (id) =>
      ({
        control: async (cmd: { verb: string }) => void controls.push([id, cmd.verb]),
      }) as never,
    organizations: orgs,
    licenses: new MemoryLicenseStore(),
    // Vercel, for metering: one hosting project has builds, any other isn't in the team.
    buildUsage: async (name: string) => {
      asked.push(name);
      return name === 'acme-site-website'
        ? { deployments: 12, buildMs: 30 * 60_000, failed: 1 }
        : null;
    },
    purge: {
      store,
      tombstones: new MemoryTombstoneStore(),
      projects: () => projections.all(),
      now: () => clock.now,
    },
    intake: new IntakeService({
      store,
      catalog: playbooks,
      platforms: createPlatforms({ sitecore: { ...SITECORE_DEFAULTS, fetch: fakeSitecore } }),
      vault: new MemoryVault(),
      connections: new MemoryIntegrationStore(),
      organizations: orgs,
    }),
    auth: {
      clientId: 'gh',
      clientSecret: 'gh-secret',
      publicUrl: 'https://api.example.com',
      appUrl: 'https://app.example.com',
      operators: ['steve'],
      apiKeys: ['steve', 'bob'].map((login) => ({
        login,
        sha256: createHash('sha256').update(keyOf(login)).digest('hex'),
      })),
      sessionSecret: 'x'.repeat(40),
      secureCookies: true,
      ...consoleAuth,
    },
  });
  return { store, acme, clock, controls, asked };
}

const as =
  (who: string) => async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => {
    const r = await app!.inject({
      method,
      url,
      payload: payload as object,
      // Icreon's administration goes through its admin console; the product, through a key.
      headers:
        who === 'steve' && /^\/(admin|portfolio\/licenses)/.test(url)
          ? consoleHeaders
          : { authorization: `Bearer ${keyOf(who)}` },
    });
    return { status: r.statusCode, body: r.body ? (r.json() as any) : null };
  };
const steve = as('steve');
const bob = as('bob');
const migration = (name: string) => intake(name);
const homepage = (name: string) => ({ ...intake(name), playbookId: 'sitecoreai-homepage-demo' });
const grant = (orgId: string, extra: Record<string, unknown> = {}) =>
  steve('PUT', `/admin/organizations/${orgId}/license`, {
    entities: ['sitecoreai'],
    playbooks: ['sitecoreai-migration'],
    projectsIncluded: 1,
    startsAt: new Date(T0 - DAY).toISOString(),
    endsAt: new Date(T0 + 365 * DAY).toISOString(),
    ...extra,
  });

describe('licenses', () => {
  it('starts nothing without a license; Icreon needs none', async () => {
    await start();
    const r = await bob('POST', '/projects', migration('Acme site'));
    expect([r.status, r.body.error.code]).toEqual([409, 'no_license']);
    expect((await steve('POST', '/projects', migration('Icreon site'))).status).toBe(201);
    const catalog = (await bob('GET', '/playbooks')).body as { licensed: boolean }[];
    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog.every((p) => p.licensed === false)).toBe(true);
    expect(
      ((await steve('GET', '/playbooks')).body as { licensed: boolean }[]).every((p) => p.licensed),
    ).toBe(true);
  });

  it('allows the licensed playbook up to the projects included, and frees a place on deletion', async () => {
    const { acme } = await start();
    expect((await grant(acme.id)).status).toBe(200);
    const first = await bob('POST', '/projects', migration('Acme site'));
    expect(first.status).toBe(201);
    const second = await bob('POST', '/projects', migration('Acme second site'));
    expect([second.status, second.body.error.code]).toEqual([409, 'no_project_left']);
    const other = await bob('POST', '/projects', homepage('Acme demo'));
    expect([other.status, other.body.error.code]).toEqual([409, 'not_licensed']);
    const catalog = (await bob('GET', '/playbooks')).body as { id: string; licensed: boolean }[];
    expect(catalog.filter((p) => p.licensed).map((p) => p.id)).toEqual(['sitecoreai-migration']);
    expect((await bob('GET', '/organization/license')).body).toMatchObject({
      standing: 'active',
      used: 1,
      projectsIncluded: 1,
    });
    // Archive, then ask for deletion: the place is free again.
    const id = first.body.projectId as string;
    await bob('POST', `/projects/${id}/archive`, { confirmation: 'Acme site' });
    const del = await bob('POST', `/projects/${id}/deletion`, { confirmation: 'Acme site' });
    expect(del.status).toBe(200);
    expect((await bob('GET', '/organization/license')).body.used).toBe(0);
    expect((await bob('POST', '/projects', migration('Acme second site'))).status).toBe(201);
    // Now the deleted one can't come back: its place is taken.
    const back = await app!.inject({
      method: 'DELETE',
      url: `/projects/${id}/deletion`,
      headers: { authorization: `Bearer ${keyOf('bob')}` },
    });
    expect([back.statusCode, back.json().error.code]).toEqual([409, 'no_project_left']);
  });

  it('pauses the organization at the end of the term, keeps it read only, and resumes on renewal', async () => {
    const { store, acme, clock, controls } = await start();
    await grant(acme.id, { projectsIncluded: 3, endsAt: new Date(T0 + 30 * DAY).toISOString() });
    const id = (await bob('POST', '/projects', migration('Acme site'))).body.projectId as string;
    await store.append(id, [
      {
        type: 'project.status',
        actor: { kind: 'system', id: 'test' },
        subject: { kind: 'project', id },
        severity: 'routine',
        data: { status: 'running' },
      },
    ]);
    // The term ends.
    clock.now = T0 + 31 * DAY;
    const ended = await bob('PUT', `/projects/${id}/brief`, { key: 'x', answer: 'y' });
    expect([ended.status, ended.body.error.code]).toEqual([403, 'license_ended']);
    expect((await bob('GET', `/projects/${id}/mission-control`)).status).toBe(200);
    expect((await bob('GET', '/organization/license')).body).toMatchObject({
      standing: 'ended',
      exportUntil: new Date(T0 + 120 * DAY).toISOString(),
    });
    // Export stays open: documents and the (missing) repository, until 90 days after the end.
    const exported = await bob('GET', `/projects/${id}/export`);
    expect(exported.status).toBe(200);
    expect(exported.body).toMatchObject({
      documents: `/projects/${id}/documents.zip`,
      repository: null,
      hostingProject: 'acme-site-website',
      availableUntil: new Date(T0 + 120 * DAY).toISOString(),
    });
    const check = await steve('GET', '/portfolio/licenses');
    expect(check.body.results).toEqual([
      { organizationId: acme.id, action: 'suspended', projects: [id] },
    ]);
    expect(controls).toEqual([[id, 'pause']]);
    // A second run changes nothing.
    expect((await steve('GET', '/portfolio/licenses')).body.results).toEqual([]);
    // Renewal resumes exactly what was paused.
    const renewed = await grant(acme.id, {
      projectsIncluded: 3,
      endsAt: new Date(T0 + 400 * DAY).toISOString(),
    });
    expect(renewed.body.reconciled).toEqual({
      organizationId: acme.id,
      action: 'resumed',
      projects: [id],
    });
    expect(controls).toEqual([
      [id, 'pause'],
      [id, 'resume'],
    ]);
    expect((await bob('PUT', `/projects/${id}/brief`, { key: 'x', answer: 'y' })).status).not.toBe(
      403,
    );
    const history = (await steve('GET', `/admin/organizations/${acme.id}/license`)).body.history;
    // Long after a term that wasn't renewed, export closes.
    await grant(acme.id, { projectsIncluded: 3, endsAt: new Date(T0 + 40 * DAY).toISOString() });
    clock.now = T0 + 140 * DAY;
    const closed = await bob('GET', `/projects/${id}/export`);
    expect([closed.status, closed.body.error.code]).toEqual([410, 'export_closed']);
    expect(history.map((h: { kind: string }) => h.kind)).toEqual([
      'granted',
      'suspended',
      'changed',
      'resumed',
    ]);
  });

  it('pauses projects on a platform taken out of the license, and resumes them when it is back', async () => {
    const { store, acme, controls } = await start();
    await grant(acme.id, { projectsIncluded: 3 });
    const id = (await bob('POST', '/projects', migration('Acme site'))).body.projectId as string;
    await store.append(id, [
      {
        type: 'project.status',
        actor: { kind: 'system', id: 'test' },
        subject: { kind: 'project', id },
        severity: 'routine',
        data: { status: 'running' },
      },
    ]);
    // The customer moves to another platform: SitecoreAI comes out of the license.
    const moved = await grant(acme.id, {
      projectsIncluded: 3,
      entities: ['optimizely'],
      playbooks: [],
    });
    expect(moved.body.reconciled).toEqual({
      organizationId: acme.id,
      action: 'suspended',
      projects: [id],
    });
    const write = await bob('PUT', `/projects/${id}/brief`, { key: 'x', answer: 'y' });
    expect([write.status, write.body.error.code]).toEqual([403, 'platform_not_licensed']);
    expect((await bob('GET', `/projects/${id}/export`)).status).toBe(200);
    const back = await grant(acme.id, { projectsIncluded: 3 });
    expect(back.body.reconciled).toEqual({
      organizationId: acme.id,
      action: 'resumed',
      projects: [id],
    });
    expect(controls).toEqual([
      [id, 'pause'],
      [id, 'resume'],
    ]);
  });

  it('purges the organization’s data once export has closed, and only then', async () => {
    const { store, acme, clock } = await start();
    await grant(acme.id, { projectsIncluded: 3, endsAt: new Date(T0 + 10 * DAY).toISOString() });
    const id = (await bob('POST', '/projects', migration('Acme site'))).body.projectId as string;
    // The term has ended, but export is still open: nothing goes.
    clock.now = T0 + 50 * DAY;
    await steve('GET', '/portfolio/licenses');
    expect(await store.head(id)).toBeGreaterThan(0);
    // 90 days after the end, it does: the project and its log, with a tombstone left.
    clock.now = T0 + 101 * DAY;
    const run = await steve('GET', '/portfolio/licenses');
    expect(run.body.results).toContainEqual({
      organizationId: acme.id,
      action: 'purged',
      projects: [id],
      failed: [],
    });
    expect(await store.head(id)).toBe(0);
    const history = (await steve('GET', `/admin/organizations/${acme.id}/license`)).body;
    expect(history.license.purgedAt).not.toBeNull();
    expect(history.history.at(-1).kind).toBe('purged');
    // Once done, later runs leave it alone.
    expect((await steve('GET', '/portfolio/licenses')).body.results).toEqual([]);
  });

  it('meters what an organization costs: Claude, tool time and Vercel builds', async () => {
    const { store, acme, asked } = await start();
    await grant(acme.id, { projectsIncluded: 3 });
    const id = (await bob('POST', '/projects', migration('Acme site'))).body.projectId as string;
    const step = (server: string, minutesRan: number, n: number) => ({
      type: 'step.recorded' as const,
      actor: { kind: 'agent' as const, id: 'builder' },
      subject: { kind: 'task' as const, id: 't1' },
      severity: 'routine' as const,
      data: {
        stepId: `s${n}`,
        agentId: 'builder',
        taskId: 't1',
        toolServer: server,
        operation: 'run',
        resultCode: 0,
        durationMs: minutesRan * 60_000,
        tokens: 0,
        summary: 'ran',
      },
    });
    await store.append(id, [step('sandbox', 20, 1), step('sandbox', 10, 2), step('browser', 5, 3)]);
    const usage = await steve('GET', `/admin/organizations/${acme.id}/usage`);
    expect(usage.status).toBe(200);
    expect(usage.body.totals).toMatchObject({
      sandboxMinutes: 30,
      toolMinutes: 35,
      vercelDeployments: 12,
      vercelBuildMinutes: 30,
    });
    expect(usage.body.projects[0]).toMatchObject({
      name: 'Acme site',
      toolMinutes: { sandbox: 30, browser: 5 },
      vercel: { hostingProject: 'acme-site-website', deployments: 12, failed: 1, buildMinutes: 30 },
      vercelNote: null,
    });
    // Vercel is asked once in a while, not on every load.
    await steve('GET', `/admin/organizations/${acme.id}/usage`);
    expect(asked).toEqual(['acme-site-website']);
    const list = (await steve('GET', '/admin/organizations')).body;
    expect(list.find((o: { id: string }) => o.id === acme.id).usage.sandboxMinutes).toBe(30);
    expect((await bob('GET', `/admin/organizations/${acme.id}/usage`)).status).toBe(403);
  });

  it('keeps license changes to Icreon', async () => {
    const { acme } = await start();
    const r = await bob('PUT', `/admin/organizations/${acme.id}/license`, {});
    expect([r.status, r.body.error.code]).toEqual([403, 'super_admin_only']);
    expect((await bob('GET', '/portfolio/licenses')).status).toBe(403);
    expect((await grant(DEFAULT_ORGANIZATION)).status).toBe(409);
    expect((await grant(acme.id, { endsAt: new Date(T0 - 2 * DAY).toISOString() })).status).toBe(
      422,
    );
  });
});
