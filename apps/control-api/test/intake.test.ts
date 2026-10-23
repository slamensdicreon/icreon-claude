import { fileURLToPath } from 'node:url';
import {
  MissionControlSnapshot,
  SettingsSnapshot,
  type ProjectIntakeInput,
  type ProjectListItem,
} from '@lw/contracts';
import { InMemoryEventStore, MemoryVault, Projections } from '@lw/events';
import { MemoryBlobStore } from '@lw/tool-gateway';
import { loadPlaybook } from '@lw/playbook-sdk';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { IntakeService, type StartInput } from '../src/intake';
import { SITECORE_DEFAULTS, type VerifyConfig } from '@lw/connectors';

const PLAYBOOK = fileURLToPath(new URL('../../../playbooks/sitecoreai-migration', import.meta.url));
const SECRET = 'env-secret-value-WXYZ';

/** A fake Sitecore with one environment client, one CM host and one preview Context ID. */
const fakeSitecore = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
  if (url.endsWith('/oauth/token')) {
    return body.client_id === 'env-id' && body.client_secret === SECRET
      ? json(200, { access_token: 'jwt', expires_in: 900 })
      : json(401, { error: 'access_denied' });
  }
  if (url.startsWith('https://xmc-globex.sitecorecloud.io/sitecore/api/authoring/graphql/v1/')) {
    return json(200, { data: { sites: [{ name: 'globex' }] } });
  }
  if (url.includes('sitecoreContextId=ctx-preview-1234')) {
    return json(200, { data: { site: { siteInfoCollection: [] } } });
  }
  return json(404, {});
}) as typeof fetch;

const intake = (over: Partial<ProjectIntakeInput['credentials']> = {}): ProjectIntakeInput => ({
  name: 'Globex site',
  client: 'Globex',
  budgets: { usd: 900, tokens: 6_000_000, hours: 200 },
  source: { repo: 'globex/website', branch: 'main', url: 'https://www.globex.example' },
  target: {
    cmHost: 'https://xmc-globex.sitecorecloud.io',
    siteCollection: 'globex',
    site: 'globex',
    languages: ['en'],
  },
  hosting: { provider: 'vercel', project: 'globex-website' },
  credentials: {
    environment: { clientId: 'env-id', clientSecret: SECRET },
    edgePreviewContextId: 'ctx-preview-1234',
    ...over,
  },
});

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function start(opts: { orchestrator?: boolean } = {}) {
  const store = new InMemoryEventStore();
  const projections = new Projections(store);
  await projections.start();
  const started: StartInput[] = [];
  const stopped: string[] = [];
  const blobs = new MemoryBlobStore();
  const verify: VerifyConfig = { ...SITECORE_DEFAULTS, fetch: fakeSitecore };
  app = await buildApp({
    store,
    projections,
    commands: () => undefined,
    intake: new IntakeService({
      store,
      playbook: await loadPlaybook(PLAYBOOK),
      vault: new MemoryVault(),
      verify,
      start: opts.orchestrator ? async (input) => void started.push(input) : undefined,
      stop: opts.orchestrator ? async (id) => void stopped.push(id) : undefined,
      blobs,
    }),
  });
  return { app, store, started, stopped, blobs };
}

const post = (url: string, payload: unknown = {}) =>
  app!.inject({ method: 'POST', url, payload: payload as object });

describe('New Project wizard', () => {
  it('checks a credential without storing anything', async () => {
    const { store } = await start();
    const ok = await post('/intake/verify', {
      kind: 'sitecore.environment',
      cmHost: 'xmc-globex.sitecorecloud.io',
      clientId: 'env-id',
      clientSecret: SECRET,
    });
    expect(ok.json()).toMatchObject({ ok: true, sites: ['globex'] });
    const bad = await post('/intake/verify', { kind: 'edge.live', contextId: 'nope' });
    expect(bad.json()).toMatchObject({ ok: false });
    expect(await store.projectIds()).toEqual([]);
  });

  it('records a live project in intake, with credentials by reference only', async () => {
    const { store } = await start();
    const r = await post('/projects', intake());
    expect(r.statusCode).toBe(201);
    const { projectId, canStart } = r.json() as { projectId: string; canStart: boolean };
    expect(canStart).toBe(false);

    const log = JSON.stringify(await store.read(projectId));
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain('ctx-preview-1234');

    const list = (await app!.inject('/projects')).json() as ProjectListItem[];
    expect(list).toEqual([
      expect.objectContaining({ id: projectId, status: 'intake', demo: false }),
    ]);
    const mc = MissionControlSnapshot.parse(
      (await app!.inject(`/projects/${projectId}/mission-control`)).json(),
    );
    expect(mc.project.intake).toMatchObject({
      repo: 'globex/website',
      cmHost: 'xmc-globex.sitecorecloud.io',
    });

    const settings = SettingsSnapshot.parse(
      (await app!.inject(`/projects/${projectId}/settings`)).json(),
    );
    expect(settings.credentials.map((c) => [c.credentialId, c.provided, c.ok, c.hint])).toEqual([
      ['sitecore-environment', true, true, 'WXYZ'],
      ['edge-preview', true, true, '1234'],
      ['github', false, false, null],
    ]);
    expect(JSON.stringify(settings)).not.toContain('vault:');
  });

  it('refuses intake when a credential fails, and stores nothing', async () => {
    const { store } = await start();
    const r = await post(
      '/projects',
      intake({ environment: { clientId: 'env-id', clientSecret: 'typo' } }),
    );
    expect(r.statusCode).toBe(422);
    expect(r.json().error.message).toMatch(/^SitecoreAI environment client: Sitecore rejected/);
    expect(await store.projectIds()).toEqual([]);
  });

  it('refuses commands before the project starts, and says why it cannot start', async () => {
    await start();
    const { projectId } = (await post('/projects', intake())).json() as { projectId: string };
    const cmd = await post(`/projects/${projectId}/messages`, { body: 'status' });
    expect(cmd.statusCode).toBe(409);
    expect(cmd.json().error.code).toBe('not_started');
    const go = await post(`/projects/${projectId}/start`);
    expect(go.statusCode).toBe(503);
    expect(go.json().error.message).toMatch(/Temporal Cloud/);
  });

  it('starts the project on the orchestrator with what intake recorded', async () => {
    const { started } = await start({ orchestrator: true });
    const { projectId } = (await post('/projects', intake())).json() as { projectId: string };
    expect((await post(`/projects/${projectId}/start`)).statusCode).toBe(200);
    expect(started).toEqual([
      {
        projectId,
        name: 'Globex site',
        client: 'Globex',
        sourceUrl: 'https://www.globex.example',
        budgets: { usd: 900, tokens: 6_000_000, hours: 200 },
      },
    ]);
  });

  it('sets the source site after intake, for the crawl and the agents', async () => {
    const { store } = await start();
    const { projectId } = (await post('/projects', intake())).json() as { projectId: string };
    const put = (url: unknown) =>
      app!.inject({ method: 'PUT', url: `/projects/${projectId}/source`, payload: { url } });
    expect((await put('anscollc.com')).statusCode).toBe(400);
    expect((await put('https://anscollc.com/')).statusCode).toBe(200);
    const mc = MissionControlSnapshot.parse(
      (await app!.inject(`/projects/${projectId}/mission-control`)).json(),
    );
    expect(mc.project.sourceUrl).toBe('https://anscollc.com/');
    expect(mc.project.source.url).toBe('https://anscollc.com/');
    const last = (await store.read(projectId)).at(-1)!;
    expect(last).toMatchObject({ type: 'project.updated', actor: { kind: 'director' } });
  });

  it('resets a started project to intake, keeping what the Director gave it', async () => {
    const { store, stopped, blobs } = await start({ orchestrator: true });
    const { projectId } = (await post('/projects', intake())).json() as { projectId: string };
    await post(`/projects/${projectId}/start`);
    // What a run leaves behind: a status change, a step, a stored document.
    await store.append(projectId, [
      {
        type: 'project.status',
        actor: { kind: 'system', id: 'orchestrator' },
        subject: { kind: 'project', id: projectId },
        severity: 'routine',
        data: { status: 'running' },
      },
    ]);
    await blobs.put(projectId, 'artifacts/page-inventory/v1.json', new Uint8Array([1]));
    await app!.inject({
      method: 'PUT',
      url: `/projects/${projectId}/source`,
      payload: { url: 'https://anscollc.com/' },
    });

    expect((await post(`/projects/${projectId}/reset`, { confirmation: 'nope' })).statusCode).toBe(
      422,
    );
    expect(
      (await post(`/projects/${projectId}/reset`, { confirmation: 'Globex site' })).statusCode,
    ).toBe(200);

    expect(stopped).toEqual([projectId]);
    const types = (await store.read(projectId)).map((e) => e.type);
    expect(types).not.toContain('project.status');
    expect(types[0]).toBe('project.created');
    expect(types).toContain('project.updated');
    expect(types.at(-1)).toBe('cos.message');
    await expect(
      blobs.get(`blob://${projectId}/artifacts/page-inventory/v1.json`),
    ).rejects.toThrow();
    const mc = MissionControlSnapshot.parse(
      (await app!.inject(`/projects/${projectId}/mission-control`)).json(),
    );
    expect(mc.project).toMatchObject({ status: 'intake', sourceUrl: 'https://anscollc.com/' });
  });

  it('re-verifies a stored credential from the vault', async () => {
    await start();
    const { projectId } = (await post('/projects', intake())).json() as { projectId: string };
    const r = await post(`/projects/${projectId}/credentials/sitecore-environment/verify`);
    expect(r.statusCode).toBe(200);
    const settings = SettingsSnapshot.parse(
      (await app!.inject(`/projects/${projectId}/settings`)).json(),
    );
    expect(settings.credentials[0]).toMatchObject({
      ok: true,
      detail: expect.stringContaining('globex'),
    });
    const missing = await post(`/projects/${projectId}/credentials/sitecore-organization/verify`);
    expect(missing.statusCode).toBe(404);
  });
});
