import type { BuildRepo } from '@lw/contracts';
import type { SecretVault } from '@lw/events';
import { MemoryIntegrationStore } from '@lw/events';
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GithubApp } from '../src';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

const repo: BuildRepo = {
  repo: 'lw-build/acme-site-sitecoreai',
  branch: 'main',
  installationId: 77,
  url: 'https://github.com/lw-build/acme-site-sitecoreai',
  template: 'Sitecore/xmcloud-starter-js',
  appPath: 'examples/basic-nextjs',
};

/** A GitHub that answers the repository read with `read` and the delete with `del`. */
function setup(read: { status: number; fullName?: string }, del = 204) {
  const calls: string[] = [];
  const json = (status: number, b: unknown) =>
    status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(b), { status });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const p = new URL(String(input)).pathname;
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${p}`);
    if (p === '/app/installations/77/access_tokens')
      return json(201, {
        token: 'ghs_org',
        expires_at: new Date(Date.now() + 3.6e6).toISOString(),
      });
    if (p === `/repos/${repo.repo}` && method === 'GET')
      return json(read.status, { full_name: read.fullName ?? repo.repo });
    if (p === `/repos/${repo.repo}` && method === 'DELETE')
      return json(del, { message: 'Must have admin rights to Repository.' });
    return json(404, {});
  }) as typeof globalThis.fetch;
  const integrations = new MemoryIntegrationStore();
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
    vault: { open: async () => pem } as unknown as SecretVault,
    publicUrl: 'http://api',
    appUrl: 'http://app',
    owner: { kind: 'user' },
    fetch,
  });
  return { app, calls };
}

describe('deleting a build repository', () => {
  it('deletes one still in our organization', async () => {
    const { app, calls } = setup({ status: 200 });
    expect(await app.deleteBuildRepo('lw-build', repo)).toMatchObject({ outcome: 'deleted' });
    expect(calls).toContain(`DELETE /repos/${repo.repo}`);
  });

  it('leaves one in another organization, or moved to the client, without deleting', async () => {
    const elsewhere = setup({ status: 200 });
    expect(
      await elsewhere.app.deleteBuildRepo('lw-build', { ...repo, repo: 'acme/site' }),
    ).toMatchObject({ outcome: 'handed_over' });
    expect(elsewhere.calls).toEqual([]);
    const moved = setup({ status: 200, fullName: 'acme/acme-site' });
    expect(await moved.app.deleteBuildRepo('lw-build', repo)).toMatchObject({
      outcome: 'handed_over',
      detail: expect.stringContaining('acme/acme-site'),
    });
    expect(moved.calls.some((c) => c.startsWith('DELETE'))).toBe(false);
  });

  it('records a refusal or a missing repository instead of failing', async () => {
    expect(await setup({ status: 200 }, 403).app.deleteBuildRepo('lw-build', repo)).toMatchObject({
      outcome: 'refused',
      detail: expect.stringContaining('Must have admin rights'),
    });
    expect(await setup({ status: 404 }).app.deleteBuildRepo('lw-build', repo)).toMatchObject({
      outcome: 'not_found',
    });
  });

  it('throws on an outage, so the purge tries again', async () => {
    await expect(setup({ status: 502 }).app.deleteBuildRepo('lw-build', repo)).rejects.toThrow(
      'GitHub answered 502',
    );
  });
});
