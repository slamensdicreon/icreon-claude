import type { VerifyResult } from './sitecore';
import { timedCall as call } from './http';

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
  /**
   * The template repository an Optimizely build repository is generated from: Optimizely's own
   * Next.js starter in a folder of its own, without its samples and with a generated component
   * registry, so that branches each adding a component never edit the same file. In our build
   * organization, because Optimizely publishes its starter through a scaffolding tool, not as a
   * template repository.
   */
  starter: { owner: string; repo: string; appPath: string };
  fetch: typeof fetch;
  timeoutMs: number;
}

export const OPTIMIZELY_DEFAULTS: OptimizelyVerifyConfig = {
  apiUrl: 'https://api.cms.optimizely.com',
  graphUrl: 'https://cg.optimizely.com/content/v2',
  cmsHostSuffixes: ['.cms.optimizely.com'],
  starter: { owner: 'icreon-launchworks', repo: 'optimizely-starter-nextjs', appPath: 'head' },
  fetch: (...a) => fetch(...a),
  timeoutMs: 15_000,
};

/**
 * An application's key from the name a Director gives it: the API takes letters, digits and
 * underscores, not starting with a digit ("microsoft-demo" is refused; "microsoft_demo" is not).
 */
export function applicationKey(name: string): string {
  const key = name
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return /^[0-9]/.test(key) ? `_${key}` : key;
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

/** The root every instance has: its key is the same on all of them. */
const ROOT = '43f936c99b234ea397b261c538ad07c9';

type Json = Record<string, unknown>;
const bearer = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: 'application/json',
});

/**
 * Whether a REST API key may write content on its instance, read from what it has already
 * written: content at the top of the instance that this key created, with a version this key
 * published. Access rights can't be read and a refused write is told apart from a malformed one
 * only by sending a real one, so a key that has written nothing yet stays unknown.
 */
export async function contentRightsProven(
  cfg: OptimizelyVerifyConfig,
  token: string,
  clientId: string,
): Promise<boolean> {
  const id = clientId.trim().toLowerCase();
  const by = (v: unknown) => typeof v === 'string' && v.toLowerCase() === id;
  const top = await call(cfg, `${cfg.apiUrl}/v1/content/${ROOT}/items?pageSize=100`, {
    headers: bearer(token),
  });
  if ('error' in top || top.status !== 200) return false;
  const made = (((top.body ?? {}) as { items?: Json[] }).items ?? [])
    .filter((i) => by(i.createdBy) && typeof i.key === 'string')
    .slice(0, 5);
  for (const item of made) {
    const versions = await call(
      cfg,
      `${cfg.apiUrl}/v1/content/${String(item.key)}/versions?pageSize=20`,
      { headers: bearer(token) },
    );
    if ('error' in versions || versions.status !== 200) continue;
    const published = (((versions.body ?? {}) as { items?: Json[] }).items ?? []).some(
      (v) => v.status === 'published' && by(v.lastModifiedBy),
    );
    if (published) return true;
  }
  return false;
}

/** Every content type key on the instance (a few pages at most), or null when one can't be read. */
async function contentTypeKeys(
  cfg: OptimizelyVerifyConfig,
  token: string,
  first: Json,
): Promise<string[]> {
  const keys = (b: Json) =>
    ((b.items ?? []) as { key?: string }[]).map((i) => i.key ?? '').filter(Boolean);
  const out = keys(first);
  const total = Number(first.totalItemCount ?? out.length);
  for (let page = 1; out.length < total && page < 10; page++) {
    const r = await call(cfg, `${cfg.apiUrl}/v1/contenttypes?pageSize=100&pageIndex=${page}`, {
      headers: bearer(token),
    });
    if ('error' in r || r.status !== 200) break;
    const more = keys((r.body ?? {}) as Json);
    if (!more.length) break;
    out.push(...more);
  }
  return out;
}

/**
 * CMS REST API key: a token, then the instance's content types (read-only). With the project's
 * prefix and application it also says what on the instance already carries them, so a new build
 * picks names of its own before it starts rather than being asked about them in phase 0.
 */
export async function verifyCmsApiClient(
  cfg: OptimizelyVerifyConfig,
  input: { clientId: string; clientSecret: string; typePrefix?: string; application?: string },
): Promise<VerifyResult> {
  const t = await optimizelyToken(cfg, input.clientId, input.clientSecret);
  if (!('token' in t)) return t;
  const r = await call(cfg, `${cfg.apiUrl}/v1/contenttypes?pageSize=100`, {
    headers: bearer(t.token),
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

  // What already carries this project's names. Neither is an error (a project may continue an
  // earlier build), so the check passes and says it.
  const prefix = input.typePrefix?.trim() ?? '';
  const taken = prefix
    ? (await contentTypeKeys(cfg, t.token, b as Json)).filter((k) =>
        k.toLowerCase().startsWith(prefix.toLowerCase()),
      ).length
    : 0;
  const appKey = input.application?.trim() ? applicationKey(input.application) : '';
  const app = appKey
    ? await call(cfg, `${cfg.apiUrl}/v1/applications/${encodeURIComponent(appKey)}`, {
        headers: bearer(t.token),
      })
    : null;
  const appExists = !!app && !('error' in app) && app.status === 200;
  const inUse = [
    taken
      ? `${taken} content ${taken === 1 ? 'type' : 'types'} already ${taken === 1 ? 'starts' : 'start'} with ${prefix}`
      : '',
    appExists ? `the application ${appKey} already exists` : '',
  ].filter(Boolean);
  const rights = await contentRightsProven(cfg, t.token, input.clientId);
  return {
    ok: true,
    detail: [
      `CMS REST API v1 reached. ${total} content types on the instance, ${own} of them created by its teams.`,
      rights
        ? 'This key has created and published content here before, so it has content rights.'
        : '',
      inUse.length
        ? `On this instance ${inUse.join(' and ')}: for a new build, choose ${[taken ? 'a prefix' : '', appExists ? 'an application name' : ''].filter(Boolean).join(' and ')} nobody uses, or it shares them with the build that made them.`
        : '',
    ]
      .filter(Boolean)
      .join(' '),
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
