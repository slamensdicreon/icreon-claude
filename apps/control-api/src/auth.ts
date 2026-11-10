import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** A person as WorkOS signs them in (AuthKit). */
export interface WorkosUser {
  id: string;
  email: string;
  email_verified: boolean;
  first_name: string | null;
  last_name: string | null;
  profile_picture_url: string | null;
}

/** Sign-in with WorkOS AuthKit: email, Google and Microsoft, and each organization's own SSO. */
export interface WorkosAuthOptions {
  clientId: string;
  /** The WorkOS API key (its client secret). */
  apiKey: string;
  /**
   * Whether a person WorkOS signed in may use Launchworks: their invitations are accepted here,
   * and someone who belongs to no organization is turned away with the message given.
   */
  admit(user: WorkosUser): Promise<{ ok: true } | { ok: false; message: string }>;
  /** Defaults to https://api.workos.com. */
  baseUrl?: string;
}

export interface GithubAuthOptions {
  /** GitHub sign-in; without both, only WorkOS signs people in. */
  clientId?: string;
  clientSecret?: string;
  /** WorkOS sign-in, beside GitHub's or alone. */
  workos?: WorkosAuthOptions;
  /** This API's public base URL; GitHub redirects to `${publicUrl}/auth/callback`. */
  publicUrl: string;
  /** Where the Control Center lives; sign-in returns there. */
  appUrl: string;
  /**
   * GitHub logins allowed in. Checked on every request, so removal is immediate on redeploy.
   * People who sign in through WorkOS are let in by their memberships instead.
   */
  operators: string[];
  /**
   * API keys for scripts and agents acting as an operator (`Authorization: Bearer lwk_…`): the
   * SHA-256 of each key, hex, with the name its actions are recorded under. Only hashes are kept.
   */
  apiKeys?: { login: string; sha256: string }[];
  /**
   * Vercel Cron's secret (CRON_SECRET): its scheduled calls carry `Authorization: Bearer <it>`, and
   * may reach the paths in CRON_PATHS only.
   */
  cronSecret?: string | null;
  /** If set, the account must also be an active member of this org (where 2FA is enforced). */
  requiredOrg?: string;
  /** At least 32 characters; signs session cookies. */
  sessionSecret: string;
  sessionTtlMs?: number;
  /** Secure cookies (HTTPS). Off only for local development. */
  secureCookies: boolean;
  fetch?: typeof fetch;
}

export interface Operator {
  /** A GitHub login, or the email of someone who signed in through WorkOS. */
  login: string;
  name: string | null;
  avatarUrl: string | null;
  /** Who they are in memberships, when it isn't their GitHub login (`workos:<user id>`). */
  subject?: string;
}

interface Session {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  exp: number;
  /** Absent on GitHub sessions (and every session from before WorkOS). */
  provider?: 'workos';
  subject?: string;
  /** The WorkOS session (the access token's `sid`), ended with ours at sign-out. */
  sid?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    operator?: Operator;
  }
}

const SESSION = 'lw_session';
const STATE = 'lw_oauth_state';
const TWELVE_HOURS = 12 * 60 * 60 * 1000;
// The app's post-install page is open: it lands client repository owners, who aren't operators.
const OPEN_PATHS = ['/health', '/auth/', '/integrations/github/installed'];
/** The path alone, without its query: routes are matched exactly, not by prefix. */
const pathOf = (url: string) => url.split('?')[0]!;
// What a scheduled call (Vercel Cron) may reach with the cron secret.
const CRON_PATHS = ['/portfolio/watchdog', '/portfolio/purge-due'];

/**
 * Sign-in: GitHub for Icreon's operators, and WorkOS for everyone else (and for them too). Only
 * identity is kept: each provider's token is used once at sign-in and discarded. Sessions are
 * HMAC-signed cookies; every request re-checks a GitHub session against the operator list, and
 * organizations check everyone's memberships.
 */
export function registerGithubAuth(app: FastifyInstance, opts: GithubAuthOptions): void {
  if (opts.sessionSecret.length < 32)
    throw new Error('SESSION_SECRET must be at least 32 characters');
  const doFetch = opts.fetch ?? fetch;
  const ttl = opts.sessionTtlMs ?? TWELVE_HOURS;
  const allowed = new Set(opts.operators.map((l) => l.toLowerCase()));
  const sign = (payload: object) => signValue(JSON.stringify(payload), opts.sessionSecret);
  const read = <T>(value: string | undefined): T | null => {
    const raw = value ? verifyValue(value, opts.sessionSecret) : null;
    try {
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  };
  const cookie = (name: string, value: string, maxAgeMs: number) =>
    [
      `${name}=${value}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
      ...(opts.secureCookies ? ['Secure'] : []),
    ].join('; ');
  const deny = (reply: FastifyReply, status: number, code: string, message: string) =>
    reply.status(status).send({ error: { code, message } });

  const keys = (opts.apiKeys ?? []).map((k) => ({
    login: k.login,
    hash: Buffer.from(k.sha256.toLowerCase(), 'hex'),
  }));
  const byKey = (header: string | undefined) => {
    const key = /^Bearer (lwk_[A-Za-z0-9_-]{32,})$/.exec(header ?? '')?.[1];
    if (!key) return null;
    const hash = createHash('sha256').update(key).digest();
    return keys.find((k) => k.hash.length === hash.length && timingSafeEqual(k.hash, hash)) ?? null;
  };

  const cron = opts.cronSecret
    ? createHash('sha256').update(`Bearer ${opts.cronSecret}`).digest()
    : null;
  const isCron = (header: string | undefined) =>
    !!cron && !!header && timingSafeEqual(createHash('sha256').update(header).digest(), cron);

  const github =
    opts.clientId && opts.clientSecret ? { id: opts.clientId, secret: opts.clientSecret } : null;
  const workos = opts.workos ?? null;
  if (!github && !workos) throw new Error('Sign-in needs GitHub or WorkOS configured.');
  /** A live session: unexpired, and for GitHub still on the operator list. */
  const sessionOf = (req: FastifyRequest): Session | null => {
    const session = read<Session>(cookies(req)[SESSION]);
    if (!session || session.exp < Date.now()) return null;
    if (session.provider === 'workos') return workos && session.subject ? session : null;
    return github && allowed.has(session.login.toLowerCase()) ? session : null;
  };

  app.addHook('onRequest', async (req, reply) => {
    if (
      req.method === 'OPTIONS' ||
      OPEN_PATHS.some((p) =>
        p.endsWith('/') ? pathOf(req.url).startsWith(p) : pathOf(req.url) === p,
      )
    )
      return;
    if (isCron(req.headers.authorization) && CRON_PATHS.includes(pathOf(req.url))) {
      req.operator = { login: 'vercel-cron', name: 'Scheduled check', avatarUrl: null };
      return;
    }
    const key = byKey(req.headers.authorization);
    if (key) {
      req.operator = { login: key.login, name: `${key.login} (API key)`, avatarUrl: null };
      return;
    }
    const session = sessionOf(req);
    if (!session) return deny(reply, 401, 'unauthenticated', 'Sign in to use the Control Center.');
    req.operator = {
      login: session.login,
      name: session.name,
      avatarUrl: session.avatarUrl,
      ...(session.subject ? { subject: session.subject } : {}),
    };
  });

  app.get<{
    Querystring: { returnTo?: string; provider?: string; invitation_token?: string };
  }>('/auth/login', async (req, reply) => {
    const state = randomBytes(16).toString('base64url');
    const returnTo = safeReturn(req.query.returnTo, opts.appUrl);
    const invitation = req.query.invitation_token?.slice(0, 200) || null;
    // An invitation link from WorkOS's email lands here: it goes straight to WorkOS.
    const provider =
      req.query.provider === 'github' && github
        ? 'github'
        : (req.query.provider === 'workos' || invitation) && workos
          ? 'workos'
          : !workos
            ? 'github'
            : !github
              ? 'workos'
              : null;
    if (!provider) return page(reply, 200, chooser(returnTo));
    reply.header(
      'set-cookie',
      cookie(STATE, sign({ state, returnTo, invitation }), 10 * 60 * 1000),
    );
    if (provider === 'workos') {
      const url = new URL(`${workos!.baseUrl ?? WORKOS_API}/user_management/authorize`);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', workos!.clientId);
      url.searchParams.set('redirect_uri', `${opts.publicUrl}/auth/workos/callback`);
      url.searchParams.set('provider', 'authkit');
      url.searchParams.set('state', state);
      if (invitation) url.searchParams.set('invitation_token', invitation);
      return reply.redirect(url.toString());
    }
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', github!.id);
    url.searchParams.set('redirect_uri', `${opts.publicUrl}/auth/callback`);
    url.searchParams.set('scope', opts.requiredOrg ? 'read:user read:org' : 'read:user');
    url.searchParams.set('state', state);
    url.searchParams.set('allow_signup', 'false');
    return reply.redirect(url.toString());
  });

  app.get<{ Querystring: { code?: string; state?: string } }>(
    '/auth/workos/callback',
    async (req, reply) => {
      const pending = read<{ state: string; returnTo: string; invitation: string | null }>(
        cookies(req)[STATE],
      );
      reply.header('set-cookie', cookie(STATE, '', 0));
      if (!workos) return deny(reply, 404, 'not_found', 'WorkOS sign-in is not set up here.');
      if (!pending || !req.query.state || pending.state !== req.query.state || !req.query.code)
        return page(reply, 400, 'Sign-in expired or was tampered with. Start again.');
      const res = await doFetch(`${workos.baseUrl ?? WORKOS_API}/user_management/authenticate`, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: workos.clientId,
          client_secret: workos.apiKey,
          code: req.query.code,
          ...(pending.invitation ? { invitation_token: pending.invitation } : {}),
          user_agent: req.headers['user-agent'],
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        user?: WorkosUser;
        access_token?: string;
      } | null;
      const user = body?.user;
      if (!res.ok || !user?.id || !user.email)
        return page(reply, 502, 'WorkOS did not complete sign-in. Try again.');
      if (!user.email_verified)
        return page(reply, 403, `Verify ${user.email} first: WorkOS sent you a link.`);
      const admitted = await workos.admit(user);
      if (!admitted.ok) return page(reply, 403, admitted.message);
      const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || null;
      const session: Session = {
        login: user.email.toLowerCase(),
        name,
        avatarUrl: user.profile_picture_url ?? null,
        provider: 'workos',
        subject: `workos:${user.id}`,
        ...(sessionIdOf(body?.access_token) ? { sid: sessionIdOf(body?.access_token)! } : {}),
        exp: Date.now() + ttl,
      };
      reply.header('set-cookie', [cookie(STATE, '', 0), cookie(SESSION, sign(session), ttl)]);
      return reply.redirect(pending.returnTo);
    },
  );

  app.get<{ Querystring: { code?: string; state?: string } }>(
    '/auth/callback',
    async (req, reply) => {
      const pending = read<{ state: string; returnTo: string }>(cookies(req)[STATE]);
      reply.header('set-cookie', cookie(STATE, '', 0));
      if (!github) return deny(reply, 404, 'not_found', 'GitHub sign-in is not set up here.');
      if (!pending || !req.query.state || pending.state !== req.query.state || !req.query.code) {
        return deny(reply, 400, 'bad_state', 'Sign-in expired or was tampered with. Start again.');
      }

      const tokenRes = await doFetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: github.id,
          client_secret: github.secret,
          code: req.query.code,
          redirect_uri: `${opts.publicUrl}/auth/callback`,
        }),
      });
      const token = ((await tokenRes.json()) as { access_token?: string }).access_token;
      if (!tokenRes.ok || !token)
        return deny(reply, 502, 'github_error', 'GitHub did not complete sign-in. Try again.');
      const gh = (path: string) =>
        doFetch(`https://api.github.com${path}`, {
          headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
        });

      const userRes = await gh('/user');
      if (!userRes.ok)
        return deny(reply, 502, 'github_error', 'GitHub did not return your profile. Try again.');
      const user = (await userRes.json()) as {
        login: string;
        name?: string | null;
        avatar_url?: string | null;
      };
      if (!allowed.has(user.login.toLowerCase())) {
        return deny(
          reply,
          403,
          'not_an_operator',
          `${user.login} is not on the Launchworks operator list.`,
        );
      }
      if (opts.requiredOrg) {
        const m = await gh(`/user/memberships/orgs/${encodeURIComponent(opts.requiredOrg)}`);
        const membership = m.ok ? ((await m.json()) as { state?: string }) : null;
        if (membership?.state !== 'active') {
          return deny(
            reply,
            403,
            'not_in_org',
            `${user.login} is not an active member of ${opts.requiredOrg}.`,
          );
        }
      }

      const session = {
        login: user.login,
        name: user.name ?? null,
        avatarUrl: user.avatar_url ?? null,
        exp: Date.now() + ttl,
      };
      reply.header('set-cookie', [cookie(STATE, '', 0), cookie(SESSION, sign(session), ttl)]);
      return reply.redirect(pending.returnTo);
    },
  );

  app.get('/auth/me', async (req, reply) => {
    const session = sessionOf(req);
    if (!session) return deny(reply, 401, 'unauthenticated', 'Not signed in.');
    const { login, name, avatarUrl } = session;
    return { login, name, avatarUrl };
  });

  // Signing out of a WorkOS session ends it at WorkOS too, or AuthKit would sign the person
  // straight back in: the app follows `redirect`, and WorkOS returns them to the Control Center.
  app.post('/auth/logout', async (req, reply) => {
    const session = read<Session>(cookies(req)[SESSION]);
    reply.header('set-cookie', cookie(SESSION, '', 0));
    if (session?.provider === 'workos' && session.sid && workos) {
      const url = new URL(`${workos.baseUrl ?? WORKOS_API}/user_management/sessions/logout`);
      url.searchParams.set('session_id', session.sid);
      url.searchParams.set('return_to', opts.appUrl);
      return { redirect: url.toString() };
    }
    return reply.status(204).send();
  });
}

/**
 * CSRF guard for cookie sessions: a state-changing request carrying an Origin header must come
 * from the Control Center's origin (or this API's own).
 */
export function registerOriginCheck(app: FastifyInstance, allowedOrigins: string[]): void {
  const allowed = new Set(allowedOrigins.map((o) => new URL(o).origin));
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    const origin = req.headers.origin;
    if (origin && !allowed.has(origin)) {
      return reply.status(403).send({
        error: { code: 'bad_origin', message: `Requests from ${origin} are not accepted.` },
      });
    }
  });
}

export function signValue(value: string, secret: string): string {
  const body = Buffer.from(value).toString('base64url');
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyValue(signed: string, secret: string): string | null {
  const i = signed.lastIndexOf('.');
  if (i < 1) return null;
  const body = signed.slice(0, i);
  const mac = Buffer.from(signed.slice(i + 1));
  const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('base64url'));
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;
  return Buffer.from(body, 'base64url').toString();
}

function cookies(req: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** Only return to the Control Center itself, never to an arbitrary URL. */
function safeReturn(returnTo: string | undefined, appUrl: string): string {
  if (!returnTo) return appUrl;
  try {
    const target = new URL(returnTo, appUrl);
    return target.origin === new URL(appUrl).origin ? target.toString() : appUrl;
  } catch {
    return appUrl;
  }
}

const WORKOS_API = 'https://api.workos.com';

const escapeHtml = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const PAGE_STYLE = `body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;
min-height:100vh;background:#f6f5f2;color:#1d1c1a}main{max-width:26rem;padding:2rem}h1{font-size:1.25rem}
a.b{display:block;margin:.75rem 0;padding:.75rem 1rem;border-radius:999px;background:#1d1c1a;color:#fff;
text-align:center;text-decoration:none}a.b.s{background:transparent;color:inherit;border:1px solid #c9c7c1}
@media (prefers-color-scheme:dark){body{background:#161614;color:#ecebe7}a.b{background:#ecebe7;color:#161614}
a.b.s{background:transparent;color:inherit;border-color:#4a4945}}`;

/** A small page of the API's own: the sign-in choice, or why sign-in stopped. */
function page(reply: FastifyReply, status: number, body: string) {
  const inner = body.startsWith('<') ? body : `<h1>Sign-in stopped</h1><p>${escapeHtml(body)}</p>`;
  return reply
    .status(status)
    .type('text/html; charset=utf-8')
    .header('cache-control', 'no-store')
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · Launchworks</title><style>${PAGE_STYLE}</style></head><body><main>${inner}</main></body></html>`,
    );
}

/** Both ways in: WorkOS for everyone, GitHub for Icreon's operators. */
function chooser(returnTo: string) {
  const q = (provider: string) =>
    `/auth/login?provider=${provider}&returnTo=${encodeURIComponent(returnTo)}`;
  return `<h1>Sign in to Launchworks</h1>
<a class="b" href="${escapeHtml(q('workos'))}">Continue with email, Google or Microsoft</a>
<a class="b s" href="${escapeHtml(q('github'))}">Icreon operators: continue with GitHub</a>`;
}

/** The `sid` claim of a WorkOS access token (a JWT that came straight from WorkOS over TLS). */
function sessionIdOf(token: string | undefined): string | null {
  const payload = token?.split('.')[1];
  if (!payload) return null;
  try {
    const sid = (JSON.parse(Buffer.from(payload, 'base64url').toString()) as { sid?: unknown }).sid;
    return typeof sid === 'string' && sid.length < 200 ? sid : null;
  } catch {
    return null;
  }
}
