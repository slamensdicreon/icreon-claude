/**
 * Live checks for the credentials a project brings, run by the New Project wizard before anything
 * is stored and again from Settings ("Re-verify"). Each check calls the real service and answers
 * in words an operator can act on.
 *
 * - Automation clients: a client-credentials token request to Sitecore Cloud's auth server.
 * - The CM host: the Authoring and Management API's `sites` query, with the environment client's
 *   token. This proves the client and the host belong together.
 * - Experience Edge: a site query with the Context ID, as the Content SDK sends it.
 */

import { DeployClient } from './sitecore-deploy';

export interface VerifyResult {
  ok: boolean;
  /** One sentence: what worked, or what to fix. */
  detail: string;
  /** Sites the credential can see, when the check lists them. */
  sites?: string[];
  /** When the token issued by the check expires (automation clients). */
  expiresAt?: string | null;
}

export interface VerifyConfig {
  authUrl: string;
  audience: string;
  edgeUrl: string;
  /** Host suffixes a CM URL may have: the API calls it from the server, so not any host. */
  cmHostSuffixes: string[];
  /** The Deploy API; the organization client's check reads the project's environment there. */
  deployUrl?: string;
  fetch: typeof fetch;
  timeoutMs: number;
}

export const SITECORE_DEFAULTS: VerifyConfig = {
  authUrl: 'https://auth.sitecorecloud.io/oauth/token',
  audience: 'https://api.sitecorecloud.io',
  edgeUrl: 'https://edge-platform.sitecorecloud.io',
  cmHostSuffixes: ['.sitecorecloud.io'],
  deployUrl: 'https://xmclouddeploy-api.sitecorecloud.io',
  fetch: (...a) => fetch(...a),
  timeoutMs: 15_000,
};

async function call(
  cfg: VerifyConfig,
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown } | { error: string }> {
  try {
    const res = await cfg.fetch(url, { ...init, signal: AbortSignal.timeout(cfg.timeoutMs) });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, body };
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    return {
      error:
        name === 'TimeoutError'
          ? `${new URL(url).host} did not answer within ${cfg.timeoutMs / 1000} s.`
          : `${new URL(url).host} could not be reached.`,
    };
  }
}

/** A client-credentials token for an automation client (organization or environment). */
export async function sitecoreToken(
  cfg: VerifyConfig,
  clientId: string,
  clientSecret: string,
): Promise<{ ok: true; token: string; expiresAt: string | null; scope: string } | VerifyResult> {
  const r = await call(cfg, cfg.authUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId.trim(),
      client_secret: clientSecret.trim(),
      audience: cfg.audience,
      grant_type: 'client_credentials',
    }),
  });
  if ('error' in r) return { ok: false, detail: r.error };
  const b = (r.body ?? {}) as {
    access_token?: string;
    expires_in?: number;
    scope?: string;
    error_description?: string;
  };
  if (r.status === 200 && b.access_token) {
    return {
      ok: true,
      token: b.access_token,
      scope: b.scope ?? '',
      expiresAt: b.expires_in ? new Date(Date.now() + b.expires_in * 1000).toISOString() : null,
    };
  }
  if (r.status === 401 || r.status === 403) {
    return {
      ok: false,
      detail:
        'Sitecore rejected this client ID and secret. Check both were copied from the same automation client, and that it has not been revoked.',
    };
  }
  return {
    ok: false,
    detail: `Sitecore's auth server answered ${r.status}${b.error_description ? `: ${b.error_description}` : ''}.`,
  };
}

/** The CM host as a URL this server may call, or the reason it can't. */
export function cmUrl(cfg: VerifyConfig, host: string): URL | string {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//.test(host.trim()) ? host.trim() : `https://${host.trim()}`);
  } catch {
    return 'That is not a URL. Paste the CM host from the environment’s Details tab.';
  }
  if (url.protocol !== 'https:') return 'The CM host must use https.';
  if (!cfg.cmHostSuffixes.some((s) => url.hostname.endsWith(s))) {
    return `The CM host must be a SitecoreAI host (ending in ${cfg.cmHostSuffixes.join(' or ')}).`;
  }
  return new URL(url.origin);
}

/** Environment automation client + CM host: a token, then the Authoring API's site list. */
export async function verifyEnvironmentClient(
  cfg: VerifyConfig,
  input: { cmHost: string; clientId: string; clientSecret: string },
): Promise<VerifyResult> {
  const cm = cmUrl(cfg, input.cmHost);
  if (typeof cm === 'string') return { ok: false, detail: cm };
  const t = await sitecoreToken(cfg, input.clientId, input.clientSecret);
  if (!('token' in t)) return t;
  const r = await call(cfg, new URL('/sitecore/api/authoring/graphql/v1/', cm).href, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${t.token}` },
    body: JSON.stringify({ query: 'query { sites { name } }' }),
  });
  if ('error' in r) return { ok: false, detail: `The token was issued, but ${r.error}` };
  const b = (r.body ?? {}) as {
    data?: { sites?: { name: string }[] };
    errors?: { message: string }[];
  };
  if (r.status === 401 || r.status === 403) {
    return {
      ok: false,
      detail: `The token was issued, but ${cm.host} refused it. Use an environment automation client created for this environment, or an organization client.`,
    };
  }
  if (r.status !== 200 || !b.data) {
    return {
      ok: false,
      detail: `The token was issued, but the Authoring API on ${cm.host} answered ${r.status}${b.errors?.[0] ? `: ${b.errors[0].message}` : ''}.`,
    };
  }
  const sites = (b.data.sites ?? []).map((s) => s.name);
  return {
    ok: true,
    detail: sites.length
      ? `Authoring API on ${cm.host} reached. ${sites.length} site${sites.length === 1 ? '' : 's'}: ${sites.join(', ')}.`
      : `Authoring API on ${cm.host} reached. No sites yet; the team creates them in Foundation.`,
    sites,
    expiresAt: t.expiresAt,
  };
}

/**
 * Organization automation client: a token, then what the team needs it for on the Deploy API,
 * finding the project's environment by its CM host and reading its editing secret. A token alone
 * proved nothing about either.
 */
export async function verifyOrganizationClient(
  cfg: VerifyConfig,
  input: { clientId: string; clientSecret: string },
  cmHost?: string,
): Promise<VerifyResult> {
  const t = await sitecoreToken(cfg, input.clientId, input.clientSecret);
  if (!('token' in t)) return t;
  if (!cmHost) return { ok: true, detail: 'Organization client accepted.', expiresAt: t.expiresAt };
  const deploy = new DeployClient(t.token, { fetch: cfg.fetch, api: cfg.deployUrl });
  const env = await deploy.environmentFor(cmHost);
  if ('error' in env) return { ok: false, detail: `The token was issued, but ${lower(env.error)}` };
  const label = `${env.name ?? env.id}${env.projectName ? ` (${env.projectName})` : ''}`;
  const secret = await deploy.editingSecret(env.id);
  if ('problem' in secret)
    return {
      ok: false,
      detail: `Found the environment ${label} for ${cmHost}, but ${lower(secret.problem)}`,
    };
  return {
    ok: true,
    detail: `Deploy API reached: environment ${label} for ${cmHost}, and its editing secret can be read.`,
    expiresAt: t.expiresAt,
  };
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Experience Edge Context ID (preview or live): the site list through the Edge content API. */
export async function verifyContextId(
  cfg: VerifyConfig,
  input: { contextId: string; label: 'preview' | 'live' },
): Promise<VerifyResult> {
  const url = new URL('/v1/content/api/graphql/v1', cfg.edgeUrl);
  url.searchParams.set('sitecoreContextId', input.contextId.trim());
  const r = await call(cfg, url.href, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'query { site { siteInfoCollection { name } } }' }),
  });
  if ('error' in r) return { ok: false, detail: r.error };
  const b = (r.body ?? {}) as {
    data?: { site?: { siteInfoCollection?: { name: string }[] } };
    errors?: { message: string }[];
  };
  if (r.status === 401 || r.status === 403 || r.status === 404) {
    return {
      ok: false,
      detail: `Experience Edge did not accept this ${input.label} Context ID. Copy it again from the environment’s Developer settings.`,
    };
  }
  if (r.status !== 200 || !b.data) {
    return {
      ok: false,
      detail: `Experience Edge answered ${r.status}${b.errors?.[0] ? `: ${b.errors[0].message}` : ''}.`,
    };
  }
  const sites = (b.data.site?.siteInfoCollection ?? []).map((s) => s.name);
  return {
    ok: true,
    detail: sites.length
      ? `Experience Edge (${input.label}) reached. Published sites: ${sites.join(', ')}.`
      : `Experience Edge (${input.label}) reached. Nothing is published yet.`,
    sites,
  };
}
