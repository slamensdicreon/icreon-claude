import { describe, expect, it } from 'vitest';
import { SITECORE_DEFAULTS } from '@lw/connectors';
import type { NewEvent } from '@lw/contracts';
import { createProjectState, type ProjectState } from '@lw/domain';
import { createPlatforms } from '@lw/platforms';
import { setUpHosting, type HostingWiring } from '../src/hosting';

const project = (platform = 'sitecoreai'): ProjectState =>
  ({
    ...createProjectState('p1'),
    mode: 'live',
    buildRepo: {
      repo: 'icreon-launchworks/acme-site',
      branch: 'main',
      appPath: 'examples/basic-nextjs',
    },
    intake: {
      platform,
      target: {
        hostingProject: 'acme-site',
        cmHost: 'xmc-acme.sitecorecloud.io',
        siteCollection: 'acme',
        site: 'acme',
        languages: ['en'],
      },
    },
  }) as never;

/** Vercel as the hosting tool calls it: one project, linked, with protection on until patched. */
function fakeVercel(opts: { refuseCreate?: boolean } = {}) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  let existing: Record<string, unknown> | null = null;
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path: url.pathname, body });
    const p = url.pathname;
    if (/^\/v9\/projects\/(acme-site|prj_1)$/.test(p) && method === 'GET')
      return existing ? json(200, existing) : json(404, { error: { message: 'Not found' } });
    if (p === '/v11/projects' && method === 'POST') {
      if (opts.refuseCreate) return json(403, { error: { message: 'Not allowed' } });
      existing = {
        id: 'prj_1',
        name: body.name,
        rootDirectory: body.rootDirectory,
        link: { type: 'github', org: 'icreon-launchworks', repo: 'acme-site' },
        ssoProtection: { deploymentType: 'all_except_custom_domains' },
      };
      return json(200, existing);
    }
    if (p === '/v9/projects/prj_1' && method === 'PATCH') {
      Object.assign(existing!, body);
      return json(200, existing);
    }
    if (p === '/v10/projects/acme-site/env' && method === 'POST')
      return json(201, { created: body, failed: [] });
    if (p === '/v13/deployments' && method === 'POST')
      return json(200, {
        id: body.target === 'production' ? 'dpl_prod' : 'dpl_int',
        readyState: 'QUEUED',
      });
    return json(404, { error: { message: `unexpected ${method} ${p}` } });
  }) as typeof globalThis.fetch;
  return { fetch: fake, calls };
}

function wiring(state: ProjectState, fetch: typeof globalThis.fetch) {
  const events: NewEvent[] = [];
  const w: HostingWiring = {
    token: 'vt',
    teamId: 'team_x',
    project: async () => state,
    platforms: createPlatforms({ sitecore: SITECORE_DEFAULTS }),
    // The vault: what intake sealed.
    credential: async (_id, credentialId): Promise<Record<string, string> | null> =>
      credentialId === 'edge-preview'
        ? { contextId: 'ctx-preview-secret' }
        : credentialId === 'editing-secret'
          ? { secret: 'editing-secret-value' }
          : null,
    tokenFor: async () => {
      throw new Error('the environment client was refused');
    },
    append: async (_id, e) => {
      events.push(...e);
    },
    fetch,
  };
  return { w, events };
}

describe('setUpHosting', () => {
  it("runs the agents' steps in order, with the head's environment from the vault", async () => {
    const vercel = fakeVercel();
    const { w } = wiring(project(), vercel.fetch);
    const r = await setUpHosting(w, 'p1');

    expect(r.editingHost).toBe('https://acme-site-editing.vercel.app');
    expect(r.steps.map((s) => [s.step, s.ok])).toEqual([
      ['Vercel project', true],
      ['Environment variables', true],
      ['Production build', true],
      ['Editing host build', true],
      // SitecoreAI: the site's rendering host is pointed at the editing address; here the
      // environment client is refused, and the step says so instead of throwing.
      ['Page builder rendering host', false],
    ]);
    expect(r.steps[4]!.summary).toContain('the environment client was refused');
    expect(r.steps.filter((s) => s.deploymentId).map((s) => s.deploymentId)).toEqual([
      'dpl_prod',
      'dpl_int',
    ]);

    // Protection off, as on every playbook run.
    const patch = vercel.calls.find((c) => c.method === 'PATCH')!;
    expect(patch.body).toMatchObject({ ssoProtection: null });
    // The secrets went to Vercel as sensitive values, and nowhere in the answer.
    const env = vercel.calls.find((c) => c.path.endsWith('/env'))!.body as {
      key: string;
      value: string;
      type: string;
    }[];
    expect(env).toContainEqual(
      expect.objectContaining({
        key: 'SITECORE_EDGE_CONTEXT_ID',
        value: 'ctx-preview-secret',
        type: 'sensitive',
      }),
    );
    expect(env).toContainEqual(
      expect.objectContaining({ key: 'SITECORE_EDITING_SECRET', type: 'sensitive' }),
    );
    const answer = JSON.stringify(r);
    expect(answer).not.toContain('ctx-preview-secret');
    expect(answer).not.toContain('editing-secret-value');
    // Production first (a new project's first deployment becomes production, whatever its
    // branch); then the integration branch, the editing host, as a preview.
    const deploys = vercel.calls.filter((c) => c.path === '/v13/deployments');
    expect(deploys.map((d) => (d.body as { gitSource: { ref: string } }).gitSource.ref)).toEqual([
      'main',
      'launchworks/integration',
    ]);
  });

  it('stops at the first step that fails', async () => {
    const vercel = fakeVercel({ refuseCreate: true });
    const { w } = wiring(project(), vercel.fetch);
    const r = await setUpHosting(w, 'p1');
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0]).toMatchObject({ step: 'Vercel project', ok: false });
    expect(vercel.calls.some((c) => c.path.endsWith('/env') || c.path === '/v13/deployments')).toBe(
      false,
    );
  });

  it('leaves the rendering host alone on a platform without one', async () => {
    const vercel = fakeVercel();
    const { w } = wiring(project('optimizely'), vercel.fetch);
    const r = await setUpHosting(w, 'p1');
    expect(r.steps.map((s) => s.step)).not.toContain('Page builder rendering host');
  });
});
