import { OPTIMIZELY_DEFAULTS } from '@lw/connectors';
import { describe, expect, it } from 'vitest';
import { optimizelyChecks, portalBlueprintProblems } from '../optimizely/checks';
import type { PlatformCheckContext } from '../src';

/**
 * The customer portal's checks, against a head that answers the way the playbook's prompts fix
 * it: a sign-in gate, `POST /api/session` for the demo accounts, and sections marked with who
 * they are shown to. No live portal has been built yet; this is the contract, both sides of it.
 */

const target = {
  cmsUrl: 'https://app-acme.cms.optimizely.com',
  application: 'Acme Portal',
  typePrefix: 'Acme',
  languages: ['en'],
};
const EDITING = 'acme-portal-editing.vercel.app';
const PRODUCTION = 'acme-portal.vercel.app';
const APP = {
  key: 'Acme_Portal',
  startPage: { key: 'a'.repeat(32) },
  assetsRoot: 'b'.repeat(32),
  hosts: [
    { host: PRODUCTION, type: 'primary', scheme: 'https' },
    { host: EDITING, type: 'preview', scheme: 'https' },
  ],
  previewTokens: true,
  previewUrl: '{host}/preview?key={key}&ver={version}&loc={locale}&ctx={context}',
};

const settings = {
  column: ['full', 'main', 'side'],
  audience: ['everyone', 'business-manager', 'finance-contact'],
};
const component = (key: string, name: string, more: Record<string, unknown> = {}) => ({
  key,
  name,
  attrs: {
    contentType: `Acme${name.replace(/ /g, '')}`,
    properties: [{ name: 'heading', type: 'string' }],
    displayTemplates: [
      { key: `Acme${name.replace(/ /g, '')}Default`, name: 'Default', default: true, settings },
    ],
    ...more,
  },
});
const persona = (key: string, name: string, more: Record<string, unknown> = {}) => ({
  key,
  name,
  attrs: {
    name,
    email: `${name.split(' ')[0]!.toLowerCase()}@portal.example`,
    role: key,
    audience: key,
    navigation: ['overview'],
    presentationPath: [{ page: 'overview', step: 'Sign in' }],
    variants: [],
    ...more,
  },
});
const blueprint = (): NonNullable<PlatformCheckContext['blueprint']> => ({
  collections: {
    components: [
      { ...component('welcome', 'Welcome'), pilot: true },
      component('claims-table', 'Claims Table'),
      component('promo', 'Promo'),
      component('sign-in', 'Sign In'),
    ],
    templates: [
      { key: 'portal-page', name: 'Portal Page', attrs: { contentType: 'AcmePortalPage' } },
    ],
    pages: [
      {
        key: 'overview',
        name: 'Overview',
        attrs: {
          path: '/',
          template: 'portal-page',
          personas: ['business-manager', 'finance-contact'],
          components: [
            { component: 'welcome', column: 'full' },
            { component: 'promo', column: 'side', audience: 'business-manager' },
            { component: 'promo', column: 'side', audience: 'finance-contact' },
          ],
        },
      },
      {
        key: 'claims',
        name: 'Claims',
        attrs: {
          path: '/claims',
          template: 'portal-page',
          personas: ['business-manager'],
          components: [{ component: 'claims-table', column: 'full' }],
        },
      },
      {
        key: 'sign-in',
        name: 'Sign in',
        attrs: {
          path: '/sign-in',
          template: 'portal-page',
          bare: true,
          personas: [],
          components: [{ component: 'sign-in' }],
        },
      },
    ],
    personas: [
      persona('business-manager', 'Angela Mitchell', { navigation: ['overview', 'claims'] }),
      persona('finance-contact', 'Elena Morris', {
        variants: [{ page: 'overview', component: 'promo', content: 'Your statement is ready.' }],
      }),
    ],
  },
});

interface Section {
  name: string;
  contentType: string;
  displayTemplate: string;
  settings: Record<string, string>;
  properties: Record<string, unknown>;
}
const section = (type: string, heading: string, audience = 'everyone'): Section => ({
  name: heading,
  contentType: `Acme${type}`,
  displayTemplate: `Acme${type}Default`,
  settings: { column: 'full', audience },
  properties: { heading },
});
/** What the CMS holds, by route. */
const CONTENT: Record<string, Section[]> = {
  '/': [
    section('Welcome', 'Good morning, {firstName}.'),
    section('Promo', 'Report a claim in minutes', 'business-manager'),
    section('Promo', 'Your fall statement is ready', 'finance-contact'),
  ],
  '/claims': [section('ClaimsTable', 'Claims and reports')],
  '/sign-in': [section('SignIn', 'Sign in to your member portal')],
};

const ACCOUNTS: Record<string, { audience: string; firstName: string }> = {
  'angela@portal.example': { audience: 'business-manager', firstName: 'Angela' },
  'elena@portal.example': { audience: 'finance-contact', firstName: 'Elena' },
};

interface Head {
  /** No gate: a signed-out reader gets the page. */
  open?: boolean;
  /** Any email signs in. */
  anyone?: boolean;
  /** Emails that can't sign in. */
  locked?: string[];
  /** Sections are shown to every role (the wrapper filters nothing). */
  unfiltered?: boolean;
  /** Sections carry no data-audience. */
  unmarked?: boolean;
  /** Pages that answer this status signed in. */
  status?: Record<string, number>;
  content?: Record<string, Section[]>;
  /** Hosts that answer; the others don't. */
  hosts?: string[];
}

/** A portal head as the shell's prompt describes it. */
const head = (h: Head = {}) =>
  (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (h.hosts && !h.hosts.includes(url.host)) throw new Error('no such host');
    const headers = new Headers(init.headers);
    const respond = (status: number, body = '', more: Record<string, string> = {}, at = url) => {
      const res = new Response(status === 204 ? null : body, { status, headers: more });
      Object.defineProperty(res, 'url', { value: at.toString() });
      return res;
    };
    if (url.pathname === '/api/session' && init.method === 'POST') {
      const { email } = JSON.parse(String(init.body)) as { email: string };
      const account = ACCOUNTS[email] ?? (h.anyone ? { audience: 'business-manager' } : null);
      if (!account || h.locked?.includes(email))
        return respond(401, '{"error":"Not a demo account"}');
      return respond(200, '{}', {
        'set-cookie': `portal_session=${account.audience}.sig; Path=/; HttpOnly; SameSite=Lax`,
      });
    }
    const audience = /portal_session=([a-z-]+)\.sig/.exec(headers.get('cookie') ?? '')?.[1] ?? null;
    const route = url.pathname.replace(/^\/en(?=\/|$)/, '').replace(/\/$/, '') || '/';
    const signInScreen = route === '/sign-in';
    if (!audience && !signInScreen && !h.open) {
      const to = new URL(`/sign-in?next=${encodeURIComponent(route)}`, url);
      if (init.redirect === 'manual') return respond(307, '', { location: to.toString() });
      return respond(200, page('/sign-in', null, h), {}, to);
    }
    if (h.status?.[route]) return respond(h.status[route]!);
    return respond(200, page(route, audience, h));
  }) as typeof fetch;

function page(route: string, audience: string | null, h: Head): string {
  const sections = (h.content ?? CONTENT)[route] ?? [];
  const first = Object.values(ACCOUNTS).find((a) => a.audience === audience)?.firstName ?? '';
  const shown = sections.filter(
    (s) => h.unfiltered || s.settings.audience === 'everyone' || s.settings.audience === audience,
  );
  return `<html><body><main>${shown
    .map(
      (s) =>
        `<div><section${h.unmarked ? '' : ` data-audience="${s.settings.audience}"`} data-column="${s.settings.column}"><h2>${String(s.properties.heading).replace('{firstName}', first)}</h2></section></div>`,
    )
    .join('')}</main></body></html>`;
}

const ctx = (
  over: Partial<PlatformCheckContext> = {},
  cms: { content?: Record<string, Section[]>; application?: { code: number; body: unknown } } = {},
): PlatformCheckContext => ({
  projectId: 'p',
  target,
  scope: { collection: null, items: [] },
  blueprint: blueprint(),
  read: async (server, op, args) => {
    if (server === 'optimizely-cms' && op === 'application.read')
      return cms.application ?? { code: 200, body: APP };
    if (server === 'optimizely-cms' && op === 'content.read') {
      const route = String(args.path).replace('/content/Acme_Portal', '') || '/';
      const sections = (cms.content ?? CONTENT)[route];
      return sections
        ? { code: 200, body: { status: 'published', properties: {}, composition: sections } }
        : { code: 404, body: { error: 'Not found' } };
    }
    return { code: 404, body: { error: 'Not connected' } };
  },
  credential: async () => null,
  document: async () => null,
  ...over,
});
const run = (id: string, c: PlatformCheckContext, h?: Head) =>
  optimizelyChecks({ ...OPTIMIZELY_DEFAULTS, fetch: head(h) })[id]!(c);

describe('a portal Blueprint on Optimizely', () => {
  const inventory = { pages: [{ path: '/' }, { path: '/claims' }, { path: '/sign-in' }] };
  const problems = (change: (bp: ReturnType<typeof blueprint>) => void, inv = inventory) => {
    const bp = blueprint();
    change(bp);
    return portalBlueprintProblems(bp, inv, 'Acme');
  };
  const pages = (bp: ReturnType<typeof blueprint>) => bp.collections.pages!;
  const components = (bp: ReturnType<typeof blueprint>) => bp.collections.components!;

  it('passes one with every screen placed and each role’s content placed for that role', async () => {
    expect(problems(() => {})).toEqual([]);
    const r = await run('blueprint.portal', ctx({ document: async () => inventory }));
    expect(r).toMatchObject({ status: 'pass' });
    expect(r.detail).toContain('3 pages on 1 page type and 4 components');
    expect(r.detail).toContain('2 sections are shown to one role');
    expect(await run('blueprint.portal', ctx({ blueprint: null }))).toMatchObject({
      status: 'fail',
      detail: 'No Blueprint has been written',
    });
  });

  it('wants every screen placed, a start page, a bare sign-in screen and the page type', () => {
    expect(problems(() => {}, { pages: [{ path: '/billing' }] })).toEqual([
      'screen /billing is neither mapped nor dropped',
    ]);
    // A dropped page is placed: the decision is on record.
    expect(
      problems(
        (bp) => pages(bp).push({ key: 'billing', name: 'Billing', status: 'drop' } as never),
        {
          pages: [{ path: '/' }],
        },
      ),
    ).toEqual([]);
    expect(problems((bp) => pages(bp).shift())).toEqual(
      expect.arrayContaining(['no start page: a page with attrs.path "/" (the dashboard)']),
    );
    expect(problems((bp) => delete pages(bp)[2]!.attrs!.bare)).toEqual([
      'the sign-in screen (sign-in) is not marked attrs.bare: true',
    ]);
    expect(problems((bp) => pages(bp).pop())).toEqual(
      expect.arrayContaining([
        'no sign-in screen: a page with attrs.path "/sign-in" and attrs.bare: true',
      ]),
    );
    expect(problems((bp) => (bp.collections.templates = []))).toEqual(
      expect.arrayContaining([
        'no page type: a `templates` entry for the experience type every page uses',
        'page overview names no page type the Blueprint has (attrs.template)',
      ]),
    );
  });

  it('wants every component a prefixed content type with something to edit and a default template of its own', () => {
    expect(problems((bp) => (components(bp)[0]!.attrs!.contentType = 'Welcome'))).toEqual([
      "welcome's content type Welcome lacks the prefix Acme",
    ]);
    expect(problems((bp) => (components(bp)[0]!.attrs!.displayTemplates = []))).toEqual([
      'welcome has no single default display template of its own',
    ]);
    expect(problems((bp) => (components(bp)[0]!.attrs!.properties = []))).toEqual([
      'welcome has neither properties a marketer edits nor demo data to show',
    ]);
    // A block that shows only records has demo data and no words.
    expect(
      problems((bp) => {
        components(bp)[0]!.attrs!.properties = [];
        components(bp)[0]!.attrs!.data = { reads: ['claims'] };
      }),
    ).toEqual([]);
    expect(problems((bp) => (components(bp)[0]!.pilot = false))).toEqual(['no pilot components']);
    expect(
      problems(
        (bp) => (components(bp)[1]!.attrs!.children = { contentType: 'Row', properties: [] }),
      ),
    ).toEqual([
      "claims-table's child items have no limit",
      "claims-table's child type lacks the prefix Acme",
    ]);
    expect(problems((bp) => components(bp).push(component('tabs', 'Tabs')))).toEqual([
      'tabs is on no page: place it, or leave it out',
    ]);
  });

  it('wants each role’s own content placed on its page, for that role alone', () => {
    const promos = (bp: ReturnType<typeof blueprint>) =>
      pages(bp)[0]!.attrs!.components as { component: string; audience?: string }[];
    expect(problems((bp) => promos(bp).pop())).toEqual([
      "finance-contact's own promo on overview is not placed: add it to the page's components with audience finance-contact",
    ]);
    expect(problems((bp) => delete promos(bp)[1]!.audience)).toEqual([
      'overview also shows a promo to everyone, so finance-contact would see both: set it to the roles it is for',
    ]);
    expect(problems((bp) => (promos(bp)[1]!.audience = 'claims-admin'))).toEqual(
      expect.arrayContaining([
        "page overview shows promo to claims-admin, which is no persona's audience",
      ]),
    );
    // What a marketer can set is what the component's display template offers.
    expect(
      problems((bp) => {
        (components(bp)[2]!.attrs!.displayTemplates as { settings: unknown }[])[0]!.settings = {
          column: ['full'],
        };
      }),
    ).toEqual(
      expect.arrayContaining([
        "page overview sets promo's audience to business-manager, which its default display template doesn't offer",
        "page overview sets promo's column to side, which its default display template doesn't offer",
      ]),
    );
    expect(
      problems((bp) => (bp.collections.personas![1]!.attrs!.navigation = ['overview', 'claims'])),
    ).toEqual([
      "finance-contact's navigation shows claims, which they may not open (its attrs.personas)",
    ]);
  });
});

describe('the portal’s sign-in', () => {
  it('passes when the gate, the demo accounts and the refusal all hold on the editing address', async () => {
    const r = await run('portal.sign-in', ctx());
    expect(r).toMatchObject({ status: 'pass' });
    expect(r.detail).toBe(
      `On ${EDITING} a signed-out reader is sent to the sign-in screen, all 2 demo accounts sign in, and another email is refused.`,
    );
  });

  it('names each thing that does not hold', async () => {
    const open = await run('portal.sign-in', ctx(), { open: true });
    expect(open.status).toBe('fail');
    expect(open.detail).toContain('is not sent to the sign-in screen (it answered 200)');
    const anyone = await run('portal.sign-in', ctx(), { anyone: true });
    expect(anyone.detail).toContain('accepts an email that is no demo account');
    const locked = await run('portal.sign-in', ctx(), { locked: ['elena@portal.example'] });
    expect(locked).toMatchObject({
      status: 'fail',
      detail: "Elena Morris (elena@portal.example) can't sign in: /api/session answered 401",
    });
    // The head isn't there at all.
    const down = await run('portal.sign-in', ctx(), { hosts: [PRODUCTION] });
    expect(down.status).toBe('fail');
    expect(down.detail).toContain('it answered nothing');
  });

  it('is pending without personas or a readable application, and fails without one', async () => {
    const none = blueprint();
    none.collections.personas = [];
    expect(await run('portal.sign-in', ctx({ blueprint: none }))).toMatchObject({
      status: 'pending',
    });
    expect(
      await run('portal.sign-in', ctx({}, { application: { code: 503, body: { error: 'down' } } })),
    ).toMatchObject({ status: 'pending' });
    expect(
      await run('portal.sign-in', ctx({}, { application: { code: 404, body: {} } })),
    ).toMatchObject({ status: 'fail' });
  });
});

describe('portal pages as a persona reads them', () => {
  it('reads the pilot page signed in as the default persona, tokens filled', async () => {
    const r = await run('portal.pilot-page', ctx());
    expect(r).toMatchObject({
      status: 'pass',
      detail: `Signed in as Angela Mitchell, the start page renders its 3 sections on ${EDITING}.`,
    });
    expect(await run('portal.pilot-page', ctx({}, { content: { '/': [] } }))).toMatchObject({
      status: 'fail',
      detail: 'The start page has no sections yet',
    });
    // The CMS has a section the head doesn't show.
    const missing = await run(
      'portal.pilot-page',
      ctx({}, { content: { '/': [...CONTENT['/']!, section('ClaimsTable', 'Recent claims')] } }),
    );
    expect(missing).toMatchObject({ status: 'fail' });
    expect(missing.detail).toContain(
      '"Recent claims" (Recent claims) is not on / as Angela Mitchell',
    );
    expect(await run('portal.pilot-page', ctx(), { status: { '/': 500 } })).toMatchObject({
      status: 'fail',
      detail: `https://${EDITING}/en/ answered 500 as Angela Mitchell`,
    });
  });

  it('reads every page as someone who may open it, and the sign-in screen signed out', async () => {
    const r = await run('portal.pages-render', ctx());
    expect(r).toMatchObject({ status: 'pass' });
    expect(r.detail).toBe(
      '3 pages render their sections: / as Angela Mitchell, /claims as Angela Mitchell, /sign-in signed out.',
    );
    // A page's own task is judged on that page.
    const own = await run(
      'portal.pages-render',
      ctx({ scope: { collection: 'pages', items: ['claims'] } }),
    );
    expect(own.detail).toBe('1 page renders their sections: /claims as Angela Mitchell.');
  });

  it('fails a page that is not in the CMS, answers an error or falls back to the sign-in screen', async () => {
    const absent = await run(
      'portal.pages-render',
      ctx({}, { content: { '/': CONTENT['/']!, '/sign-in': CONTENT['/sign-in']! } }),
    );
    expect(absent).toMatchObject({ status: 'fail' });
    expect(absent.detail).toContain('/claims does not exist in the CMS yet');
    const broken = await run('portal.pages-render', ctx(), { status: { '/claims': 500 } });
    expect(broken.detail).toContain('/en/claims/ answered 500 as Angela Mitchell');
    // A persona who can't sign in can't be shown a page.
    const locked = await run('portal.pages-render', ctx(), { locked: ['angela@portal.example'] });
    expect(locked.detail).toContain("/: Angela Mitchell can't sign in (/api/session answered 401)");
    // A section set for another role is not owed to the reader.
    const theirs = await run(
      'portal.pages-render',
      ctx({ scope: { collection: 'pages', items: ['overview'] } }),
    );
    expect(theirs).toMatchObject({ status: 'pass' });
  });
});

describe('content by role', () => {
  it('passes when each persona sees their own sections and none of another role’s', async () => {
    const r = await run('portal.role-content', ctx());
    expect(r).toMatchObject({ status: 'pass' });
    expect(r.detail).toBe(
      "2 sections are shown to one role, on 1 page: each persona sees their own and none of another role's.",
    );
  });

  it('fails when the head shows a role another role’s section, or marks none', async () => {
    const leaked = await run('portal.role-content', ctx(), { unfiltered: true });
    expect(leaked.status).toBe('fail');
    expect(leaked.detail).toContain('/ shows Angela Mitchell a section set for finance-contact');
    expect(leaked.detail).toContain('/ shows Elena Morris a section set for business-manager');
    const unmarked = await run('portal.role-content', ctx(), { unmarked: true });
    expect(unmarked.detail).toContain(
      '/ shows Angela Mitchell 0 of the 1 section set for business-manager (each rendered section carries data-audience)',
    );
  });

  it('fails when the CMS lacks a role’s own section, keeps a copy for everyone, or has none at all', async () => {
    const [welcome, forManager, forFinance] = CONTENT['/']!;
    const without = await run(
      'portal.role-content',
      ctx({}, { content: { ...CONTENT, '/': [welcome!, forManager!] } }),
    );
    expect(without.detail).toContain(
      "/ has no Promo section shown to finance-contact: Elena Morris's own content is missing",
    );
    const both = await run(
      'portal.role-content',
      ctx(
        {},
        {
          content: {
            ...CONTENT,
            '/': [welcome!, section('Promo', 'Report a claim in minutes'), forFinance!],
          },
        },
      ),
    );
    expect(both.detail).toContain(
      '/ also shows a Promo section to everyone, so Elena Morris sees both',
    );
    const stray = await run(
      'portal.role-content',
      ctx(
        {},
        { content: { ...CONTENT, '/': [...CONTENT['/']!, section('Promo', 'X', 'auditor')] } },
      ),
    );
    expect(stray.detail).toContain("is shown to auditor, which is no persona's audience");
    const plain = blueprint();
    plain.collections.personas![1]!.attrs!.variants = [];
    const none = await run(
      'portal.role-content',
      ctx({ blueprint: plain }, { content: { ...CONTENT, '/': [welcome!] } }),
    );
    expect(none).toMatchObject({ status: 'fail' });
    expect(none.detail).toContain('No section on any page is shown to one role');
  });
});

describe('the portal on production', () => {
  it('signs in and reads every page on the application’s primary host', async () => {
    const r = await run('portal.production', ctx());
    expect(r).toMatchObject({ status: 'pass' });
    expect(r.detail).toBe(
      `On production (${PRODUCTION}) the demo accounts sign in and 3 pages render for a persona who may open them.`,
    );
    // The editing address being right says nothing about production.
    const down = await run('portal.production', ctx(), { hosts: [EDITING] });
    expect(down.status).toBe('fail');
    expect(down.detail).toContain(`https://${PRODUCTION}/ is not sent to the sign-in screen`);
    // And the other way round: the editing checks read the preview host.
    expect(await run('portal.sign-in', ctx(), { hosts: [EDITING] })).toMatchObject({
      status: 'pass',
    });
  });
});
