import { fileURLToPath } from 'node:url';
import type { Control, ProjectIntakeInput } from '@lw/contracts';
import {
  InMemoryEventStore,
  MemoryIntegrationStore,
  MemoryKnowledgeStore,
  MemoryRuleStore,
  MemoryTombstoneStore,
  MemoryVault,
  Projections,
} from '@lw/events';
import { MemoryBlobStore } from '@lw/tool-gateway';
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
  const clock = { t: Date.parse('2026-11-07T12:00:00Z') };
  const now = () => clock.t;
  const vault = new MemoryVault();
  const blobs = new MemoryBlobStore();
  const integrations = new MemoryIntegrationStore();
  const rules = new MemoryRuleStore();
  const knowledge = new MemoryKnowledgeStore();
  const tombstones = new MemoryTombstoneStore();
  const stopped: string[] = [];
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
    now,
    intake: new IntakeService({
      store,
      catalog: await loadCatalog(PLAYBOOKS),
      platforms: createPlatforms({ sitecore: { ...SITECORE_DEFAULTS, fetch: fakeSitecore } }),
      vault,
    }),
    artifactContent: async (_projectId, ref) => blobs.get(ref).catch(() => null),
    purge: {
      store,
      tombstones,
      stop: async (id) => void stopped.push(id),
      blobs,
      vault,
      integrations,
      rules,
      knowledge,
      now,
    },
  });
  const created = await post('/projects', intake);
  expect(created.statusCode, created.body).toBe(201);
  const { projectId } = created.json() as { projectId: string };
  return {
    store,
    projectId,
    controls,
    clock,
    vault,
    blobs,
    integrations,
    rules,
    knowledge,
    tombstones,
    stopped,
  };
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
    expect((await changeSource(projectId)).json()).not.toMatchObject({
      error: { code: 'archived' },
    });
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

  it('deletes an archived project after the grace period, leaving only its tombstone', async () => {
    const t = await start();
    const { store, projectId: id } = t;
    await store.append(id, [status(id, 'running'), status(id, 'completed')]);
    const del = (payload: unknown) => post(`/projects/${id}/deletion`, payload);

    // Only once archived, and only with the name typed.
    expect((await del({ confirmation: 'Globex site' })).json()).toMatchObject({
      error: { code: 'not_archived' },
    });
    await post(`/projects/${id}/archive`, { confirmation: 'Globex site' });
    expect((await del({ confirmation: 'nope' })).statusCode).toBe(422);
    expect((await del({ confirmation: 'Globex site' })).statusCode).toBe(200);
    const listed = async () =>
      (
        (await app!.inject({ method: 'GET', url: '/projects' })).json() as {
          id: string;
          deletion?: { due: string };
        }[]
      ).find((p) => p.id === id);
    const deletion = async () =>
      (
        (await app!.inject({ method: 'GET', url: `/projects/${id}/mission-control` })).json() as {
          project: { deletion?: { due: string; requestedBy: string } | null };
        }
      ).project.deletion;
    expect(await deletion()).toEqual({
      due: '2026-12-07T12:00:00.000Z',
      requestedBy: 'director',
      purging: false,
    });
    // Restoring waits for the deletion to be cancelled; cancelling and asking again both work.
    expect((await post(`/projects/${id}/restore`)).json()).toMatchObject({
      error: { code: 'deletion_scheduled' },
    });
    expect(
      (await app!.inject({ method: 'DELETE', url: `/projects/${id}/deletion` })).statusCode,
    ).toBe(200);
    expect(await deletion()).toBeNull();
    expect((await del({ confirmation: 'Globex site' })).statusCode).toBe(200);

    // What a run leaves: documents, credentials (sealed at intake), a replay, a saved connection,
    // a rule of its own, and a lesson it taught every project.
    const doc = await t.blobs.put(id, 'artifacts/page-inventory/v1.json', new Uint8Array([1]));
    await t.vault.seal(id, 'extra', 'a-secret-value');
    await t.integrations.put(`triage-replay:${id}`, { cards: 3 });
    await t.integrations.put('connection:c1', {
      createdFrom: { projectId: id, name: 'Globex site' },
    });
    await t.rules.create({
      when: 'w',
      then: 't',
      category: 'media',
      scope: { kind: 'project', id },
      author: 'director',
      status: 'active',
    });
    const lesson = (await t.knowledge.create({
      kind: 'lesson',
      status: 'active',
      scope: { kind: 'platform', id: 'sitecoreai' },
      title: 'Datasource first',
      text: 'Fill the datasource first.',
      evidence: [{ projectId: id, ref: 'artifact://x', label: 'Globex hero report' }],
      author: 'cypher',
      source: { doc: null, projectId: id, phase: 4 },
    }))!;

    const purge = async () =>
      (await app!.inject({ method: 'GET', url: '/portfolio/purge-due' })).json() as {
        purged: string[];
        failed: unknown[];
      };
    expect(await purge()).toEqual({ purged: [], failed: [] });
    t.clock.t = Date.parse('2026-12-08T00:00:00Z');
    expect(await purge()).toEqual({ purged: [id], failed: [] });

    expect(await listed()).toBeUndefined();
    expect(await store.head(id)).toBe(0);
    expect(t.stopped).toEqual([id]);
    await expect(t.blobs.get(doc)).rejects.toThrow();
    expect(await t.vault.deleteProject(id)).toBe(0);
    expect(await t.integrations.get(`triage-replay:${id}`)).toBeNull();
    expect(await t.integrations.get('connection:c1')).toEqual({ createdFrom: null });
    expect(await t.rules.list()).toEqual([]);
    expect((await t.knowledge.get(lesson.id))?.evidence[0]?.label).toBe(
      'Evidence from a deleted project',
    );
    const [tomb] = (await app!.inject({ method: 'GET', url: '/portfolio/deleted' })).json() as {
      projectId: string;
      name: string;
      finishedAt: string | null;
      steps: Record<string, unknown>;
    }[];
    expect(tomb).toMatchObject({ projectId: id, name: 'Globex site', requestedBy: 'director' });
    expect(tomb!.finishedAt).toBeTruthy();
    expect(
      (tomb!.steps.secrets as { result: { deleted: number } }).result.deleted,
    ).toBeGreaterThanOrEqual(1);
    expect(Object.keys(tomb!.steps)).toEqual([
      'workflow',
      'repository',
      'hosting',
      'connection',
      'blobs',
      'secrets',
      'integrations',
      'rules',
      'knowledge',
      'commands',
      'events',
    ]);
  });

  it('resumes a purge that failed part way, and refuses the project meanwhile', async () => {
    const t = await start();
    const { store, projectId: id } = t;
    await store.append(id, [status(id, 'running'), status(id, 'completed')]);
    await post(`/projects/${id}/archive`, { confirmation: 'Globex site' });
    await post(`/projects/${id}/deletion`, { confirmation: 'Globex site' });
    t.clock.t = Date.parse('2026-12-08T00:00:00Z');
    const deleteProject = t.blobs.deleteProject.bind(t.blobs);
    let fail = true;
    t.blobs.deleteProject = async (pid: string) => {
      if (fail) throw new Error('blob store unavailable');
      return deleteProject(pid);
    };
    const purge = async () =>
      (await app!.inject({ method: 'GET', url: '/portfolio/purge-due' })).json() as {
        purged: string[];
        failed: { projectId: string; error: string }[];
      };
    expect(await purge()).toMatchObject({
      purged: [],
      failed: [{ projectId: id, error: 'blob store unavailable' }],
    });
    // Under way: the project answers 410, reads included.
    const read = await app!.inject({ method: 'GET', url: `/projects/${id}/settings` });
    expect(read.statusCode).toBe(410);
    fail = false;
    expect(await purge()).toEqual({ purged: [id], failed: [] });
    expect(await store.head(id)).toBe(0);
    expect(t.stopped).toEqual([id]);
  });

  it('downloads every document, the activity log and a README in one zip', async () => {
    const t = await start();
    const { store, projectId: id } = t;
    const ref = await t.blobs.put(id, 'artifacts/page-inventory/v2.md', Buffer.from('# Pages\n'));
    const doc = (version: number, r: string | null) => ({
      type: 'artifact.versioned' as const,
      actor: { kind: 'agent' as const, id: 'content-analyst' },
      subject: { kind: 'artifact' as const, id: 'page-inventory' },
      severity: 'notable' as const,
      data: {
        artifactId: 'page-inventory',
        kind: 'inventory' as const,
        title: 'Page inventory',
        version,
        ref: r,
        format: 'markdown' as const,
      },
    });
    await store.append(id, [doc(1, null), doc(2, ref)]);
    const res = await app!.inject({ method: 'GET', url: `/projects/${id}/documents.zip` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toMatch(/Globex-site-documents-.*\.zip/);
    const text = res.rawPayload.toString('latin1');
    for (const name of ['documents/page-inventory-v2.md', 'activity.csv', 'README.txt'])
      expect(text).toContain(name);
    expect(res.rawPayload.subarray(0, 4).toString('hex')).toBe('504b0304');
  });
});
