import { createHash } from 'node:crypto';
import {
  DEFAULT_ORGANIZATION,
  githubSubject,
  InMemoryEventStore,
  MemoryOrganizationStore,
  Projections,
  workosSubject,
} from '@lw/events';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import type { GithubAuthOptions, WorkosUser } from '../src/auth';
import { workosInvitations } from '../src/people';

const APP = 'https://app.example.com';
const API = 'https://api.example.com';
const KEY = 'sk_test_fake';

/** A fake WorkOS: the code exchange (one code per user) and the invitations endpoint. */
function fakeWorkos(users: Record<string, Partial<WorkosUser>>) {
  const invited: { email: string; auth: string | null }[] = [];
  const exchanged: Record<string, unknown>[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const json = (status: number, b: unknown) =>
      new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (url === 'https://api.workos.com/user_management/authenticate') {
      exchanged.push(body);
      const u = users[body.code];
      if (body.client_secret !== KEY || !u) return json(400, { error: 'invalid_grant' });
      return json(200, {
        user: {
          id: `user_${body.code}`,
          first_name: null,
          last_name: null,
          profile_picture_url: null,
          email_verified: true,
          ...u,
        },
        // A JWT whose payload carries the WorkOS session id.
        access_token: `e30.${Buffer.from(JSON.stringify({ sid: `session_${body.code}` })).toString('base64url')}.sig`,
      });
    }
    if (url === 'https://api.workos.com/user_management/invitations') {
      invited.push({
        email: body.email,
        auth: (init?.headers as Record<string, string>)?.authorization ?? null,
      });
      return json(201, { object: 'invitation', email: body.email });
    }
    return json(404, {});
  }) as typeof fetch;
  return { fetch: f, invited, exchanged };
}

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

const keyOf = (who: string) => `lwk_${createHash('sha256').update(who).digest('hex').slice(0, 40)}`;

async function start(
  opts: { github?: boolean; users?: Record<string, Partial<WorkosUser>>; console?: string } = {},
) {
  const store = new InMemoryEventStore();
  const projections = new Projections(store);
  await projections.start();
  const orgs = new MemoryOrganizationStore();
  const acme = await orgs.create({ name: 'Acme Corp', slug: 'acme' });
  await orgs.setMember(DEFAULT_ORGANIZATION, githubSubject('steve'), 'director', 'test', 'steve');
  await orgs.setMember(acme.id, githubSubject('steve'), 'director', 'test', 'steve');
  await orgs.setMember(acme.id, githubSubject('bob'), 'director', 'test', 'bob');
  await orgs.setMember(acme.id, githubSubject('dana'), 'watcher', 'test', 'dana');
  const wos = fakeWorkos(opts.users ?? {});
  const auth: GithubAuthOptions = {
    ...(opts.github ? { clientId: 'gh-client', clientSecret: 'gh-secret' } : {}),
    workos: {
      clientId: 'client_123',
      apiKey: KEY,
      admit: async (user) => {
        const subject = workosSubject(user.id);
        await orgs.acceptInvitations(user.email, subject);
        return (await orgs.membershipsOf(subject)).length
          ? { ok: true }
          : { ok: false, message: `${user.email} hasn't been invited to Launchworks yet.` };
      },
    },
    publicUrl: API,
    appUrl: APP,
    operators: ['steve'],
    apiKeys: ['steve', 'bob', 'dana'].map((login) => ({
      login,
      sha256: createHash('sha256').update(keyOf(login)).digest('hex'),
    })),
    sessionSecret: 'x'.repeat(40),
    secureCookies: true,
    fetch: wos.fetch,
    ...(opts.console ? { adminConsoleKey: opts.console } : {}),
  };
  app = await buildApp({
    store,
    projections,
    commands: () => undefined,
    organizations: orgs,
    auth,
    sendInvitation: workosInvitations({ apiKey: KEY, fetch: wos.fetch }),
  });
  return { orgs, acme, wos };
}

/** Signs in through WorkOS with a code: login, then the callback with the state cookie. */
async function signIn(code: string, query = '') {
  const login = await app!.inject({ method: 'GET', url: `/auth/login${query}` });
  const to = new URL(login.headers.location as string);
  const state = String(login.headers['set-cookie']).split(';')[0]!;
  const back = await app!.inject({
    method: 'GET',
    url: `/auth/workos/callback?code=${code}&state=${to.searchParams.get('state')}`,
    headers: { cookie: state },
  });
  const session = ([] as string[])
    .concat(back.headers['set-cookie'] ?? [])
    .find((c) => c.startsWith('lw_session='))
    ?.split(';')[0];
  return { login, to, back, session };
}

const as =
  (who: string) =>
  async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
    const r = await app!.inject({
      method,
      url,
      payload: payload as object,
      headers: { authorization: `Bearer ${keyOf(who)}` },
    });
    return { status: r.statusCode, body: r.body ? (r.json() as any) : null };
  };

describe('signing in with WorkOS', () => {
  it('sends people to AuthKit and lets an invited person in, as their role', async () => {
    const { orgs, acme } = await start({ users: { 'code-eve': { email: 'Eve@Example.com' } } });
    await orgs.invite({
      organizationId: acme.id,
      email: 'eve@example.com',
      role: 'watcher',
      invitedBy: 'github:bob',
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const { login, to, back, session } = await signIn('code-eve');
    expect(login.statusCode).toBe(302);
    expect(to.origin + to.pathname).toBe('https://api.workos.com/user_management/authorize');
    expect(Object.fromEntries(to.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'client_123',
      provider: 'authkit',
      redirect_uri: `${API}/auth/workos/callback`,
    });
    expect([back.statusCode, back.headers.location]).toEqual([302, APP]);
    const me = await app!.inject({ method: 'GET', url: '/auth/me', headers: { cookie: session! } });
    expect(me.json()).toMatchObject({ login: 'eve@example.com' });
    const orgsOf = await app!.inject({
      method: 'GET',
      url: '/me/organizations',
      headers: { cookie: session! },
    });
    expect(orgsOf.json().current).toMatchObject({
      id: acme.id,
      role: 'watcher',
      superAdmin: false,
    });
    // Not on the GitHub operator list, and doesn't need to be.
    const projects = await app!.inject({
      method: 'GET',
      url: '/projects',
      headers: { cookie: session! },
    });
    expect(projects.statusCode).toBe(200);
  });

  it('signs out of WorkOS too, so AuthKit doesn’t sign the person straight back in', async () => {
    const { orgs, acme } = await start({ users: { 'code-hal': { email: 'hal@example.com' } } });
    await orgs.invite({
      organizationId: acme.id,
      email: 'hal@example.com',
      role: 'director',
      invitedBy: 'github:bob',
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const { session } = await signIn('code-hal');
    const out = await app!.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie: session!, origin: APP },
    });
    expect(out.statusCode).toBe(200);
    const to = new URL(out.json().redirect);
    expect(to.origin + to.pathname).toBe('https://api.workos.com/user_management/sessions/logout');
    expect(Object.fromEntries(to.searchParams)).toEqual({
      session_id: 'session_code-hal',
      return_to: APP,
    });
    expect(String(out.headers['set-cookie'])).toContain('lw_session=; ');
  });

  it('turns away someone nobody invited, and an address that isn’t verified', async () => {
    await start({
      users: {
        'code-stranger': { email: 'stranger@example.com' },
        'code-unverified': { email: 'new@example.com', email_verified: false },
      },
    });
    const stranger = await signIn('code-stranger');
    expect(stranger.back.statusCode).toBe(403);
    expect(stranger.back.body).toContain('hasn&#39;t been invited');
    expect(stranger.session).toBeUndefined();
    const unverified = await signIn('code-unverified');
    expect([unverified.back.statusCode, unverified.session]).toEqual([403, undefined]);
    expect(unverified.back.body).toContain('Verify new@example.com');
    // A forged or expired state never reaches WorkOS.
    const forged = await app!.inject({
      method: 'GET',
      url: '/auth/workos/callback?code=x&state=y',
    });
    expect(forged.statusCode).toBe(400);
  });

  it('offers both ways in when GitHub is set up too, and takes an invitation link straight to WorkOS', async () => {
    await start({ github: true });
    const choice = await app!.inject({ method: 'GET', url: '/auth/login?returnTo=' + APP });
    expect(choice.statusCode).toBe(200);
    expect(choice.body).toContain('Continue with email, Google or Microsoft');
    expect(choice.body).toContain('continue with GitHub');
    const gh = await app!.inject({ method: 'GET', url: '/auth/login?provider=github' });
    expect(String(gh.headers.location)).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize/);
    const link = await app!.inject({ method: 'GET', url: '/auth/login?invitation_token=tok_1' });
    const to = new URL(String(link.headers.location));
    expect([to.hostname, to.searchParams.get('invitation_token')]).toEqual([
      'api.workos.com',
      'tok_1',
    ]);
  });

  it('hands the invitation token to WorkOS when the person comes back', async () => {
    const { orgs, acme, wos } = await start({
      users: { 'code-fay': { email: 'fay@example.com' } },
    });
    await orgs.invite({
      organizationId: acme.id,
      email: 'fay@example.com',
      role: 'director',
      invitedBy: 'github:bob',
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const { back } = await signIn('code-fay', '?invitation_token=tok_fay');
    expect(back.statusCode).toBe(302);
    expect(wos.exchanged.at(-1)).toMatchObject({ code: 'code-fay', invitation_token: 'tok_fay' });
  });
});

describe('people', () => {
  it('lets a Director invite by email (WorkOS sends it) and withdraw it', async () => {
    const { wos } = await start();
    const bob = as('bob');
    const sent = await bob('POST', '/organization/invitations', {
      email: 'Gil@Example.com',
      role: 'watcher',
    });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({
      emailSent: true,
      invitation: { email: 'gil@example.com', role: 'watcher' },
    });
    expect(wos.invited).toEqual([{ email: 'gil@example.com', auth: `Bearer ${KEY}` }]);
    const people = (await bob('GET', '/organization/people')).body;
    expect(people.organization.slug).toBe('acme');
    expect(people.invitations.map((i: { email: string }) => i.email)).toEqual(['gil@example.com']);
    expect(
      people.members.map((m: { label: string; role: string; icreon: boolean }) => [
        m.label,
        m.role,
        m.icreon,
      ]),
    ).toEqual([
      ['steve', 'director', true],
      ['bob', 'director', false],
      ['dana', 'watcher', false],
    ]);
    expect(
      (await bob('DELETE', `/organization/invitations/${sent.body.invitation.id}`)).status,
    ).toBe(204);
    expect((await bob('GET', '/organization/people')).body.invitations).toEqual([]);
    expect(
      (await bob('POST', '/organization/invitations', { email: 'nope', role: 'watcher' })).status,
    ).toBe(422);
  });

  it('keeps Icreon’s Director, the last Director and yourself from being removed', async () => {
    await start();
    const bob = as('bob');
    const steve = encodeURIComponent(githubSubject('steve'));
    const dana = encodeURIComponent(githubSubject('dana'));
    const self = encodeURIComponent(githubSubject('bob'));
    const icreon = await bob('DELETE', `/organization/members/${steve}`);
    expect([icreon.status, icreon.body.error.code]).toEqual([409, 'icreon_director']);
    expect((await bob('DELETE', `/organization/members/${self}`)).body.error.code).toBe('yourself');
    // Dana becomes a Director, then a Watcher again; then she's removed.
    expect((await bob('PUT', `/organization/members/${dana}`, { role: 'director' })).status).toBe(
      200,
    );
    expect((await bob('PUT', `/organization/members/${dana}`, { role: 'watcher' })).status).toBe(
      200,
    );
    expect((await bob('DELETE', `/organization/members/${dana}`)).status).toBe(204);
    // Icreon's Director, acting in Acme, may remove Bob; then Steve is Acme's last Director.
    const inAcme = (method: 'DELETE', url: string) =>
      app!.inject({
        method,
        url,
        headers: { authorization: `Bearer ${keyOf('steve')}`, 'x-lw-organization': 'acme' },
      });
    expect((await inAcme('DELETE', `/organization/members/${self}`)).statusCode).toBe(204);
    expect((await inAcme('DELETE', `/organization/members/${steve}`)).json().error.code).toBe(
      'yourself',
    );
  });

  it('is closed to Watchers', async () => {
    await start();
    const r = await as('dana')('GET', '/organization/people');
    expect([r.status, r.body.error.code]).toEqual([403, 'read_only']);
  });
});

describe('the admin console', () => {
  const CONSOLE = 'console-key-'.padEnd(48, 'k');
  const viaConsole =
    (actor: { id?: string; email?: string } | null, key = CONSOLE) =>
    async (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => {
      const r = await app!.inject({
        method,
        url,
        payload: payload as object,
        headers: {
          authorization: `Bearer ${key}`,
          'x-lw-organization': DEFAULT_ORGANIZATION,
          ...(actor?.id ? { 'x-lw-actor': actor.id } : {}),
          ...(actor?.email ? { 'x-lw-actor-email': actor.email } : {}),
          'x-lw-actor-name': encodeURIComponent('Steve Lamensdorf'),
        },
      });
      return { status: r.statusCode, body: r.body ? (r.json() as any) : null };
    };
  const steve = { id: 'user_01STEVE00000', email: 'steve@icreon.com' };

  it('lets an Icreon Director administer the platform through it, recorded as themselves', async () => {
    const { orgs } = await start({ console: CONSOLE });
    await orgs.setMember(
      DEFAULT_ORGANIZATION,
      workosSubject(steve.id),
      'director',
      'test',
      'Steve',
    );
    const call = viaConsole(steve);
    expect((await call('GET', '/admin/me')).body).toMatchObject({
      subject: workosSubject(steve.id),
      login: 'steve@icreon.com',
      name: 'Steve Lamensdorf',
    });
    expect((await call('GET', '/admin/organizations')).status).toBe(200);
    const made = await call('POST', '/admin/organizations', { name: 'Globex Industries' });
    expect(made.status).toBe(201);
    // Whoever acted in the console is the new organization's kickoff Director.
    const members = await orgs.members(made.body.organization.id);
    expect(members.map((m) => [m.subject, m.role])).toEqual([
      [workosSubject(steve.id), 'director'],
    ]);
  });

  it('turns away anyone who isn’t an Icreon Director, a call that names nobody, and a wrong key', async () => {
    const { orgs, acme } = await start({ console: CONSOLE });
    const customer = { id: 'user_01CUSTOMER00', email: 'pat@acme.com' };
    await orgs.setMember(acme.id, workosSubject(customer.id), 'director', 'test', 'Pat');
    expect((await viaConsole(customer)('GET', '/admin/organizations')).status).toBe(403);
    expect((await viaConsole(null)('GET', '/admin/organizations')).status).toBe(400);
    expect(
      (await viaConsole(steve, 'wrong'.padEnd(48, 'x'))('GET', '/admin/organizations')).status,
    ).toBe(401);
  });

  it('reaches the admin routes only, not a customer’s projects', async () => {
    const { orgs } = await start({ console: CONSOLE });
    await orgs.setMember(
      DEFAULT_ORGANIZATION,
      workosSubject(steve.id),
      'director',
      'test',
      'Steve',
    );
    const call = viaConsole(steve);
    expect((await call('GET', '/me/organizations')).body.error.code).toBe('console_only');
    expect((await call('POST', '/projects', {})).body.error.code).toBe('console_only');
    expect((await call('GET', '/projects/p-1')).body.error.code).toBe('console_only');
  });

  it('is off unless the key is set', async () => {
    await start();
    expect((await viaConsole(steve)('GET', '/admin/organizations')).status).toBe(401);
  });
});
