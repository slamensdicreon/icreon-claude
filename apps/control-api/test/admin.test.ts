import { createHash } from 'node:crypto';
import {
  DEFAULT_ORGANIZATION,
  githubSubject,
  InMemoryEventStore,
  MemoryOrganizationStore,
  Projections,
} from '@lw/events';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';

const keyOf = (who: string) => `lwk_${createHash('sha256').update(who).digest('hex').slice(0, 40)}`;

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function start() {
  const store = new InMemoryEventStore();
  const projections = new Projections(store);
  await projections.start();
  const orgs = new MemoryOrganizationStore();
  const acme = await orgs.create({ name: 'Acme Corp', slug: 'acme' });
  // Steve is Icreon's (a super admin); Bob is Acme's Director.
  await orgs.setMember(DEFAULT_ORGANIZATION, githubSubject('steve'), 'director', 'test', 'steve');
  await orgs.setMember(acme.id, githubSubject('bob'), 'director', 'test', 'bob');
  const invited: string[] = [];
  const clock = { offset: 0 };
  app = await buildApp({
    now: () => Date.now() + clock.offset,
    store,
    projections,
    commands: () => undefined,
    organizations: orgs,
    sendInvitation: async (email) => {
      invited.push(email);
      return { sent: true, detail: null };
    },
    auth: {
      clientId: 'gh',
      clientSecret: 'gh-secret',
      publicUrl: 'https://api.example.com',
      appUrl: 'https://app.example.com',
      operators: ['steve'],
      apiKeys: ['steve', 'bob'].map((login) => ({
        login,
        sha256: createHash('sha256').update(keyOf(login)).digest('hex'),
      })),
      sessionSecret: 'x'.repeat(40),
      secureCookies: true,
    },
  });
  return { orgs, acme, invited, clock };
}

const call = async (
  who: string,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) => {
  const r = await app!.inject({
    method,
    url,
    payload: payload as object,
    headers: { authorization: `Bearer ${keyOf(who)}`, ...headers },
  });
  return { status: r.statusCode, body: r.body ? (r.json() as any) : null, headers: r.headers };
};

describe('/admin', () => {
  it('lets Icreon create an organization: its creator is the kickoff Director, its first Director invited', async () => {
    const { orgs, invited } = await start();
    const made = await call('steve', 'POST', '/admin/organizations', {
      name: 'Globex Industries',
      directorEmail: 'Dir@Globex.example',
    });
    expect(made.status).toBe(201);
    expect(made.body.organization).toMatchObject({
      name: 'Globex Industries',
      slug: 'globex-industries',
    });
    expect(made.body.invited).toEqual({
      email: 'dir@globex.example',
      emailSent: true,
      detail: null,
    });
    expect(invited).toEqual(['dir@globex.example']);
    const id = made.body.organization.id as string;
    expect((await orgs.members(id)).map((m) => [m.subject, m.role])).toEqual([
      [githubSubject('steve'), 'director'],
    ]);
    const list = (await call('steve', 'GET', '/admin/organizations')).body;
    expect(list.map((o: { slug: string }) => o.slug)).toEqual([
      'icreon',
      'acme',
      'globex-industries',
    ]);
    expect(list.find((o: { id: string }) => o.id === id)).toMatchObject({
      directors: 1,
      watchers: 0,
      invitations: 1,
      projects: 0,
    });
    // The same slug twice is refused.
    const again = await call('steve', 'POST', '/admin/organizations', {
      name: 'Globex Industries',
    });
    expect(again.status).toBe(422);
  });

  it('is Icreon’s alone', async () => {
    await start();
    for (const [method, url] of [
      ['GET', '/admin/organizations'],
      ['POST', '/admin/organizations'],
    ] as const) {
      const r = await call('bob', method, url, { name: 'Sneaky' });
      expect([url, r.status, r.body.error.code]).toEqual([url, 403, 'super_admin_only']);
    }
  });
});

describe('support access', () => {
  it('lets Icreon into a customer for a few hours, in plain sight, and then not', async () => {
    const { acme } = await start();
    const r = await call('steve', 'POST', `/admin/organizations/${acme.id}/support`, { hours: 2 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ role: 'watcher' });
    const until = Date.parse(r.body.expiresAt as string);
    expect(until - Date.now()).toBeGreaterThan(110 * 60_000);
    // Acme's Director sees it, with when it ends.
    const people = (await call('bob', 'GET', '/organization/people')).body.members;
    expect(
      people.find((m: { subject: string }) => m.subject === githubSubject('steve')),
    ).toMatchObject({
      role: 'watcher',
      until: r.body.expiresAt,
    });
    const inAcme = await call('steve', 'GET', '/me/organizations', undefined, {
      'x-lw-organization': acme.id,
    });
    expect(inAcme.body.current).toMatchObject({ id: acme.id, role: 'watcher' });
    expect((await call('bob', 'POST', `/admin/organizations/${acme.id}/support`, {})).status).toBe(
      403,
    );
    expect(
      (await call('steve', 'POST', `/admin/organizations/${acme.id}/support`, { hours: 999 }))
        .status,
    ).toBe(400);
  });
});

describe('the kickoff Director', () => {
  it('stays for the first 3 months; after that the customer’s Directors may remove them', async () => {
    const { orgs, acme, clock } = await start();
    await orgs.setMember(acme.id, githubSubject('steve'), 'director', 'test', 'steve');
    const steve = `/organization/members/${encodeURIComponent(githubSubject('steve'))}`;
    const people = (await call('bob', 'GET', '/organization/people')).body;
    expect(people.kickoffUntil).not.toBeNull();
    const early = await app!.inject({
      method: 'DELETE',
      url: steve,
      headers: { authorization: `Bearer ${keyOf('bob')}` },
    });
    expect([early.statusCode, early.json().error.code]).toEqual([409, 'icreon_director']);
    clock.offset = 95 * 86_400_000;
    expect((await call('bob', 'GET', '/organization/people')).body.kickoffUntil).toBeNull();
    const later = await app!.inject({
      method: 'DELETE',
      url: steve,
      headers: { authorization: `Bearer ${keyOf('bob')}` },
    });
    expect(later.statusCode).toBe(204);
  });
});

describe('the organization switcher', () => {
  it('keeps the chosen organization in a cookie, for every request and the stream', async () => {
    const { orgs, acme } = await start();
    await orgs.setMember(acme.id, githubSubject('steve'), 'director', 'test');
    expect((await call('steve', 'GET', '/me/organizations')).body.current.id).toBe(
      DEFAULT_ORGANIZATION,
    );
    const pick = await call('steve', 'PUT', '/me/organization', { id: acme.id });
    expect(pick.status).toBe(200);
    const cookie = String(pick.headers['set-cookie']);
    expect(cookie).toMatch(
      new RegExp(`^lw_org=${acme.id}; Path=/; HttpOnly; SameSite=Lax;.*Secure$`),
    );
    const now = await call('steve', 'GET', '/me/organizations', undefined, {
      cookie: cookie.split(';')[0]!,
    });
    expect(now.body.current).toMatchObject({ id: acme.id, role: 'director', superAdmin: true });
  });

  it('only switches to an organization the person is in, and forgets a choice that no longer holds', async () => {
    const { acme } = await start();
    const r = await call('bob', 'PUT', '/me/organization', { id: DEFAULT_ORGANIZATION });
    expect([r.status, r.body.error.code]).toEqual([404, 'unknown_organization']);
    // A stale cookie (an organization Steve left) falls back to his first one.
    const stale = await call('steve', 'GET', '/me/organizations', undefined, {
      cookie: `lw_org=${acme.id}`,
    });
    expect(stale.body.current.id).toBe(DEFAULT_ORGANIZATION);
  });
});
