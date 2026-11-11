import { fileURLToPath } from 'node:url';
import type { ProjectIntakeInput } from '@lw/contracts';
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
  const playbooks = await loadCatalog(PLAYBOOKS);
  for (const e of playbooks.values()) e.playbook.manifest.intake.source.repo = 'optional';
  const clock = { offset: 0 };
  app = await buildApp({
    store,
    projections,
    commands: () => undefined,
    now: () => Date.now() + clock.offset,
    intake: new IntakeService({
      store,
      catalog: playbooks,
      platforms: createPlatforms({ sitecore: { ...SITECORE_DEFAULTS, fetch: fakeSitecore } }),
      vault: new MemoryVault(),
      connections: new MemoryIntegrationStore(),
    }),
  });
  const id = (await app.inject({ method: 'POST', url: '/projects', payload: first })).json()
    .projectId as string;
  return { id, clock };
}

const handoff = async (id: string) => {
  const r = await app!.inject({
    method: 'POST',
    url: `/projects/${id}/credentials/sitecore-environment/handoff`,
    payload: {},
  });
  expect(r.statusCode).toBe(200);
  return new URL(r.json().url as string).pathname;
};
const submit = (path: string, form: Record<string, string>) =>
  app!.inject({
    method: 'POST',
    url: path,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(form).toString(),
  });

it('lets the client’s administrator enter a credential from a link, once', async () => {
  const { id } = await start();
  const path = await handoff(id);
  const page = await app!.inject({ method: 'GET', url: path });
  expect(page.statusCode).toBe(200);
  expect(page.headers['content-security-policy']).toContain("form-action 'self'");
  expect(page.body).toContain('Globex site');
  expect(page.body).toMatch(/type="password"/);

  // A wrong secret is refused by the service itself; the form comes back with why.
  const wrong = await submit(path, { clientId: 'env-id', clientSecret: 'nope' });
  expect(wrong.statusCode).toBe(422);
  expect(wrong.body).toContain('Check and save');

  const right = await submit(path, { clientId: 'env-id', clientSecret: SECRET });
  expect(right.statusCode).toBe(200);
  expect(right.body).toContain('Saved. Thank you.');
  expect(right.body).not.toContain(SECRET);
  // The link has done its job.
  const again = await app!.inject({ method: 'GET', url: path });
  expect([again.statusCode, again.body.includes('already saved')]).toEqual([410, true]);
});

it('refuses a link that was tampered with or has expired', async () => {
  const { id, clock } = await start();
  const path = await handoff(id);
  const forged = await app!.inject({ method: 'GET', url: path.slice(0, -3) + 'abc' });
  expect([forged.statusCode, forged.body.includes('not valid')]).toEqual([410, true]);
  clock.offset = 8 * 86_400_000;
  const late = await app!.inject({ method: 'GET', url: path });
  expect([late.statusCode, late.body.includes('expired')]).toEqual([410, true]);
  const unknown = await app!.inject({
    method: 'POST',
    url: `/projects/${id}/credentials/nothing/handoff`,
    payload: {},
  });
  expect(unknown.statusCode).toBe(404);
});
