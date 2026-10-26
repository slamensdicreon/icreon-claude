import { describe, expect, it } from 'vitest';
import {
  cmUrl,
  SITECORE_DEFAULTS,
  verifyContextId,
  verifyEnvironmentClient,
  verifyOrganizationClient,
  type VerifyConfig,
} from '../src';

/** A fake Sitecore: one valid client, one CM host with two sites, one valid Context ID. */
function fakeSitecore(opts: { cmStatus?: number; hang?: boolean; secretStatus?: number } = {}) {
  const calls: { url: string; body: unknown; auth: string | null }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const auth = new Headers(init?.headers).get('authorization');
    calls.push({ url, body, auth });
    if (opts.hang) {
      return new Promise((_, reject) =>
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })),
        ),
      );
    }
    const json = (status: number, b: unknown) =>
      new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (url === 'https://auth.sitecorecloud.io/oauth/token') {
      return body.client_id === 'good-id' && body.client_secret === 'good-secret'
        ? json(200, {
            access_token: 'jwt',
            expires_in: 900,
            scope: 'xmcloud.cm:admin',
            token_type: 'Bearer',
          })
        : json(401, { error: 'access_denied', error_description: 'Unauthorized' });
    }
    if (url.startsWith('https://xmc-acme.sitecorecloud.io/sitecore/api/authoring/graphql/v1/')) {
      if (auth !== 'Bearer jwt') return json(401, {});
      if (opts.cmStatus) return json(opts.cmStatus, {});
      return json(200, { data: { sites: [{ name: 'acme' }, { name: 'acme-careers' }] } });
    }
    if (url.startsWith('https://xmclouddeploy-api.sitecorecloud.io/api/environments/v1?')) {
      if (auth !== 'Bearer jwt') return json(401, {});
      return json(200, {
        data: [
          // An editing host is listed first, with the CM host of the environment it serves.
          {
            id: 'eh-1',
            name: 'basic-nextjs',
            projectName: 'brands',
            host: 'xmc-acme.sitecorecloud.io',
            type: 'eh',
            editingHostEnvironmentDetails: { cmEnvironmentId: 'env-1' },
          },
          {
            id: 'env-1',
            name: 'production',
            projectName: 'brands',
            host: 'xmc-acme.sitecorecloud.io',
            type: 'cm',
          },
        ],
      });
    }
    if (
      url ===
      'https://xmclouddeploy-api.sitecorecloud.io/api/environments/v1/env-1/obtain-editing-secret'
    ) {
      if (opts.secretStatus) return json(opts.secretStatus, { title: 'Forbidden' });
      return json(200, { apiKey: 'editing-secret' });
    }
    if (
      url.startsWith(
        'https://edge-platform.sitecorecloud.io/v1/content/api/graphql/v1?sitecoreContextId=',
      )
    ) {
      return new URL(url).searchParams.get('sitecoreContextId') === 'ctx-preview'
        ? json(200, { data: { site: { siteInfoCollection: [{ name: 'acme' }] } } })
        : json(401, {});
    }
    return json(404, {});
  }) as typeof fetch;
  const cfg: VerifyConfig = { ...SITECORE_DEFAULTS, fetch: fetchFn, timeoutMs: 200 };
  return { cfg, calls };
}

describe('Sitecore credential checks', () => {
  it('accepts an environment client that can list the sites on its CM host', async () => {
    const { cfg, calls } = fakeSitecore();
    const r = await verifyEnvironmentClient(cfg, {
      cmHost: 'xmc-acme.sitecorecloud.io',
      clientId: ' good-id ',
      clientSecret: 'good-secret',
    });
    expect(r).toMatchObject({ ok: true, sites: ['acme', 'acme-careers'] });
    expect(r.detail).toContain('2 sites: acme, acme-careers');
    expect(r.expiresAt).toBeTruthy();
    expect(calls[0]!.body).toEqual({
      client_id: 'good-id',
      client_secret: 'good-secret',
      audience: 'https://api.sitecorecloud.io',
      grant_type: 'client_credentials',
    });
    expect(calls[1]!.body).toEqual({ query: 'query { sites { name } }' });
  });

  it('says plainly when the secret is wrong, and never calls the CM host', async () => {
    const { cfg, calls } = fakeSitecore();
    const r = await verifyEnvironmentClient(cfg, {
      cmHost: 'https://xmc-acme.sitecorecloud.io',
      clientId: 'good-id',
      clientSecret: 'typo',
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/rejected this client ID and secret/);
    expect(calls).toHaveLength(1);
  });

  it('tells a token refused by the CM host apart from a bad secret', async () => {
    const { cfg } = fakeSitecore({ cmStatus: 403 });
    const r = await verifyEnvironmentClient(cfg, {
      cmHost: 'xmc-acme.sitecorecloud.io',
      clientId: 'good-id',
      clientSecret: 'good-secret',
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/token was issued, but xmc-acme\.sitecorecloud\.io refused it/);
  });

  it('only calls SitecoreAI hosts over https', () => {
    const cfg = SITECORE_DEFAULTS;
    expect(cmUrl(cfg, 'xmc-acme.sitecorecloud.io')).toBeInstanceOf(URL);
    expect(cmUrl(cfg, 'http://xmc-acme.sitecorecloud.io')).toMatch(/https/);
    expect(cmUrl(cfg, 'https://169.254.169.254')).toMatch(/SitecoreAI host/);
    expect(cmUrl(cfg, 'https://sitecorecloud.io.evil.example')).toMatch(/SitecoreAI host/);
  });

  it('checks an organization client against the project environment on the Deploy API', async () => {
    const good = { clientId: 'good-id', clientSecret: 'good-secret' };
    const ok = await verifyOrganizationClient(
      fakeSitecore().cfg,
      good,
      'xmc-acme.sitecorecloud.io',
    );
    expect(ok).toMatchObject({ ok: true });
    expect(ok.detail).toBe(
      'Deploy API reached: environment production (brands) for xmc-acme.sitecorecloud.io, and its editing secret can be read.',
    );
    const other = await verifyOrganizationClient(
      fakeSitecore().cfg,
      good,
      'xmc-other.sitecorecloud.io',
    );
    expect(other).toMatchObject({ ok: false });
    expect(other.detail).toMatch(/^The token was issued, but no environment .* xmc-other/);
    const denied = await verifyOrganizationClient(
      fakeSitecore({ secretStatus: 403 }).cfg,
      good,
      'xmc-acme.sitecorecloud.io',
    );
    expect(denied.detail).toBe(
      'Found the environment production (brands) for xmc-acme.sitecorecloud.io, but the Deploy API answered 403 reading the editing secret: Forbidden.',
    );
  });

  it('checks a Context ID against Experience Edge the way the Content SDK sends it', async () => {
    const { cfg, calls } = fakeSitecore();
    const ok = await verifyContextId(cfg, { contextId: 'ctx-preview', label: 'preview' });
    expect(ok).toMatchObject({ ok: true, sites: ['acme'] });
    const bad = await verifyContextId(cfg, { contextId: 'ctx-wrong', label: 'live' });
    expect(bad.ok).toBe(false);
    expect(bad.detail).toMatch(/live Context ID/);
    expect(calls[0]!.body).toEqual({ query: 'query { site { siteInfoCollection { name } } }' });
  });

  it('gives up on a host that does not answer, and says which one', async () => {
    const { cfg } = fakeSitecore({ hang: true });
    const r = await verifyOrganizationClient(cfg, { clientId: 'a', clientSecret: 'b' });
    expect(r).toMatchObject({ ok: false });
    expect(r.detail).toMatch(/auth\.sitecorecloud\.io did not answer/);
  });
});
