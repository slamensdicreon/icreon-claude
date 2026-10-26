import { describe, expect, it } from 'vitest';
import { DeployClient, SitecoreDeployToolServer } from '../src';

const ctx = { projectId: 'p', token: 'org-jwt', role: 'deployment-engineer', taskId: 't' };

function fakeDeploy() {
  const puts: unknown[] = [];
  let hosts: Record<string, unknown>[] = [];
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer org-jwt');
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    // As the real API: a page size over 50 is refused with validation errors.
    if (url.pathname === '/api/environments/v1' && Number(url.searchParams.get('pageSize')) > 50)
      return json(400, { title: 'One or more validation errors occurred.' });
    if (url.pathname === '/api/environments/v1')
      return json(200, {
        data: [
          { id: 'env-other', name: 'other', host: 'xmc-other.sitecorecloud.io' },
          {
            id: 'env-1',
            name: 'production',
            projectName: 'brands',
            host: 'xmc-acme.sitecorecloud.io',
            previewContextId: 'must-not-leak',
          },
        ],
      });
    if (url.pathname === '/api/environments/v1/env-1/obtain-editing-secret')
      return json(200, { apiKey: 'editing-secret', edgeUrl: 'https://edge' });
    if (url.pathname === '/api/hosts/v1/environment/env-1' && method === 'GET')
      return hosts.length ? json(200, hosts) : json(404, { title: 'Not Found' });
    if (url.pathname === '/api/hosts/v1/environment/env-1' && method === 'PUT') {
      const b = JSON.parse(String(init!.body));
      puts.push(b);
      hosts = [{ id: 'h1', ...b }];
      return json(201, { id: 'h1', ...b });
    }
    return json(404, {});
  }) as typeof globalThis.fetch;
  return { fetch, puts };
}

const server = (fetch: typeof globalThis.fetch) =>
  new SitecoreDeployToolServer({
    facts: async () => ({
      cmHost: 'xmc-acme.sitecorecloud.io',
      headHosts: ['acme-site.vercel.app'],
    }),
    fetch,
  });

describe('SitecoreDeployToolServer', () => {
  it("finds the project's environment by CM host without returning its Context IDs", async () => {
    const r = await server(fakeDeploy().fetch).call('environment.read', {}, ctx);
    expect(r.body).toEqual({
      id: 'env-1',
      name: 'production',
      project: 'brands',
      host: 'xmc-acme.sitecorecloud.io',
      status: null,
    });
    expect(JSON.stringify(r)).not.toContain('must-not-leak');
  });

  it("registers only the project's own head, with the editing endpoints, and reads it back", async () => {
    const d = fakeDeploy();
    const s = server(d.fetch);
    expect((await s.call('editing-host.read', {}, ctx)).body).toEqual({ hosts: [] });
    const elsewhere = await s.call(
      'editing-host.register',
      { url: 'https://evil.example.com', applicationName: 'basic-nextjs' },
      ctx,
    );
    expect(elsewhere.code).toBe(422);
    const r = await s.call(
      'editing-host.register',
      { url: 'https://acme-site.vercel.app/', applicationName: 'basic-nextjs' },
      ctx,
    );
    expect(r.code).toBe(200);
    expect(d.puts).toEqual([
      {
        cmEnvironmentId: 'env-1',
        editingHostEnvironmentId: null,
        applicationName: 'basic-nextjs',
        renderingEngineEndpointUrl: 'https://acme-site.vercel.app/api/editing/render',
        renderingEngineApplicationUrl: 'https://acme-site.vercel.app',
        renderingEngineConfigUrl: 'https://acme-site.vercel.app/api/editing/config',
      },
    ]);
    const back = await s.call('editing-host.read', {}, ctx);
    expect(back.body).toMatchObject({ hosts: [{ applicationName: 'basic-nextjs' }] });
  });

  it('finds the CM environment when only its editing host carries the CM host', async () => {
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    const fetch = (async () =>
      json({
        data: [
          { id: 'env-cm', name: 'production', host: null, type: 'cm' },
          {
            id: 'env-eh',
            name: 'basic-nextjs',
            host: 'xmc-acme.sitecorecloud.io',
            type: 'eh',
            editingHostEnvironmentDetails: { cmEnvironmentId: 'env-cm' },
          },
        ],
      })) as unknown as typeof globalThis.fetch;
    const env = await new DeployClient('org-jwt', { fetch }).environmentFor(
      'xmc-acme.sitecorecloud.io',
    );
    expect('id' in env && env.id).toBe('env-cm');
  });

  it('reads the editing secret for the head, server-side', async () => {
    const c = new DeployClient('org-jwt', { fetch: fakeDeploy().fetch });
    const env = await c.environmentFor('XMC-ACME.sitecorecloud.io');
    expect('id' in env && env.id).toBe('env-1');
    expect(await c.editingSecret('env-1')).toEqual({ secret: 'editing-secret' });
    // An answer without a secret names its fields, never their values.
    const empty = new DeployClient('org-jwt', {
      fetch: (async () =>
        new Response(JSON.stringify({ apiKey: null, edgeUrl: 'https://edge' }), {
          status: 200,
        })) as unknown as typeof globalThis.fetch,
    });
    const none = await empty.editingSecret('env-1');
    expect('problem' in none && none.problem).toMatch(
      /its answer has apiKey \(empty\), edgeUrl\)\. Copy SITECORE_EDITING_SECRET/,
    );
    expect('problem' in none && none.problem).not.toMatch(/https:\/\/edge/);
    expect(await c.editingSecret('env-gone')).toEqual({
      problem: 'The Deploy API answered 404 reading the editing secret.',
    });
  });
});
