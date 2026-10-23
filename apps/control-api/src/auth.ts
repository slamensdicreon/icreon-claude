import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface GithubAuthOptions {
  clientId: string;
  clientSecret: string;
  /** This API's public base URL; GitHub redirects to `${publicUrl}/auth/callback`. */
  publicUrl: string;
  /** Where the Control Center lives; sign-in returns there. */
  appUrl: string;
  /** GitHub logins allowed in. Checked on every request, so removal is immediate on redeploy. */
  operators: string[];
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
  login: string;
  name: string | null;
  avatarUrl: string | null;
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

/**
 * Sign-in with GitHub for the one or two operators who run Launchworks. Only identity is kept:
 * the GitHub token is used once at sign-in and discarded. Sessions are HMAC-signed cookies;
 * every request re-checks the operator list.
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

  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'OPTIONS' || OPEN_PATHS.some((p) => req.url === p || req.url.startsWith(p)))
      return;
    const session = read<{
      login: string;
      name: string | null;
      avatarUrl: string | null;
      exp: number;
    }>(cookies(req)[SESSION]);
    if (!session || session.exp < Date.now() || !allowed.has(session.login.toLowerCase())) {
      return deny(reply, 401, 'unauthenticated', 'Sign in with GitHub to use the Control Center.');
    }
    req.operator = { login: session.login, name: session.name, avatarUrl: session.avatarUrl };
  });

  app.get<{ Querystring: { returnTo?: string } }>('/auth/login', async (req, reply) => {
    const state = randomBytes(16).toString('base64url');
    const returnTo = safeReturn(req.query.returnTo, opts.appUrl);
    reply.header('set-cookie', cookie(STATE, sign({ state, returnTo }), 10 * 60 * 1000));
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', opts.clientId);
    url.searchParams.set('redirect_uri', `${opts.publicUrl}/auth/callback`);
    url.searchParams.set('scope', opts.requiredOrg ? 'read:user read:org' : 'read:user');
    url.searchParams.set('state', state);
    url.searchParams.set('allow_signup', 'false');
    return reply.redirect(url.toString());
  });

  app.get<{ Querystring: { code?: string; state?: string } }>(
    '/auth/callback',
    async (req, reply) => {
      const pending = read<{ state: string; returnTo: string }>(cookies(req)[STATE]);
      reply.header('set-cookie', cookie(STATE, '', 0));
      if (!pending || !req.query.state || pending.state !== req.query.state || !req.query.code) {
        return deny(reply, 400, 'bad_state', 'Sign-in expired or was tampered with. Start again.');
      }

      const tokenRes = await doFetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: opts.clientId,
          client_secret: opts.clientSecret,
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
    const session = read<Operator & { exp: number }>(cookies(req)[SESSION]);
    if (!session || session.exp < Date.now() || !allowed.has(session.login.toLowerCase())) {
      return deny(reply, 401, 'unauthenticated', 'Not signed in.');
    }
    const { login, name, avatarUrl } = session;
    return { login, name, avatarUrl };
  });

  app.post('/auth/logout', async (_req, reply) => {
    reply.header('set-cookie', cookie(SESSION, '', 0));
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
