import { createVerify, generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SettingsSnapshot, type ProjectIntakeInput } from '@lw/contracts';
import { InMemoryEventStore, MemoryIntegrationStore, MemoryVault, Projections } from '@lw/events';
import { loadPlaybook } from '@lw/playbook-sdk';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { GithubApp } from '../src/github';
import { IntakeService } from '../src/intake';
import { SITECORE_DEFAULTS } from '../src/verify';

const PLAYBOOK = fileURLToPath(new URL('../../../playbooks/sitecoreai-migration', import.meta.url));
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

/**
 * A fake GitHub: hands over the app on the manifest code, checks the app JWT against the key it
 * issued, and knows one installation on globex/website (branch main).
 */
function fakeGithub() {
  const gh = { installed: new Set(['globex/website']), tokensFor: [] as string[][] };
  const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
  const appJwtOk = (auth: string | null) => {
    const m = /^Bearer (.+)\.(.+)\.(.+)$/.exec(auth ?? '');
    if (!m) return false;
    const claims = JSON.parse(Buffer.from(m[2]!, 'base64url').toString());
    const now = Date.now() / 1000;
    return (
      claims.iss === 'Iv23-app' &&
      claims.iat <= now &&
      claims.exp > now &&
      claims.exp - claims.iat <= 600 &&
      createVerify('RSA-SHA256')
        .update(`${m[1]}.${m[2]}`)
        .verify(publicKey, Buffer.from(m[3]!, 'base64url'))
    );
  };
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const auth = headers.get('authorization');
    const p = url.pathname;
    if (p === '/app-manifests/good-code/conversions' && init?.method === 'POST') {
      return json(201, {
        id: 42,
        slug: 'icreon-launchworks',
        name: 'Icreon Launchworks',
        client_id: 'Iv23-app',
        client_secret: 'app-client-secret',
        webhook_secret: null,
        pem: PEM,
        html_url: 'https://github.com/apps/icreon-launchworks',
        owner: { login: 'slamensdicreon' },
      });
    }
    if (p.startsWith('/app-manifests/')) return json(404, {});
    if (p === '/app/installations') {
      if (!appJwtOk(auth)) return json(401, {});
      return json(200, [{ account: { login: 'globex' }, repository_selection: 'selected' }]);
    }
    let m = /^\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(p);
    if (m) {
      if (!appJwtOk(auth)) return json(401, {});
      return gh.installed.has(`${m[1]}/${m[2]}`) ? json(200, { id: 7 }) : json(404, {});
    }
    if (p === '/app/installations/7/access_tokens') {
      if (!appJwtOk(auth)) return json(401, {});
      const repos = JSON.parse(String(init?.body)).repositories as string[];
      gh.tokensFor.push(repos);
      return json(201, { token: 'ghs_installation' });
    }
    m = /^\/repos\/([^/]+)\/([^/]+)(\/branches\/(.+))?$/.exec(p);
    if (m) {
      if (auth !== 'token ghs_installation') return json(401, {});
      if (m[4]) return m[4] === 'main' ? json(200, { name: 'main' }) : json(404, {});
      return json(200, { private: true, default_branch: 'main' });
    }
    return json(404, {});
  }) as typeof globalThis.fetch;
  return { gh, fetch };
}

const intake = (repo: string): ProjectIntakeInput => ({
  name: 'Globex site',
  client: 'Globex',
  budgets: { usd: 900, tokens: 6_000_000, hours: 200 },
  source: { repo, branch: 'main', url: 'https://www.globex.example' },
  target: {
    cmHost: 'https://xmc-globex.sitecorecloud.io',
    siteCollection: 'globex',
    site: 'globex',
    languages: ['en'],
  },
  hosting: { provider: 'vercel', project: 'globex-website' },
  credentials: { environment: { clientId: 'env-id', clientSecret: 'env-secret-value-WXYZ' } },
});

const fakeSitecore = (async (input: string | URL | Request) =>
  String(input).endsWith('/oauth/token')
    ? new Response(JSON.stringify({ access_token: 'jwt', expires_in: 900 }), { status: 200 })
    : new Response(JSON.stringify({ data: { sites: [] } }), { status: 200 })) as typeof fetch;

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function start(opts: { auth?: boolean } = {}) {
  const store = new InMemoryEventStore();
  const projections = new Projections(store);
  await projections.start();
  const integrations = new MemoryIntegrationStore();
  const vault = new MemoryVault();
  const fake = fakeGithub();
  const github = new GithubApp({
    integrations,
    vault,
    publicUrl: 'https://lw.example',
    appUrl: 'https://lw.example',
    owner: { kind: 'user' },
    fetch: fake.fetch,
  });
  app = await buildApp({
    store,
    projections,
    commands: () => undefined,
    github,
    intake: new IntakeService({
      store,
      playbook: await loadPlaybook(PLAYBOOK),
      vault,
      verify: { ...SITECORE_DEFAULTS, fetch: fakeSitecore },
      github,
    }),
    auth: opts.auth
      ? {
          clientId: 'oauth',
          clientSecret: 'oauth-secret',
          publicUrl: 'https://lw.example',
          appUrl: 'https://lw.example',
          operators: ['director'],
          sessionSecret: 'x'.repeat(32),
          secureCookies: true,
        }
      : undefined,
  });
  return { app, integrations, fake };
}

const post = (url: string, payload: unknown = {}) =>
  app!.inject({ method: 'POST', url, payload: payload as object });

/** Runs the manifest flow the way the browser and GitHub would. */
async function connect() {
  const { action, manifest } = (await post('/integrations/github/manifest', { name: '' })).json();
  const state = new URL(action).searchParams.get('state')!;
  const r = await app!.inject(`/integrations/github/callback?code=good-code&state=${state}`);
  return { action, manifest: JSON.parse(manifest), r };
}

describe('GitHub App', () => {
  it('creates the app through the manifest flow and seals its keys', async () => {
    const { integrations } = await start();
    expect((await app!.inject('/integrations/github')).json()).toMatchObject({ connected: false });

    const { action, manifest, r } = await connect();
    expect(action).toMatch(/^https:\/\/github\.com\/settings\/apps\/new\?state=/);
    expect(manifest).toMatchObject({
      name: 'Launchworks',
      public: true,
      redirect_url: 'https://lw.example/integrations/github/callback',
      setup_url: 'https://lw.example/integrations/github/installed',
      default_permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
    });
    expect(manifest.hook_attributes).toBeUndefined();
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe('https://lw.example/?github=connected');

    const stored = JSON.stringify(await integrations.get('github.app'));
    expect(stored).not.toContain('PRIVATE KEY');
    expect(stored).not.toContain('app-client-secret');

    const status = (await app!.inject('/integrations/github')).json();
    expect(status).toMatchObject({
      connected: true,
      app: {
        slug: 'icreon-launchworks',
        owner: 'slamensdicreon',
        installUrl: 'https://github.com/apps/icreon-launchworks/installations/new',
      },
      installations: [{ account: 'globex', repositories: 'selected' }],
    });
    expect((await post('/integrations/github/manifest')).statusCode).toBe(409);
  });

  it('refuses a callback whose state it did not issue', async () => {
    await start();
    await post('/integrations/github/manifest');
    const r = await app!.inject('/integrations/github/callback?code=good-code&state=forged');
    expect(r.statusCode).toBe(302);
    const back = new URL(r.headers.location as string);
    expect(back.searchParams.get('github')).toBe('failed');
    expect((await app!.inject('/integrations/github')).json().connected).toBe(false);
  });

  it('checks a repository and branch with a token scoped to that repository', async () => {
    const { fake } = await start();
    const before = (
      await post('/intake/verify', { kind: 'github.repo', repo: 'globex/website' })
    ).json();
    expect(before).toMatchObject({ ok: false, detail: expect.stringMatching(/not set up yet/) });

    await connect();
    const ok = (
      await post('/intake/verify', { kind: 'github.repo', repo: 'globex/website' })
    ).json();
    expect(ok).toMatchObject({
      ok: true,
      detail: expect.stringMatching(/private.*Branch main found/),
    });
    expect(fake.gh.tokensFor).toEqual([['website']]);

    const branch = (
      await post('/intake/verify', { kind: 'github.repo', repo: 'globex/website', branch: 'dev' })
    ).json();
    expect(branch).toMatchObject({ ok: false, detail: expect.stringMatching(/no branch "dev"/) });

    const missing = (
      await post('/intake/verify', { kind: 'github.repo', repo: 'acme/site' })
    ).json();
    expect(missing).toMatchObject({
      ok: false,
      detail: expect.stringContaining(
        'https://github.com/apps/icreon-launchworks/installations/new',
      ),
    });
  });

  it('records repository access at intake, and picks up a later installation on re-check', async () => {
    const { fake } = await start();
    await connect();
    const { projectId } = (await post('/projects', intake('acme/site'))).json();
    const github = async () =>
      SettingsSnapshot.parse(
        (await app!.inject(`/projects/${projectId}/settings`)).json(),
      ).credentials.find((c) => c.credentialId === 'github')!;
    expect(await github()).toMatchObject({
      provided: false,
      ok: false,
      detail: expect.stringMatching(/not installed on acme\/site/),
    });

    fake.gh.installed.add('acme/site');
    expect((await post(`/projects/${projectId}/credentials/github/verify`)).statusCode).toBe(200);
    expect(await github()).toMatchObject({ provided: true, ok: true, system: 'GitHub App' });
  });

  it('lets client repository owners see the post-install page without signing in', async () => {
    await start({ auth: true });
    const page = await app!.inject(
      '/integrations/github/installed?installation_id=7&setup_action=install',
    );
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('installed');
    expect((await app!.inject('/integrations/github')).statusCode).toBe(401);
    expect((await app!.inject('/integrations/github/callback?code=x&state=y')).statusCode).toBe(
      401,
    );
  });
});
