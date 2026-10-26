import type { SecretVault } from '@lw/events';
import { MemoryIntegrationStore } from '@lw/events';
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GithubApp, STARTER } from '../src';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

function setup(opts: {
  administration?: string;
  selection?: string;
  exists?: 'starter' | 'other' | 'used';
}) {
  const calls: string[] = [];
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
  let generated = false;
  let probes = 0;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const p = new URL(String(input)).pathname;
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${p}`);
    if (p === '/orgs/lw-build/installation')
      return json(200, {
        id: 77,
        repository_selection: opts.selection ?? 'all',
        permissions: { administration: opts.administration ?? 'write', contents: 'write' },
      });
    if (p === '/app/installations/77/access_tokens')
      return json(201, {
        token: 'ghs_org',
        expires_at: new Date(Date.now() + 3.6e6).toISOString(),
      });
    if (p === '/repos/lw-build/acme-site-sitecoreai' && method === 'GET')
      return opts.exists
        ? json(200, {
            default_branch: 'main',
            html_url: 'https://github.com/lw-build/acme-site-sitecoreai',
            private: true,
          })
        : json(404, {});
    if (p === '/repos/lw-build/acme-site-sitecoreai/branches')
      return json(
        200,
        opts.exists === 'used'
          ? [{ name: 'main' }, { name: 'launchworks/hero' }]
          : [{ name: 'main' }],
      );
    if (p === '/repos/lw-build/acme-site-sitecoreai/commits')
      return json(200, opts.exists === 'used' ? [{}, {}] : [{}]);
    if (p === `/repos/${STARTER.owner}/${STARTER.repo}/generate`) {
      generated = true;
      return json(201, {
        default_branch: 'main',
        html_url: 'https://github.com/lw-build/acme-site-sitecoreai',
        private: true,
      });
    }
    if (p === `/repos/lw-build/acme-site-sitecoreai/contents/${STARTER.appPath}/package.json`) {
      // GitHub fills a generated repository in the background.
      if (generated) return ++probes < 2 ? json(404, {}) : json(200, {});
      return opts.exists === 'other' ? json(404, {}) : json(200, {});
    }
    return json(404, {});
  }) as typeof globalThis.fetch;
  const integrations = new MemoryIntegrationStore();
  const vault = { open: async () => pem } as unknown as SecretVault;
  void integrations.put('github.app', {
    appId: 1,
    slug: 'lw',
    name: 'LW',
    clientId: 'Iv1',
    owner: 'lw',
    htmlUrl: 'https://github.com/apps/lw',
    privateKeyRef: 'ref',
    clientSecretRef: 'ref',
    webhookSecretRef: null,
    createdAt: new Date().toISOString(),
  });
  const app = new GithubApp({
    integrations,
    vault,
    publicUrl: 'http://api',
    appUrl: 'http://app',
    owner: { kind: 'user' },
    fetch,
  });
  return { app, calls };
}

describe('build repository', () => {
  it('generates it from the starter and waits until the app can be read back', async () => {
    const { app, calls } = setup({});
    const r = await app.createBuildRepo('lw-build', 'acme-site-sitecoreai', 'Acme');
    expect(r).toEqual({
      repo: 'lw-build/acme-site-sitecoreai',
      branch: 'main',
      installationId: 77,
      url: 'https://github.com/lw-build/acme-site-sitecoreai',
      template: 'Sitecore/xmcloud-starter-js',
      appPath: 'examples/basic-nextjs',
    });
    expect(calls.filter((c) => c.endsWith('/package.json'))).toHaveLength(2);
  }, 15_000);

  it('reuses an existing starter repository and refuses anything else', async () => {
    const reuse = setup({ exists: 'starter' });
    await expect(
      reuse.app.createBuildRepo('lw-build', 'acme-site-sitecoreai', 'Acme'),
    ).resolves.toMatchObject({
      repo: 'lw-build/acme-site-sitecoreai',
    });
    expect(reuse.calls.some((c) => c.includes('/generate'))).toBe(false);
    await expect(
      setup({ exists: 'other' }).app.createBuildRepo('lw-build', 'acme-site-sitecoreai', 'Acme'),
    ).rejects.toThrow("isn't built from Sitecore/xmcloud-starter-js");
    // An earlier run's repository is never handed to a new one.
    await expect(
      setup({ exists: 'used' }).app.createBuildRepo('lw-build', 'acme-site-sitecoreai', 'Acme'),
    ).rejects.toThrow('already has work in it (branches launchworks/hero)');
  });

  it('says what the organization installation is missing', async () => {
    await expect(
      setup({ administration: 'read' }).app.createBuildRepo('lw-build', 'x', 'X'),
    ).rejects.toThrow('Administration: Read and write');
    await expect(
      setup({ selection: 'selected' }).app.createBuildRepo('lw-build', 'x', 'X'),
    ).rejects.toThrow('"All repositories"');
  });
});
