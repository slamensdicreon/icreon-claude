import { InMemoryEventStore, Projections } from '@lw/events';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { signValue, type GithubAuthOptions } from '../src/auth';

const SECRET = 'x'.repeat(40);
const APP = 'https://launchworks.icreon.internal';
const API = 'https://api.launchworks.icreon.internal';

/** A fake GitHub: token exchange, /user, and org membership. */
function fakeGithub(user: string, org: 'active' | 'pending' | 'none' = 'active') {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url === 'https://github.com/login/oauth/access_token') {
      const body = JSON.parse(String(init?.body));
      return body.code === 'good-code'
        ? json({ access_token: 'gho_secret' })
        : json({ error: 'bad_verification_code' });
    }
    if (url === 'https://api.github.com/user')
      return json({ login: user, name: 'Steve', avatar_url: 'https://a/x.png' });
    if (url.startsWith('https://api.github.com/user/memberships/orgs/')) {
      return org === 'none' ? json({ message: 'Not Found' }, 404) : json({ state: org });
    }
    return json({}, 404);
  }) as typeof fetch;
  return { fetch: f, calls };
}

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function start(gh: ReturnType<typeof fakeGithub>, extra: Partial<GithubAuthOptions> = {}) {
  const store = new InMemoryEventStore();
  const projections = new Projections(store);
  await projections.start();
  app = await buildApp({
    store,
    projections,
    commands: () => undefined,
    auth: {
      clientId: 'client-1',
      clientSecret: 'shh',
      publicUrl: API,
      appUrl: APP,
      operators: ['slamensdicreon', 'second-operator'],
      sessionSecret: SECRET,
      secureCookies: true,
      fetch: gh.fetch,
      ...extra,
    },
  });
  return app;
}

const cookieValue = (setCookie: string | string[] | undefined, name: string) => {
  const all = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const c = all.find((x) => x.startsWith(`${name}=`) && !x.startsWith(`${name}=;`));
  return c?.split(';')[0]!.slice(name.length + 1);
};

async function signIn(a: FastifyInstance, code = 'good-code') {
  const login = await a.inject({ url: '/auth/login?returnTo=/projects/p1' });
  const state = new URL(login.headers.location!).searchParams.get('state')!;
  const stateCookie = cookieValue(login.headers['set-cookie'], 'lw_oauth_state')!;
  return a.inject({
    url: `/auth/callback?code=${code}&state=${state}`,
    headers: { cookie: `lw_oauth_state=${stateCookie}` },
  });
}

describe('GitHub sign-in', () => {
  it('sends the operator to GitHub with a state bound to a signed cookie', async () => {
    const a = await start(fakeGithub('slamensdicreon'));
    const r = await a.inject({ url: '/auth/login' });
    expect(r.statusCode).toBe(302);
    const to = new URL(r.headers.location!);
    expect(to.origin + to.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(to.searchParams.get('client_id')).toBe('client-1');
    expect(to.searchParams.get('redirect_uri')).toBe(`${API}/auth/callback`);
    expect(to.searchParams.get('scope')).toBe('read:user');
    expect(String(r.headers['set-cookie'])).toMatch(
      /lw_oauth_state=.+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600; Secure/,
    );
  });

  it('signs in an operator, returns them to the Control Center, and lets their requests through', async () => {
    const gh = fakeGithub('SlamensdIcreon'); // GitHub logins are case-insensitive
    const a = await start(gh);
    const cb = await signIn(a);
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe(`${APP}/projects/p1`);
    const session = cookieValue(cb.headers['set-cookie'], 'lw_session')!;
    expect(session).toBeTruthy();
    expect(JSON.stringify(cb.headers)).not.toContain('gho_secret');

    const me = await a.inject({ url: '/auth/me', headers: { cookie: `lw_session=${session}` } });
    expect(me.json()).toEqual({
      login: 'SlamensdIcreon',
      name: 'Steve',
      avatarUrl: 'https://a/x.png',
    });
    expect(
      (await a.inject({ url: '/projects', headers: { cookie: `lw_session=${session}` } }))
        .statusCode,
    ).toBe(200);
  });

  it('refuses everyone else, and every request without a valid session', async () => {
    const a = await start(fakeGithub('someone-else'));
    const cb = await signIn(a);
    expect(cb.statusCode).toBe(403);
    expect(cb.json().error).toEqual({
      code: 'not_an_operator',
      message: 'someone-else is not on the Launchworks operator list.',
    });
    expect(cookieValue(cb.headers['set-cookie'], 'lw_session')).toBeUndefined();

    expect((await a.inject({ url: '/projects' })).statusCode).toBe(401);
    expect((await a.inject({ url: '/projects/p1/stream' })).statusCode).toBe(401);
    expect((await a.inject({ url: '/health' })).statusCode).toBe(200);

    const forged = signValue(
      JSON.stringify({ login: 'slamensdicreon', exp: Date.now() + 1e6 }),
      'y'.repeat(40),
    );
    expect(
      (await a.inject({ url: '/projects', headers: { cookie: `lw_session=${forged}` } }))
        .statusCode,
    ).toBe(401);
    const expired = signValue(
      JSON.stringify({ login: 'slamensdicreon', exp: Date.now() - 1 }),
      SECRET,
    );
    expect(
      (await a.inject({ url: '/projects', headers: { cookie: `lw_session=${expired}` } }))
        .statusCode,
    ).toBe(401);
    const removed = signValue(
      JSON.stringify({ login: 'former-operator', exp: Date.now() + 1e6 }),
      SECRET,
    );
    expect(
      (await a.inject({ url: '/projects', headers: { cookie: `lw_session=${removed}` } }))
        .statusCode,
    ).toBe(401);
  });

  it('rejects a callback whose state does not match, and a failed code exchange', async () => {
    const a = await start(fakeGithub('slamensdicreon'));
    expect(
      (await a.inject({ url: '/auth/callback?code=good-code&state=guessed' })).json().error.code,
    ).toBe('bad_state');
    expect((await signIn(a, 'stolen-code')).statusCode).toBe(502);
  });

  it('requires active org membership when an org is set', async () => {
    const pending = await start(fakeGithub('slamensdicreon', 'pending'), { requiredOrg: 'icreon' });
    const r = await signIn(pending);
    expect(r.statusCode).toBe(403);
    expect(r.json().error.message).toBe('slamensdicreon is not an active member of icreon.');
    await app!.close();
    app = null;
    const active = await start(fakeGithub('slamensdicreon', 'active'), { requiredOrg: 'icreon' });
    expect((await signIn(active)).statusCode).toBe(302);
  });

  it('never returns to a foreign site after sign-in', async () => {
    const a = await start(fakeGithub('slamensdicreon'));
    const login = await a.inject({ url: '/auth/login?returnTo=https://evil.example/steal' });
    const state = new URL(login.headers.location!).searchParams.get('state')!;
    const cb = await a.inject({
      url: `/auth/callback?code=good-code&state=${state}`,
      headers: {
        cookie: `lw_oauth_state=${cookieValue(login.headers['set-cookie'], 'lw_oauth_state')}`,
      },
    });
    expect(cb.headers.location).toBe(APP);
  });

  it('blocks state-changing requests from other origins, and signs out', async () => {
    const a = await start(fakeGithub('slamensdicreon'));
    const session = cookieValue((await signIn(a)).headers['set-cookie'], 'lw_session')!;
    const post = (origin: string) =>
      a.inject({
        method: 'POST',
        url: '/projects',
        headers: { cookie: `lw_session=${session}`, origin },
        payload: { name: 'x', client: 'y' },
      });
    expect((await post('https://evil.example')).statusCode).toBe(403);
    expect((await post(APP)).statusCode).toBe(501); // passes the guard; intake isn't wired in this test
    const out = await a.inject({ method: 'POST', url: '/auth/logout', headers: { origin: APP } });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toContain(
      'lw_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    );
  });
});
