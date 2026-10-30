import type { VerifyResult } from './sitecore';

/**
 * Optimizely CMS (SaaS): one instance (`https://app-<id>.cms.optimizely.com`) reached through the
 * CMS REST API v1 on Optimizely's shared gateway, with Optimizely Graph for delivery. An API key
 * is created inside an instance (Settings → API Keys), so the token it mints already names the
 * instance: calls go to the gateway, not to the instance's host.
 */
export interface OptimizelyVerifyConfig {
  /** The CMS REST API gateway; `/oauth/token` and `/v1/...` live under it. */
  apiUrl: string;
  /** Optimizely Graph's query endpoint. */
  graphUrl: string;
  /** Host suffixes an instance URL may have: the server calls it, so not any host. */
  cmsHostSuffixes: string[];
  fetch: typeof fetch;
  timeoutMs: number;
}

export const OPTIMIZELY_DEFAULTS: OptimizelyVerifyConfig = {
  apiUrl: 'https://api.cms.optimizely.com',
  graphUrl: 'https://cg.optimizely.com/content/v2',
  cmsHostSuffixes: ['.cms.optimizely.com'],
  fetch: (...a) => fetch(...a),
  timeoutMs: 15_000,
};

async function call(
  cfg: OptimizelyVerifyConfig,
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

/** The instance URL as an origin this server may call, or the reason it can't. */
export function optimizelyCmsUrl(cfg: OptimizelyVerifyConfig, value: string): URL | string {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//.test(value.trim()) ? value.trim() : `https://${value.trim()}`);
  } catch {
    return 'That is not a URL. Paste the instance URL from your browser’s address bar.';
  }
  if (url.protocol !== 'https:') return 'The CMS URL must use https.';
  if (!cfg.cmsHostSuffixes.some((s) => url.hostname.endsWith(s))) {
    return `The CMS URL must be an Optimizely CMS (SaaS) instance (ending in ${cfg.cmsHostSuffixes.join(' or ')}).`;
  }
  return new URL(url.origin);
}

/** A client-credentials token for a CMS REST API key. */
export async function optimizelyToken(
  cfg: OptimizelyVerifyConfig,
  clientId: string,
  clientSecret: string,
): Promise<{ ok: true; token: string; expiresAt: string | null } | VerifyResult> {
  const r = await call(cfg, `${cfg.apiUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId.trim(),
      client_secret: clientSecret.trim(),
    }),
  });
  if ('error' in r) return { ok: false, detail: r.error };
  const b = (r.body ?? {}) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
    error?: string;
  };
  if (r.status === 200 && b.access_token) {
    return {
      ok: true,
      token: b.access_token,
      expiresAt: b.expires_in ? new Date(Date.now() + b.expires_in * 1000).toISOString() : null,
    };
  }
  if (r.status === 400 || r.status === 401 || r.status === 403) {
    return {
      ok: false,
      detail:
        'Optimizely rejected this client ID and secret. Check both were copied from the same API key (Settings → API Keys), and that it has not been deleted.',
    };
  }
  return {
    ok: false,
    detail: `Optimizely’s token endpoint answered ${r.status}${(b.error_description ?? b.error) ? `: ${b.error_description ?? b.error}` : ''}.`,
  };
}

/** CMS REST API key: a token, then the instance's content types (read-only). */
export async function verifyCmsApiClient(
  cfg: OptimizelyVerifyConfig,
  input: { clientId: string; clientSecret: string },
): Promise<VerifyResult> {
  const t = await optimizelyToken(cfg, input.clientId, input.clientSecret);
  if (!('token' in t)) return t;
  const r = await call(cfg, `${cfg.apiUrl}/v1/contenttypes?pageSize=100`, {
    headers: { authorization: `Bearer ${t.token}`, accept: 'application/json' },
  });
  if ('error' in r) return { ok: false, detail: r.error };
  if (r.status === 401 || r.status === 403) {
    return {
      ok: false,
      detail:
        'The token was issued but the CMS REST API refused it: the API key may lack the content-type scope. Create it without restricted scopes.',
    };
  }
  if (r.status !== 200) return { ok: false, detail: `The CMS REST API answered ${r.status}.` };
  const b = (r.body ?? {}) as {
    items?: { key?: string; source?: string }[];
    totalItemCount?: number;
  };
  const items = b.items ?? [];
  const own = items.filter((i) => i.source !== '_system').length;
  const total = b.totalItemCount ?? items.length;
  return {
    ok: true,
    detail: `CMS REST API v1 reached. ${total} content types on the instance, ${own} of them created by its teams.`,
    expiresAt: t.expiresAt,
  };
}

/** Optimizely Graph single key: a one-item query against the published index. */
export async function verifyGraphSingleKey(
  cfg: OptimizelyVerifyConfig,
  input: { singleKey: string },
): Promise<VerifyResult> {
  const r = await call(cfg, cfg.graphUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `epi-single ${input.singleKey.trim()}`,
    },
    body: JSON.stringify({ query: '{ _Content(limit: 1) { total } }' }),
  });
  if ('error' in r) return { ok: false, detail: r.error };
  const b = (r.body ?? {}) as {
    data?: { _Content?: { total?: number } };
    errors?: { message: string }[];
  };
  if (r.status === 401 || r.status === 403) {
    return {
      ok: false,
      detail:
        'Optimizely Graph did not accept this single key. Copy it again from Settings → API Keys (Render Content).',
    };
  }
  if (r.status !== 200 || !b.data) {
    return {
      ok: false,
      detail: `Optimizely Graph answered ${r.status}${b.errors?.[0] ? `: ${b.errors[0].message}` : ''}.`,
    };
  }
  const total = b.data._Content?.total ?? 0;
  return {
    ok: true,
    detail: total
      ? `Optimizely Graph reached. ${total} published items indexed.`
      : 'Optimizely Graph reached. Nothing is published yet.',
  };
}

/**
 * Graph app key and secret (HMAC): checked for shape only. Signed requests are made by the head
 * and by draft-reading checks, which report the first failure with Graph's own message.
 */
export function verifyGraphHmac(input: { appKey: string; secret: string }): VerifyResult {
  const appKey = input.appKey.trim();
  const secret = input.secret.trim();
  if (!appKey || !secret)
    return { ok: false, detail: 'Both the app key and the secret are needed.' };
  if (secret.length < 16) {
    return { ok: false, detail: 'That doesn’t look like a Graph secret: copy the whole value.' };
  }
  return {
    ok: true,
    detail:
      'Stored. The head signs its draft-content requests with them; the first signed request reports any problem.',
  };
}
