import { fileURLToPath } from 'node:url';
import type { Control, ProjectIntakeInput } from '@lw/contracts';
import { InMemoryEventStore, MemoryVault, Projections } from '@lw/events';
import { loadCatalog } from '@lw/playbook-sdk';
import { createPlatforms } from '@lw/platforms';
import { SITECORE_DEFAULTS } from '@lw/connectors';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import type { ProjectCommands } from '../src/commands';
import { IntakeService } from '../src/intake';

const PLAYBOOKS = fileURLToPath(new URL('../../../playbooks', import.meta.url));
const SECRET = 'env-secret-value-WXYZ';

/** A fake Sitecore that accepts the sample's credentials (as in intake.test.ts). */
const fakeSitecore = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  const json = (code: number, b: unknown) => new Response(JSON.stringify(b), { status: code });
  if (url.endsWith('/oauth/token'))
    return body.client_id === 'env-id' && body.client_secret === SECRET
      ? json(200, { access_token: 'jwt', expires_in: 900 })
      : json(401, { error: 'access_denied' });
  if (url.startsWith('https://xmc-globex.sitecorecloud.io/sitecore/api/authoring/graphql/v1/'))
    return json(200, { data: { sites: [{ name: 'globex' }] } });
  if (url.includes('sitecoreContextId=ctx-preview-1234'))
    return json(200, { data: { site: { siteInfoCollection: [] } } });
  return json(404, {});
}) as typeof fetch;

const intake: ProjectIntakeInput = {
  playbookId: 'sitecoreai-migration',
  name: 'Globex site',
  client: 'Globex',
  budgets: { usd: 900, tokens: 6_000_000, hours: 200 },
  source: { url: 'https://www.globex.example' },
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

/** An app whose orchestrator cancels a project the way the workflow does: it ends as cancelled. */
async function start() {
  const store = new InMemoryEventStore();
  const projections = new Projections(store);
  await projections.start();
  const controls: Control[] = [];
  const commands = (id: string) =>
    ({
      control: async (cmd: Control) => {
        controls.push(cmd);
        if (cmd.verb === 'cancel' && cmd.scope.kind === 'project')
          await store.append(id, [status(id, 'cancelled')]);
      },
    }) as unknown as ProjectCommands;
  app = await buildApp({
    store,
    projections,
    commands,
    intake: new IntakeService({
      store,
      catalog: await loadCatalog(PLAYBOOKS),
      platforms: createPlatforms({ sitecore: { ...SITECORE_DEFAULTS, fetch: fakeSitecore } }),
      vault: new MemoryVault(),
    }),
  });
  const created = await post('/projects', intake);
  expect(created.statusCode, created.body).toBe(201);
  const { projectId } = created.json() as { projectId: string };
  return { store, projectId, controls };
}

const status = (id: string, s: 'running' | 'paused' | 'completed' | 'cancelled') => ({
  type: 'project.status' as const,
  actor: { kind: 'system' as const, id: 'orchestrator' },
  subject: { kind: 'project' as const, id },
  severity: 'notable' as const,
  data: { status: s },
});
const post = (url: string, payload: unknown = {}) =>
  app!.inject({ method: 'POST', url, payload: payload as object });
const statusOf = async (id: string) =>
  (
    (await app!.inject({ method: 'GET', url: '/projects' })).json() as {
      id: string;
      status: string;
    }[]
  ).find((p) => p.id === id)?.status;
const changeSource = (id: string) =>
  app!.inject({
    method: 'PUT',
    url: `/projects/${id}/source`,
    payload: { url: 'https://globex.example/' },
  });

describe('archive and restore', () => {
  it('archives a paused project: cancels it first, then it is read-only until restored', async () => {
    const { store, projectId, controls } = await start();
    await store.append(projectId, [status(projectId, 'running')]);

    expect(
      (await post(`/projects/${projectId}/archive`, { confirmation: 'nope' })).statusCode,
    ).toBe(422);
    const running = await post(`/projects/${projectId}/archive`, { confirmation: 'Globex site' });
    expect(running.statusCode).toBe(409);
    expect(running.json()).toMatchObject({ error: { code: 'not_paused' } });

    await store.append(projectId, [status(projectId, 'paused')]);
    const archived = await post(`/projects/${projectId}/archive`, { confirmation: 'Globex site' });
    expect(archived.statusCode, archived.body).toBe(200);
    expect(controls).toEqual([{ verb: 'cancel', scope: { kind: 'project', id: projectId } }]);
    expect(await statusOf(projectId)).toBe('archived');
    const last = (await store.read(projectId)).filter((e) => e.type === 'project.status').at(-1);
    expect(last?.data).toEqual({ status: 'archived', previous: 'paused' });

    // Read-only: changes are refused, reads still work.
    const refused = await changeSource(projectId);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: { code: 'archived' } });
    expect(
      (await app!.inject({ method: 'GET', url: `/projects/${projectId}/settings` })).statusCode,
    ).toBe(200);
    expect(
      (await post(`/projects/${projectId}/archive`, { confirmation: 'Globex site' })).statusCode,
    ).toBe(409);

    // Restored as cancelled: it was cancelled on its way in.
    expect((await post(`/projects/${projectId}/restore`)).statusCode).toBe(200);
    expect(await statusOf(projectId)).toBe('cancelled');
    expect((await changeSource(projectId)).json()).not.toMatchObject({ error: { code: 'archived' } });
    expect((await post(`/projects/${projectId}/restore`)).statusCode).toBe(409);
  });

  it('archives a completed project without touching the orchestrator, and restores it as completed', async () => {
    const { store, projectId, controls } = await start();
    await store.append(projectId, [status(projectId, 'running'), status(projectId, 'completed')]);
    expect(
      (await post(`/projects/${projectId}/archive`, { confirmation: 'Globex site' })).statusCode,
    ).toBe(200);
    expect(controls).toEqual([]);
    expect((await post(`/projects/${projectId}/restore`)).statusCode).toBe(200);
    expect(await statusOf(projectId)).toBe('completed');
  });
});
