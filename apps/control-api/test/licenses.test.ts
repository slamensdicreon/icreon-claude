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
    },
  });
  return { store, acme, clock, controls };
}

const as =
  (who: string) => async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => {
    const r = await app!.inject({
      method,
      url,
      payload: payload as object,
      headers: { authorization: `Bearer ${keyOf(who)}` },
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
