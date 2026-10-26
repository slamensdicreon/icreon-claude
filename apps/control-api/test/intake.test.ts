import { fileURLToPath } from 'node:url';
import {
  MissionControlSnapshot,
  SettingsSnapshot,
  type NewEvent,
  type PlaybookSummary,
  type ProjectIntakeInput,
  type ProjectListItem,
} from '@lw/contracts';
import { InMemoryEventStore, MemoryVault, Projections } from '@lw/events';
import { MemoryBlobStore } from '@lw/tool-gateway';
import { loadCatalog } from '@lw/playbook-sdk';
import { createPlatforms } from '@lw/platforms';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { IntakeService, type StartInput } from '../src/intake';
import { SITECORE_DEFAULTS, type VerifyConfig } from '@lw/connectors';

const PLAYBOOKS = fileURLToPath(new URL('../../../playbooks', import.meta.url));
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

const intake = (over: ProjectIntakeInput['credentials'] = {}): ProjectIntakeInput => ({
  playbookId: 'sitecoreai-migration',
  name: 'Globex site',
  client: 'Globex',
  budgets: { usd: 900, tokens: 6_000_000, hours: 200 },
  source: { repo: 'globex/website', branch: 'main', url: 'https://www.globex.example' },
  target: {
    cmHost: 'https://xmc-globex.sitecorecloud.io',
    siteCollection: 'globex',
    site: 'globex',
    languages: ['en'],
    hostingProject: 'globex-website',
  },
  brief: {
    personalization: 'no',
    accessibility: 'WCAG 2.2 AA',
    codeExtraction: 'Yes',
  },
  credentials: {
    'sitecore-environment': { clientId: 'env-id', clientSecret: SECRET },
    'edge-preview': { contextId: 'ctx-preview-1234' },
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
      catalog: await loadCatalog(PLAYBOOKS),
      platforms: createPlatforms({ sitecore: verify }),
      vault: new MemoryVault(),
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
    const check = (credentialId: string, secret: object, target = {}) =>
      post('/intake/verify', {
        kind: 'credential',
        playbookId: 'sitecoreai-migration',
        credentialId,
        secret,
        target,
      });
    const ok = await check(
      'sitecore-environment',
      { clientId: 'env-id', clientSecret: SECRET },
      { cmHost: 'https://xmc-globex.sitecorecloud.io/' },
    );
    expect(ok.json()).toMatchObject({ ok: true, sites: ['globex'] });
    const bad = await check('edge-live', { contextId: 'nope' });
    expect(bad.json()).toMatchObject({ ok: false });
    expect((await check('jira-token', { token: 'x' })).statusCode).toBe(404);
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
    expect(mc.project.intake).toEqual({
      platform: 'sitecoreai',
      repo: 'globex/website',
      branch: 'main',
      target: {
        cmHost: 'xmc-globex.sitecorecloud.io',
        siteCollection: 'globex',
        site: 'globex',
        languages: ['en'],
        hostingProject: 'globex-website',
      },
    });
    expect(mc.project.playbook).toMatchObject({ id: 'sitecoreai-migration' });
    expect(mc.project.target).toMatchObject({
      collection: 'globex',
      hosting: 'Vercel, globex-website',
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

  it('lists the playbooks a project can run, with their charter and intake', async () => {
    await start();
    const list = (await app!.inject('/playbooks')).json() as PlaybookSummary[];
    const pb = list.find((p) => p.id === 'sitecoreai-migration')!;
    expect(pb.platform).toEqual({ id: 'sitecoreai', name: 'SitecoreAI' });
    expect(pb.charter.outcomes.map((o) => o.id)).toContain('marketer-autonomy');
    expect(pb.intake.source).toMatchObject({ repo: 'required', url: 'optional' });
    expect(pb.intake.steps.map((s) => s.title)).toEqual(['SitecoreAI', 'Edge and hosting']);
    expect(pb.intake.steps[0]!.credentials).toEqual([
      expect.objectContaining({
        credentialId: 'sitecore-environment',
        required: true,
        uses: ['cmHost'],
      }),
      expect.objectContaining({ credentialId: 'sitecore-organization', required: false }),
    ]);
    expect(JSON.stringify(list)).not.toContain('check');
  });

  it('refuses intake missing what the playbook requires, or carrying what it does not take', async () => {
    const { store } = await start();
    const noEnv = intake();
    delete noEnv.credentials!['sitecore-environment'];
    const r1 = await post('/projects', noEnv);
    expect(r1.statusCode).toBe(422);
    expect(r1.json().error.message).toBe('SitecoreAI environment client is required.');
    const r2 = await post('/projects', { ...intake(), target: { ...intake().target, site: '' } });
    expect(r2.json().error.message).toBe('Site is required.');
    const r3 = await post('/projects', intake({ 'jira-token': { token: 'x' } }));
    expect(r3.json().error.message).toMatch(/takes no "jira-token"/);
    const r4 = await post('/projects', { ...intake(), playbookId: 'optimizely-build' });
    expect(r4.statusCode).toBe(404);
    expect(await store.projectIds()).toEqual([]);
  });

  it('refuses intake when a credential fails, and stores nothing', async () => {
    const { store } = await start();
    const r = await post(
      '/projects',
      intake({ 'sitecore-environment': { clientId: 'env-id', clientSecret: 'typo' } }),
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
        playbookId: 'sitecoreai-migration',
        features: [],
      },
    ]);
  });

  it('records the brief, refuses a missing answer, and switches features on from it', async () => {
    const { started } = await start({ orchestrator: true });
    const missing = await post('/projects', { ...intake(), brief: { personalization: 'yes' } });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error.message).toMatch(/Accessibility target/);
    const wrong = await post('/projects', {
      ...intake(),
      brief: { ...intake().brief, accessibility: 'AAA please' },
    });
    expect(wrong.json().error.message).toMatch(/takes one of/);

    const r = await post('/projects', {
      ...intake(),
      brief: { ...intake().brief, personalization: 'yes', performance: 'LCP under 2.5 s' },
    });
    const { projectId } = r.json() as { projectId: string };
    const mc = MissionControlSnapshot.parse(
      (await app!.inject(`/projects/${projectId}/mission-control`)).json(),
    );
    expect(mc.project.brief).toContainEqual({
      key: 'performance',
      label: 'Performance budgets',
      answer: 'LCP under 2.5 s',
    });
    await post(`/projects/${projectId}/start`);
    expect(started.at(-1)!.features).toEqual(['personalization']);
  });

  it('answers the brief after intake, for a project created before it was asked', async () => {
    const { store } = await start();
    const { projectId } = (await post('/projects', intake())).json() as { projectId: string };
    const put = (answers: object) =>
      app!.inject({ method: 'PUT', url: `/projects/${projectId}/brief`, payload: { answers } });
    expect((await put({ personalization: 'maybe' })).statusCode).toBe(422);
    const ok = await put({ ...intake().brief, rights: 'All photography is licensed' });
    expect(ok.statusCode).toBe(200);
    const mc = MissionControlSnapshot.parse(
      (await app!.inject(`/projects/${projectId}/mission-control`)).json(),
    );
    expect(mc.project.brief.find((b) => b.key === 'rights')?.answer).toBe(
      'All photography is licensed',
    );
    expect((await store.read(projectId)).at(-1)).toMatchObject({ type: 'project.updated' });
  });

  it('changes an unchecked intake value before Start, and keeps checked ones fixed', async () => {
    const { started, store } = await start({ orchestrator: true });
    const { projectId } = (await post('/projects', intake())).json() as { projectId: string };
    const put = (key: string, value: unknown) =>
      app!.inject({
        method: 'PUT',
        url: `/projects/${projectId}/target/${key}`,
        payload: { value },
      });
    expect((await put('hostingProject', 'Globex Site')).statusCode).toBe(422);
    expect((await put('cmHost', 'xmc-other.sitecorecloud.io')).json().error.code).toBe(
      'checked_value',
    );
    expect((await put('nope', 'x')).statusCode).toBe(404);
    expect((await put('hostingProject', 'globex-sitecoreai')).statusCode).toBe(200);
    const mc = MissionControlSnapshot.parse(
      (await app!.inject(`/projects/${projectId}/mission-control`)).json(),
    );
    expect(mc.project.intake?.target.hostingProject).toBe('globex-sitecoreai');
    expect(mc.project.target?.hosting).toBe('Vercel, globex-sitecoreai');
    await post(`/projects/${projectId}/start`);
    expect(started).toHaveLength(1);
    // The run records its status as it starts.
    await store.append(projectId, [
      {
        type: 'project.status',
        actor: { kind: 'system', id: 'orchestrator' },
        subject: { kind: 'project', id: projectId },
        severity: 'routine',
        data: { status: 'running' },
      },
    ]);
    expect((await put('hostingProject', 'globex-later')).json().error.code).toBe('started');
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
    // Created on an older version of the playbook, with a smaller team.
    const created = (await store.read(projectId)).map((e) => ({
      type: e.type,
      actor: e.actor,
      subject: e.subject,
      severity: e.severity,
      at: e.ts,
      data:
        e.type === 'project.created'
          ? { ...e.data, playbook: { ...e.data.playbook, version: '0.1.0' }, roster: [] }
          : e.data,
    })) as NewEvent[];
    const team = (await store.read(projectId))[0]!;
    await store.reset(projectId);
    await store.append(projectId, created);
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
    // Back on the catalog's version, with its whole team.
    const after = (await store.read(projectId))[0]!;
    if (after.type !== 'project.created' || team.type !== 'project.created') throw new Error();
    expect(after.data.playbook).toEqual(team.data.playbook);
    expect(after.data.roster).toEqual(team.data.roster);
    expect(after.data.roster.length).toBeGreaterThan(0);
  });

  it('resets from intake too, and can let go of the build repository', async () => {
    const { store } = await start({ orchestrator: true });
    const { projectId } = (await post('/projects', intake())).json() as { projectId: string };
    const repo = {
      repo: 'lw-build/globex-sitecoreai',
      branch: 'main',
      installationId: 7,
      url: 'https://github.com/lw-build/globex-sitecoreai',
      template: 'Sitecore/xmcloud-starter-js',
      appPath: 'examples/basic-nextjs',
    };
    await store.append(projectId, [
      {
        type: 'project.updated',
        actor: { kind: 'director', id: 'director' },
        subject: { kind: 'project', id: projectId },
        severity: 'notable',
        data: {
          buildRepo: repo,
          hosting: { provider: 'vercel', project: 'globex-website', url: null },
          sourceUrl: 'https://anscollc.com/',
        },
      },
    ]);
    const reset = (newBuildRepo: boolean) =>
      post(`/projects/${projectId}/reset`, { confirmation: 'Globex site', newBuildRepo });
    const summary = async () =>
      MissionControlSnapshot.parse(
        (await app!.inject(`/projects/${projectId}/mission-control`)).json(),
      ).project;

    expect((await reset(false)).statusCode).toBe(200);
    expect((await summary()).buildRepo?.repo).toBe(repo.repo);

    expect((await reset(true)).statusCode).toBe(200);
    const p = await summary();
    expect(p).toMatchObject({ status: 'intake', buildRepo: null, hosting: null });
    expect(p.sourceUrl).toBe('https://anscollc.com/');
    expect((await store.read(projectId)).at(-1)).toMatchObject({
      data: { body: expect.stringMatching(/no longer builds in lw-build\/globex-sitecoreai/) },
    });
  });

  it('adds a credential intake did not have, and replaces one, only once it checks out', async () => {
    const { store } = await start();
    const { projectId } = (await post('/projects', intake())).json() as { projectId: string };
    const put = (id: string, secret: object) =>
      app!.inject({
        method: 'PUT',
        url: `/projects/${projectId}/credentials/${id}`,
        payload: { secret },
      });
    const before = (await store.read(projectId)).length;
    const bad = await put('sitecore-environment', { clientId: 'env-id', clientSecret: 'wrong' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.message).toMatch(/^SitecoreAI environment client:/);
    expect((await put('jira', { token: 'x' })).statusCode).toBe(404);
    expect((await put('edge-live', {})).statusCode).toBe(422);
    expect((await store.read(projectId)).length).toBe(before);

    const ok = await put('sitecore-environment', { clientId: 'env-id', clientSecret: SECRET });
    expect(ok.statusCode).toBe(200);
    const log = JSON.stringify(await store.read(projectId));
    expect(log).not.toContain(SECRET);
    const settings = SettingsSnapshot.parse(
      (await app!.inject(`/projects/${projectId}/settings`)).json(),
    );
    expect(
      settings.credentials.find((c) => c.credentialId === 'sitecore-environment'),
    ).toMatchObject({
      provided: true,
      ok: true,
      hint: 'WXYZ',
    });
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
