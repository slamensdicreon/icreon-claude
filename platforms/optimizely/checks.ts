import { mapLimit, type OptimizelyVerifyConfig } from '@lw/connectors';
import { few, titleIn } from '../src/discovery';
import type { CheckResult, PlatformCheck, PlatformCheckContext } from '../src/index';
// Reading a page as a visitor does is the same on every platform.
import {
  headingsOf as headingsIn,
  isChallengePage,
  redirectedAway,
  showsHeading,
  titleOf,
  visibleText as readableText,
  wordsOf,
} from '../sitecoreai/checks';
import { optimizelyTarget } from './pack';

/**
 * Optimizely's acceptance checks: what the CMS holds, what Optimizely Graph serves and what the
 * head renders, read through the project's own tool servers. Checks never change anything. A
 * check that can't reach what it needs answers pending with the reason, never pass.
 */

const pass = (detail: string, data?: unknown): CheckResult => ({ status: 'pass', detail, data });
const fail = (problems: string[], data?: unknown): CheckResult => ({
  status: 'fail',
  detail: problems.join('; '),
  data,
});
const pending = (detail: string): CheckResult => ({ status: 'pending', detail });

type Item = NonNullable<PlatformCheckContext['blueprint']>['collections'][string][number];

interface TypeView {
  key: string;
  baseType?: string;
  compositionBehaviors?: string[];
}
interface TemplateView {
  key: string;
  contentType?: string;
  isDefault?: boolean;
}
interface ApplicationView {
  key: string;
  startPage?: { key?: string };
  assetsRoot?: string | null;
  hosts?: { host: string; type?: string | null; scheme?: string | null }[];
  previewTokens?: boolean;
  previewUrl?: string | null;
}
interface SectionView {
  name?: string;
  contentType?: string;
  displayTemplate?: string;
  /** The display template's settings as chosen for this section (a portal's column and audience). */
  settings?: Record<string, string> | null;
  properties?: Record<string, unknown>;
}
interface RouteView {
  route: string | null;
  host: string | null;
  name: string | null;
  status: string | null;
}

const pascal = (s: string) =>
  s
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');

/**
 * The content type a Blueprint item becomes: `attrs.contentType` when the Blueprint names it,
 * else the project's prefix and the item's name (Hero becomes AcmeHero).
 */
export function typeKeyOf(
  item: { name: string; attrs?: Record<string, unknown> },
  prefix: string,
): string {
  const named = item.attrs?.contentType;
  if (typeof named === 'string' && named) return named;
  const name = pascal(item.name);
  return name.startsWith(prefix) ? name : `${prefix}${name}`;
}

/** Blueprint items the build owes: not merged into another, not dropped. */
const built = (items: Item[] | undefined) =>
  (items ?? []).filter(
    (i) => !['merge', 'drop', 'dropped', 'out-of-scope'].includes(i.status ?? ''),
  );

/** The Blueprint items a check covers: the task's own when it has some, else the collection. */
function covered(ctx: PlatformCheckContext, collection: string): Item[] | null {
  if (!ctx.blueprint) return null;
  const all = built(ctx.blueprint.collections[collection]);
  if (ctx.scope.collection === collection && ctx.scope.items.length)
    return all.filter((i) => ctx.scope.items.includes(i.key));
  return all;
}

const reason = (r: { code: number; body: unknown }) =>
  (r.body as { error?: string } | null)?.error ?? `answered ${r.code}`;

async function application(ctx: PlatformCheckContext): Promise<ApplicationView | CheckResult> {
  const r = await ctx.read('optimizely-cms', 'application.read', {});
  if (r.code === 404) return fail(['The application does not exist in the CMS yet']);
  if (r.code !== 200) return pending(`The application could not be read: ${reason(r)}`);
  return r.body as ApplicationView;
}
const isResult = (v: object): v is CheckResult => 'status' in v && 'detail' in v;

async function contentTypes(ctx: PlatformCheckContext): Promise<TypeView[] | CheckResult> {
  const r = await ctx.read('optimizely-cms', 'contenttype.list', {});
  if (r.code !== 200) return pending(`Content types could not be read: ${reason(r)}`);
  return (r.body as { contentTypes?: TypeView[] }).contentTypes ?? [];
}

async function displayTemplates(ctx: PlatformCheckContext): Promise<TemplateView[] | CheckResult> {
  const r = await ctx.read('optimizely-cms', 'displaytemplate.list', {});
  if (r.code !== 200) return pending(`Display templates could not be read: ${reason(r)}`);
  return (r.body as { displayTemplates?: TemplateView[] }).displayTemplates ?? [];
}

/**
 * A page a check judges: the Blueprint's path for it, where the team's item for it is in the
 * CMS, and its route on the head (routes start with the locale).
 */
interface PageRef {
  path: string;
  label: string;
  cms(application: string): string;
  route(locale: string): string;
}

const pageRef = (path: string): PageRef => {
  const below = path.split('/').filter(Boolean).join('/');
  return {
    path: below ? `/${below}` : '/',
    label: below ? `/${below}` : 'The start page',
    cms: (application) => `/content/${application}${below ? `/${below}` : ''}`,
    route: (locale) => `/${locale}${below ? `/${below}` : ''}/`,
  };
};

/** Where the Blueprint sends a page's visitors instead (a structural parent the source redirects). */
const redirectOf = (p: Item) => {
  const v = p.attrs?.redirect ?? p.attrs?.redirectTo ?? p.attrs?.redirectsTo;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
};

/** The Blueprint's kept pages that have a source path and are not an error page. */
const pathedPages = (ctx: PlatformCheckContext) =>
  built(ctx.blueprint?.collections.pages).filter(
    (p) => !p.attrs?.errorPage && typeof p.attrs?.path === 'string' && p.attrs.path.startsWith('/'),
  );

/**
 * The Blueprint's pages that have a route of their own: kept, with a path, not an error page, and
 * not one whose visitors are redirected elsewhere (there is no page of it to judge).
 */
const routedPages = (ctx: PlatformCheckContext) => pathedPages(ctx).filter((p) => !redirectOf(p));

/**
 * The pages a check covers: the task's own (a page's migration is judged on that page), else
 * every page the Blueprint keeps, else the start page. Capped: a check opens each one.
 */
function pagesOf(ctx: PlatformCheckContext, cap = 20): PageRef[] {
  const all = routedPages(ctx);
  const own =
    ctx.scope.collection === 'pages' && ctx.scope.items.length
      ? all.filter((p) => ctx.scope.items.includes(p.key))
      : all;
  const paths = [...new Set(own.map((p) => String(p.attrs!.path)))];
  return paths.length ? paths.slice(0, cap).map(pageRef) : [pageRef('/')];
}

/**
 * One verdict over the task's pages: every failure named by its page, pending only when nothing
 * failed. One page at a time unless the check says how many it reads at once.
 */
const eachPage =
  (
    one: (ctx: PlatformCheckContext, page: PageRef) => Promise<CheckResult>,
    opts: { cap?: number; atOnce?: number } = {},
  ): PlatformCheck =>
  async (ctx) => {
    const pages = pagesOf(ctx, opts.cap);
    const results = await mapLimit(pages, opts.atOnce ?? 1, async (p) => ({
      page: p,
      result: await one(ctx, p),
    }));
    if (results.length === 1) return results[0]!.result;
    const of = (status: CheckResult['status']) => results.filter((r) => r.result.status === status);
    const data = results.map((r) => ({
      path: r.page.path,
      status: r.result.status,
      data: r.result.data,
    }));
    if (of('fail').length)
      return fail(
        of('fail').map((r) => `${r.page.path}: ${r.result.detail}`),
        data,
      );
    if (of('pending').length)
      return {
        status: 'pending',
        detail: of('pending')
          .map((r) => `${r.page.path}: ${r.result.detail}`)
          .join('; '),
        data,
      };
    return pass(
      `${results.length} pages pass: ${results.map((r) => r.page.path).join(', ')}.`,
      data,
    );
  };

/** A page's sections, as the CMS holds its latest version. */
async function pageContent(
  ctx: PlatformCheckContext,
  path: string,
  label: string,
): Promise<
  { status?: string; sections: SectionView[]; properties: Record<string, unknown> } | CheckResult
> {
  const r = await ctx.read('optimizely-cms', 'content.read', { path });
  if (r.code === 404) return fail([`${label} does not exist in the CMS yet (${path})`]);
  if (r.code !== 200) return pending(`${label} could not be read: ${reason(r)}`);
  const b = r.body as {
    status?: string;
    composition?: SectionView[];
    properties?: Record<string, unknown>;
  };
  return { status: b.status, sections: b.composition ?? [], properties: b.properties ?? {} };
}

type HostView = NonNullable<ApplicationView['hosts']>[number];

const primaryHost = (a: ApplicationView) =>
  (a.hosts ?? []).find((h) => h.type === 'primary') ?? (a.hosts ?? [])[0] ?? null;

/**
 * Where the build is looked at: the application's preview host (the editing host, which runs the
 * integration branch) when it has one, else its primary host. The same published content either
 * way; production runs the reviewed code only after the release.
 */
const buildHost = (a: ApplicationView) =>
  (a.hosts ?? []).find((h) => h.type === 'preview') ?? primaryHost(a);

/**
 * Why the start page didn't answer, with the cause seen on a build when it is published and in
 * Graph all the same: the host was deployed before it was told its application's host.
 */
const startPageAnswered = (status: number, host: string) =>
  `The start page answered ${status || 'nothing'}${status === 404 ? ` on ${host}. If it is published and in Graph, that host was built before OPTIMIZELY_APPLICATION_HOST was set (a deployment keeps the variables it was built with): deploy it again, with hosting.deploy.preview of the integration branch` : ''}`;

/** A name as its words: lower case, without the file extension. */
const words = (name: string) =>
  name
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,5}$/, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * Whether an uploaded file is a Blueprint media item's: its name holds every word of the item's
 * key, of its name, or of its source file's name (hero-background is hero-background-desktop.jpg).
 */
function namedFor(
  fileName: string,
  item: { key: string; name: string; attrs?: Record<string, unknown> },
): boolean {
  const have = new Set(words(fileName));
  const source = typeof item.attrs?.url === 'string' ? item.attrs.url.split(/[?#]/)[0]! : '';
  return [item.key, item.name, source.slice(source.lastIndexOf('/') + 1)]
    .map(words)
    .some((want) => want.length > 0 && want.every((w) => have.has(w)));
}

/** A page of the head as a visitor gets it: status, final URL and body. */
async function page(cfg: OptimizelyVerifyConfig, url: string) {
  try {
    const res = await cfg.fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'Launchworks checks' },
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    return { status: res.status, url: res.url || url, html: await res.text() };
  } catch (err) {
    return { status: 0, url, html: '', error: err instanceof Error ? err.message : String(err) };
  }
}

/** A page behind a login wall (Vercel Authentication) instead of the head. */
const behindLogin = (p: { status: number; url: string; html: string }) =>
  p.status === 401 ||
  /vercel\.com\/(sso|login)/i.test(p.url) ||
  /Authentication Required|vercel-sso/i.test(p.html.slice(0, 4000));

export const visibleText = (html: string) =>
  html
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&#x27;|&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

/** Text for comparing: case, typographic quotes and runs of spaces don't make a difference. */
const fold = (s: string) =>
  s
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

/** The headings a section's content should show on the page: its own and its cards'. */
function headingsOf(properties: Record<string, unknown> | undefined): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.heading === 'string' && o.heading.trim()) out.push(o.heading.trim());
      Object.values(o).forEach(walk);
    }
  };
  walk(properties ?? {});
  return out;
}

/** A reference to another item, as a property holds it. */
const REFERENCE = /^cms:\/\/content\/([0-9a-f-]{32,36})$/i;

/** The items a block's or a page's properties point at, by key. */
function referencesIn(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') {
    const key = REFERENCE.exec(v.trim())?.[1];
    if (key) out.push(key.replace(/-/g, '').toLowerCase());
  } else if (Array.isArray(v)) v.forEach((x) => referencesIn(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => referencesIn(x, out));
  return out;
}

/** Copy nobody wrote for the site: what a block shows while it waits for its content. */
const PLACEHOLDERS = [
  /lorem ipsum|\bplaceholder\b|\b(?:text|title|heading|link|label|copy) goes here\b|\b(?:your|add|enter|insert) (?:a |the |your )?(?:text|title|heading|link|label|copy) here\b|\blink text\b|\bmenu item \d|\bcolumn heading\b|\bsection heading\b|\bexample\.(?:com|org)\b/gi,
  /\bTODO\b|\bTBD\b/g,
];
const placeholdersIn = (text: string) => [
  ...new Set(PLACEHOLDERS.flatMap((p) => text.match(p) ?? []).map((m) => m.toLowerCase())),
];

/**
 * What a shared block holds, as a visitor would meet it: its texts, its links, its list items
 * (columns, groups, menu entries), the items with nothing in them, and the short texts a page
 * showing the block must show too (each link's text, each item's heading).
 */
function blockContent(properties: Record<string, unknown> | undefined) {
  const texts: string[] = [];
  const links: { text: string; url: string }[] = [];
  const owed: string[] = [];
  let items = 0;
  let emptyItems = 0;
  const held = () => texts.length + links.length;
  const walk = (v: unknown, name: string, inItem: boolean) => {
    if (typeof v === 'string') {
      const t = v.trim();
      // A reference or an address is not copy.
      if (!t || REFERENCE.test(t) || /^(https?:|mailto:|tel:|\/|#)/i.test(t)) return;
      texts.push(t);
      if (inItem && /^(heading|title|label|name)$/i.test(name)) owed.push(t);
    } else if (Array.isArray(v)) {
      for (const x of v) {
        if (typeof x === 'string' && REFERENCE.test(x.trim())) items++;
        walk(x, name, inItem);
      }
    } else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.html === 'string') {
        const t = visibleText(o.html);
        if (t) texts.push(t);
      } else if ('url' in o && (typeof o.url === 'string' || o.url == null) && !o.properties) {
        // A link, also one whose address was never set.
        const text = String(o.text ?? '').trim();
        links.push({ text, url: String(o.url ?? '').trim() });
        if (text) owed.push(text);
      } else if (o.properties && typeof o.properties === 'object') {
        // An item of a list of inline components: a column, a group, a link, a menu entry.
        items++;
        const before = held();
        const references = referencesIn(o.properties).length;
        for (const [k, x] of Object.entries(o.properties)) walk(x, k, true);
        if (held() === before && !references) emptyItems++;
      } else for (const [k, x] of Object.entries(o)) walk(x, k, inItem);
    }
  };
  for (const [k, x] of Object.entries(properties ?? {})) walk(x, k, false);
  return {
    texts,
    links,
    items,
    emptyItems,
    // What it points at: a logo, the navigation.
    references: referencesIn(properties ?? {}).length,
    owed: [...new Set(owed)].filter((t) => t.length > 1),
  };
}

/**
 * A page's <title> as a browser tab shows it, or '' when it has none. Next.js may stream a page's
 * metadata into its body, so the head is read first and then the rest (an icon's own <title>
 * left out).
 */
const pageTitle = (html: string) =>
  titleIn(html) || titleOf(html.replace(/<svg\b[\s\S]*?<\/svg>/gi, ' '));

/** The first element of a tag on a page, markup and all (the header, the footer). */
const regionOf = (html: string, tag: string) =>
  new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, 'i').exec(html)?.[0] ?? '';

/** A source page and the new one, or why they can't be compared yet. */
async function sourceAndCandidate(
  ctx: PlatformCheckContext,
  pg: PageRef,
): Promise<{ source: string; candidate: string } | CheckResult> {
  const { languages } = optimizelyTarget({ target: ctx.target });
  const inv = ((await ctx.document('page-inventory')) ??
    (await ctx.document('parity-inventory'))) as {
    origin?: string;
  } | null;
  const origin = inv?.origin?.replace(/\/$/, '');
  if (!origin) return pending('No source inventory gives the source site to compare with.');
  const app = await application(ctx);
  if (isResult(app)) return app;
  const host = buildHost(app);
  if (!host) return fail(['The application has no host to compare on']);
  return {
    source: `${origin}${pg.path === '/' ? '/' : pg.path}`,
    candidate: `https://${host.host}${pg.route(languages[0] ?? 'en')}`,
  };
}

/**
 * A customer portal (`playbooks/optimizely-customer-portal`). Its head keeps every page but the
 * sign-in screen behind a demo sign-in, so a check that reads a page signs in first, the way the
 * playbook's prompts fix it: `POST /api/session` with a persona's demo email answers 2xx and
 * sets the session cookie, any other email is refused, and a signed-out reader of a page is
 * redirected to `/sign-in`. A section's `audience` display setting says who it is shown to
 * (`everyone`, or one persona's audience), and the head marks each section it renders with
 * `data-audience`. Signing in changes nothing: the session is a signed cookie the check holds
 * for its own requests, and no check touches the demo data (it never posts to `/api/demo`).
 * Nothing here has met a live portal yet: these read the contract as written.
 */
const SESSION_PATH = '/api/session';
const EVERYONE = 'everyone';

interface Persona {
  key: string;
  name: string;
  email: string;
  audience: string;
}

/** The Blueprint's demo accounts, in its order: the first is the default persona. */
const personasOf = (ctx: PlatformCheckContext): Persona[] =>
  built(ctx.blueprint?.collections.personas)
    .map((p) => ({
      key: p.key,
      name: String(p.attrs?.name ?? p.name),
      email: typeof p.attrs?.email === 'string' ? p.attrs.email.trim() : '',
      audience: typeof p.attrs?.audience === 'string' ? p.attrs.audience : p.key,
    }))
    .filter((p) => p.email);

const audienceOf = (s: SectionView) => (s.settings?.audience ?? '').trim() || EVERYONE;

/** Whether a path or address is the portal's sign-in screen (with or without the locale). */
const isSignIn = (address: string) => {
  try {
    return /\/sign-in$/.test(
      new URL(address, 'https://portal.invalid').pathname.replace(/\/$/, ''),
    );
  } catch {
    return false;
  }
};

/**
 * The words a heading owes the page whoever is signed in: the head fills `{firstName}` and the
 * like from the persona, so only what stands around the tokens is looked for.
 */
const literalParts = (heading: string) =>
  heading
    .split(/\{[A-Za-z][A-Za-z0-9]*\}/)
    .map((part) => fold(part).replace(/^[\s,.:;!?]+|[\s,.:;!?]+$/g, ''))
    .filter((part) => part.length > 2);

const strings = (v: unknown) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/** A page's sections as the Blueprint places them: the component, and who it is shown to. */
const placementsOf = (page: Item) =>
  (Array.isArray(page.attrs?.components) ? (page.attrs.components as unknown[]) : []).map((c) => {
    const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
    return {
      component: typeof o.component === 'string' ? o.component : '',
      audience: typeof o.audience === 'string' && o.audience ? o.audience : EVERYONE,
      column: typeof o.column === 'string' ? o.column : '',
    };
  });

const pathOf = (page: Item) => pageRef(String(page.attrs?.path ?? '')).path;

/**
 * What is wrong with a portal Blueprint on this platform, in the Architect's words: every screen
 * placed, every component a prefixed content type with something to edit and a default display
 * template of its own, a pilot, the page type, a start page and a sign-in screen, and each
 * role's content placed for that role alone.
 */
export function portalBlueprintProblems(
  blueprint: NonNullable<PlatformCheckContext['blueprint']>,
  inventory: { pages?: { path?: string; url?: string }[] } | null,
  prefix: string,
): string[] {
  const all = (c: string) => blueprint.collections[c] ?? [];
  const kept = (c: string) => built(all(c));
  const problems: string[] = [];
  const pages = kept('pages');
  const components = kept('components');
  const templates = kept('templates');
  const personas = kept('personas');
  const audiences = new Set(
    personas.map((p) => (typeof p.attrs?.audience === 'string' ? p.attrs.audience : p.key)),
  );

  const placed = new Set(all('pages').map(pathOf));
  for (const p of inventory?.pages ?? []) {
    let path = p.path ?? '';
    if (!path && p.url)
      try {
        path = new URL(p.url).pathname;
      } catch {
        /* not an address: reported as unplaced below */
      }
    if (!placed.has(pageRef(path).path))
      problems.push(`screen ${pageRef(path).path} is neither mapped nor dropped`);
  }

  if (!templates.length)
    problems.push('no page type: a `templates` entry for the experience type every page uses');
  for (const t of templates)
    if (!typeKeyOf(t, prefix).startsWith(prefix))
      problems.push(`page type ${t.key}'s key ${typeKeyOf(t, prefix)} lacks the prefix ${prefix}`);

  if (!components.length) problems.push('no components');
  else if (!components.some((c) => c.pilot)) problems.push('no pilot components');
  const byKey = new Map(components.map((c) => [c.key, c]));
  const defaultTemplate = (c: Item) => {
    const list = Array.isArray(c.attrs?.displayTemplates)
      ? (c.attrs.displayTemplates as Record<string, unknown>[])
      : [];
    const defaults = list.filter((t) => t?.default === true);
    return defaults.length === 1 ? defaults[0]! : null;
  };
  for (const c of components) {
    const a = c.attrs ?? {};
    const key = typeKeyOf(c, prefix);
    if (!key.startsWith(prefix))
      problems.push(`${c.key}'s content type ${key} lacks the prefix ${prefix}`);
    const properties = Array.isArray(a.properties) ? a.properties : [];
    if (!properties.length && !(a.data && typeof a.data === 'object'))
      problems.push(`${c.key} has neither properties a marketer edits nor demo data to show`);
    const template = defaultTemplate(c);
    if (!template) problems.push(`${c.key} has no single default display template of its own`);
    else if (typeof template.key !== 'string' || !template.key.startsWith(prefix))
      problems.push(`${c.key}'s default display template's key lacks the prefix ${prefix}`);
    const children = a.children as { max?: unknown; contentType?: unknown } | undefined;
    if (children && typeof children.max !== 'number')
      problems.push(`${c.key}'s child items have no limit`);
    if (children && !String(children.contentType ?? '').startsWith(prefix))
      problems.push(`${c.key}'s child type lacks the prefix ${prefix}`);
  }

  const templateKeys = new Set(templates.map((t) => t.key));
  const personaKeys = new Set(personas.map((p) => p.key));
  const used = new Set<string>();
  if (!pages.some((p) => pathOf(p) === '/'))
    problems.push('no start page: a page with attrs.path "/" (the dashboard)');
  const signIn = pages.find((p) => isSignIn(pathOf(p)));
  if (!signIn)
    problems.push('no sign-in screen: a page with attrs.path "/sign-in" and attrs.bare: true');
  else if (signIn.attrs?.bare !== true)
    problems.push(`the sign-in screen (${signIn.key}) is not marked attrs.bare: true`);
  for (const p of pages) {
    if (!templateKeys.has(String(p.attrs?.template ?? '')))
      problems.push(`page ${p.key} names no page type the Blueprint has (attrs.template)`);
    for (const who of strings(p.attrs?.personas))
      if (!personaKeys.has(who)) problems.push(`page ${p.key} is opened by unknown persona ${who}`);
    const placements = placementsOf(p);
    if (!placements.length) problems.push(`page ${p.key} has no components`);
    for (const s of placements) {
      const component = byKey.get(s.component);
      if (!component) {
        problems.push(`page ${p.key} places unknown component ${s.component || '(unnamed)'}`);
        continue;
      }
      used.add(component.key);
      if (s.audience !== EVERYONE && !audiences.has(s.audience))
        problems.push(
          `page ${p.key} shows ${s.component} to ${s.audience}, which is no persona's audience`,
        );
      // What a section is set to in Visual Builder is a choice its display template offers
      // (a component without a template is named once, above).
      const template = defaultTemplate(component);
      if (!template) continue;
      const settings = (template.settings ?? {}) as Record<string, unknown>;
      for (const [setting, value] of [
        ['audience', s.audience === EVERYONE ? '' : s.audience],
        ['column', s.column],
      ] as const)
        if (value && !strings(settings[setting]).includes(value))
          problems.push(
            `page ${p.key} sets ${s.component}'s ${setting} to ${value}, which its default display template doesn't offer`,
          );
    }
  }
  for (const c of components)
    if (!used.has(c.key)) problems.push(`${c.key} is on no page: place it, or leave it out`);

  const pageByKey = new Map(pages.map((p) => [p.key, p]));
  for (const persona of personas) {
    const audience = typeof persona.attrs?.audience === 'string' ? persona.attrs.audience : '';
    for (const key of strings(persona.attrs?.navigation)) {
      const page = pageByKey.get(key);
      if (page && Array.isArray(page.attrs?.personas) && !page.attrs.personas.includes(persona.key))
        problems.push(
          `${persona.key}'s navigation shows ${key}, which they may not open (its attrs.personas)`,
        );
    }
    const variants = Array.isArray(persona.attrs?.variants) ? persona.attrs.variants : [];
    for (const v of variants as { page?: unknown; component?: unknown }[]) {
      const page = typeof v?.page === 'string' ? pageByKey.get(v.page) : undefined;
      if (!page || typeof v.component !== 'string') continue; // blueprint.personas names these
      const same = placementsOf(page).filter((s) => s.component === v.component);
      if (!same.some((s) => s.audience === audience))
        problems.push(
          `${persona.key}'s own ${v.component} on ${page.key} is not placed: add it to the page's components with audience ${audience}`,
        );
      else if (same.some((s) => s.audience === EVERYONE))
        problems.push(
          `${page.key} also shows a ${v.component} to everyone, so ${persona.key} would see both: set it to the roles it is for`,
        );
    }
  }
  return problems;
}

export function optimizelyChecks(cfg: OptimizelyVerifyConfig): Record<string, PlatformCheck> {
  // The portal's checks: sign in as a demo persona, then read pages as that persona.

  /** A request the portal head answers, or null when it doesn't. */
  const call = async (url: string, init: RequestInit = {}) => {
    try {
      return await cfg.fetch(url, {
        ...init,
        headers: { 'user-agent': 'Launchworks checks', ...(init.headers as object | undefined) },
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch {
      return null;
    }
  };

  /** Signs in with an email as the sign-in screen does: the session cookie, when one is given. */
  const signIn = async (origin: string, email: string) => {
    const res = await call(`${origin}${SESSION_PATH}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'launchworks-check' }),
    });
    if (!res) return { status: 0, cookie: null };
    const one = res.headers.get('set-cookie');
    const set = res.headers.getSetCookie?.() ?? (one ? [one] : []);
    const cookie = set
      .map((c) => c.split(';')[0]!.trim())
      // A cleared cookie (name=) is a sign-out, not a session.
      .filter((c) => /^[^=]+=.+/.test(c))
      .join('; ');
    return { status: res.status, cookie: res.ok && cookie ? cookie : null };
  };

  /** A page as a signed-in persona gets it (or a signed-out reader, without a cookie). */
  const open = async (url: string, cookie: string | null) => {
    const res = await call(url, { redirect: 'follow', headers: cookie ? { cookie } : {} });
    if (!res) return { status: 0, url, html: '' };
    return { status: res.status, url: res.url || url, html: await res.text() };
  };

  /** One sign-in per persona for a whole check. */
  const sessions = (origin: string) => {
    const known = new Map<string, Promise<{ status: number; cookie: string | null }>>();
    return (persona: Persona) => {
      if (!known.has(persona.key)) known.set(persona.key, signIn(origin, persona.email));
      return known.get(persona.key)!;
    };
  };

  /**
   * The sign-in as a whole: a signed-out reader is sent to the sign-in screen, an email that is
   * no demo account's is refused, every persona signs in, and a session is let past the gate.
   */
  const signInProblems = async (origin: string, personas: Persona[]): Promise<string[]> => {
    const problems: string[] = [];
    const out = await call(`${origin}/`, { redirect: 'manual' });
    const location = out?.headers.get('location') ?? '';
    if (!out || out.status < 300 || out.status >= 400 || !isSignIn(location))
      problems.push(
        `A signed-out reader of ${origin}/ is not sent to the sign-in screen (it answered ${out?.status || 'nothing'}${location ? `, to ${location}` : ''})`,
      );
    const stranger = await signIn(origin, 'nobody@launchworks.invalid');
    if (stranger.cookie)
      problems.push(
        'The sign-in accepts an email that is no demo account: only the personas may sign in',
      );
    const session = sessions(origin);
    for (const persona of personas.slice(0, 10)) {
      const s = await session(persona);
      if (!s.cookie)
        problems.push(
          `${persona.name} (${persona.email}) can't sign in: ${SESSION_PATH} answered ${s.status || 'nothing'}${s.status >= 200 && s.status < 300 ? ' without a session cookie' : ''}`,
        );
    }
    const first = personas[0] ? await session(personas[0]) : null;
    if (first?.cookie) {
      const home = await call(`${origin}/`, {
        redirect: 'manual',
        headers: { cookie: first.cookie },
      });
      const to = home?.headers.get('location') ?? '';
      if (!home || home.status >= 500 || (home.status >= 300 && home.status < 400 && isSignIn(to)))
        problems.push(
          `Signed in as ${personas[0]!.name}, ${origin}/ ${home && home.status < 500 ? 'still sends them to the sign-in screen' : `answered ${home?.status || 'nothing'}`}`,
        );
    }
    return problems;
  };

  /** A Blueprint page with who reads it for a check: the first persona who may open it. */
  const portalPages = (ctx: PlatformCheckContext, personas: Persona[], cap = 20) => {
    const all = routedPages(ctx);
    const own =
      ctx.scope.collection === 'pages' && ctx.scope.items.length
        ? all.filter((p) => ctx.scope.items.includes(p.key))
        : all;
    return own.slice(0, cap).map((item) => {
      const allowed = Array.isArray(item.attrs?.personas) ? strings(item.attrs.personas) : null;
      const readers = allowed ? personas.filter((p) => allowed.includes(p.key)) : personas;
      // The sign-in screen, and any page nobody is named for, is read signed out.
      return { ref: pageRef(String(item.attrs!.path)), readers, reader: readers[0] ?? null };
    });
  };

  /** One page as one persona: it answers, isn't the sign-in screen, and shows their sections. */
  const renderProblems = async (
    ctx: PlatformCheckContext,
    a: {
      origin: string;
      application: string;
      ref: PageRef;
      reader: Persona | null;
      cookie: string | null;
      wantSections?: boolean;
    },
  ): Promise<{ problems: string[]; pending?: string; sections: SectionView[] }> => {
    const { languages } = optimizelyTarget({ target: ctx.target });
    const content = await pageContent(ctx, a.ref.cms(a.application), a.ref.label);
    if (isResult(content))
      return content.status === 'pending'
        ? { problems: [], pending: content.detail, sections: [] }
        : { problems: [content.detail], sections: [] };
    const url = `${a.origin}${a.ref.route(languages[0] ?? 'en')}`;
    const who = a.reader ? `as ${a.reader.name}` : 'signed out';
    const p = await open(url, a.cookie);
    if (p.status !== 200)
      return {
        problems: [`${url} answered ${p.status || 'nothing'} ${who}`],
        sections: content.sections,
      };
    if (isSignIn(p.url) && !isSignIn(a.ref.path))
      return {
        problems: [`${url} shows the sign-in screen ${who}`],
        sections: content.sections,
      };
    if (a.wantSections && !content.sections.length)
      return { problems: [`${a.ref.label} has no sections yet`], sections: [] };
    const text = fold(visibleText(p.html));
    const theirs = content.sections.filter(
      (s) => audienceOf(s) === EVERYONE || audienceOf(s) === a.reader?.audience,
    );
    const missing = theirs.flatMap((s) =>
      headingsOf(s.properties)
        .filter((h) => !literalParts(h).every((part) => text.includes(part)))
        .map((h) => `"${h}" (${s.name ?? s.contentType}) is not on ${a.ref.path} ${who}`),
    );
    return { problems: missing.slice(0, 8), sections: content.sections };
  };

  /** Every page the task covers, each read by a persona who may open it. */
  const pagesRender = async (
    ctx: PlatformCheckContext,
    which: (a: ApplicationView) => HostView | null,
  ): Promise<{ problems: string[]; pending: string[]; read: string[] } | CheckResult> => {
    if (!ctx.blueprint) return pending('There is no approved Blueprint to check against.');
    const personas = personasOf(ctx);
    if (!personas.length) return pending('The Blueprint lists no persona with a demo email.');
    const app = await application(ctx);
    if (isResult(app)) return app;
    const host = which(app);
    if (!host) return fail(['The application has no host to read the portal on']);
    const origin = `https://${host.host}`;
    const session = sessions(origin);
    const problems: string[] = [];
    const waiting: string[] = [];
    const read: string[] = [];
    for (const pg of portalPages(ctx, personas)) {
      const s = pg.reader ? await session(pg.reader) : null;
      if (pg.reader && !s?.cookie) {
        problems.push(
          `${pg.ref.path}: ${pg.reader.name} can't sign in (${SESSION_PATH} answered ${s?.status || 'nothing'})`,
        );
        continue;
      }
      const r = await renderProblems(ctx, {
        origin,
        application: app.key,
        ref: pg.ref,
        reader: pg.reader,
        cookie: s?.cookie ?? null,
      });
      if (r.pending) waiting.push(`${pg.ref.path}: ${r.pending}`);
      problems.push(...r.problems);
      read.push(`${pg.ref.path} ${pg.reader ? `as ${pg.reader.name}` : 'signed out'}`);
    }
    return { problems, pending: waiting, read };
  };

  /** Every Blueprint component and page type has its content type in the CMS, with the right base. */
  const typesInCms = async (
    ctx: PlatformCheckContext,
    collections: string[],
  ): Promise<CheckResult> => {
    const { typePrefix } = optimizelyTarget({ target: ctx.target });
    if (!ctx.blueprint) return pending('There is no approved Blueprint to check against.');
    const types = await contentTypes(ctx);
    if (isResult(types)) return types;
    const have = new Map(types.map((t) => [t.key.toLowerCase(), t]));
    const problems: string[] = [];
    let checked = 0;
    for (const collection of collections) {
      for (const item of covered(ctx, collection) ?? []) {
        checked++;
        const key = typeKeyOf(item, typePrefix);
        const type = have.get(key.toLowerCase());
        if (!type) problems.push(`${item.name}: content type ${key} is not in the CMS`);
        else if (
          collection === 'templates' &&
          !['_experience', '_page'].includes(type.baseType ?? '')
        )
          problems.push(
            `${item.name}: ${key} is a ${type.baseType} type, not a page or experience`,
          );
        else if (collection === 'components' && type.baseType !== '_component')
          problems.push(`${item.name}: ${key} is a ${type.baseType} type, not a component`);
      }
    }
    if (!checked) return pending('The Blueprint lists nothing to check here.');
    return problems.length
      ? fail(problems)
      : pass(
          `${checked} Blueprint ${checked === 1 ? 'item has its' : 'items have their'} content type in the CMS, with the prefix ${typePrefix}.`,
        );
  };

  /** A page is composed from the project's own sections, each on a display template. */
  const composed = async (ctx: PlatformCheckContext, pg: PageRef): Promise<CheckResult> => {
    const { typePrefix } = optimizelyTarget({ target: ctx.target });
    const app = await application(ctx);
    if (isResult(app)) return app;
    const start = await pageContent(ctx, pg.cms(app.key), pg.label);
    if (isResult(start)) return start;
    if (!start.sections.length) return fail([`${pg.label} has no sections`]);
    const problems = start.sections.flatMap((s) => [
      ...(s.contentType?.startsWith(typePrefix)
        ? []
        : [`"${s.name}" is ${s.contentType ?? 'an unknown type'}, not one of the project's`]),
      ...(s.contentType && !s.displayTemplate
        ? [`"${s.name}" has no display template chosen`]
        : []),
    ]);
    return problems.length
      ? fail(problems, { sections: start.sections.length })
      : pass(
          `${pg.label} has ${start.sections.length} sections, all the project's own types on display templates.`,
          {
            sections: start.sections.map((s) => ({ name: s.name, contentType: s.contentType })),
          },
        );
  };

  /** A page renders on the head and shows what its sections hold. */
  const renders = async (ctx: PlatformCheckContext, pg: PageRef): Promise<CheckResult> => {
    const { languages } = optimizelyTarget({ target: ctx.target });
    const app = await application(ctx);
    if (isResult(app)) return app;
    const host = buildHost(app);
    if (!host) return fail(['The application has no host']);
    const start = await pageContent(ctx, pg.cms(app.key), pg.label);
    if (isResult(start)) return start;
    const url = `https://${host.host}${pg.route(languages[0] ?? 'en')}`;
    const p = await page(cfg, url);
    if (p.status !== 200) return fail([`${url} answered ${p.status || 'nothing'}`]);
    const text = fold(visibleText(p.html));
    const owed = start.sections.flatMap((s) =>
      headingsOf(s.properties).map((h) => ({ section: s.name, heading: h })),
    );
    const missing = owed.filter((o) => !text.includes(fold(o.heading)));
    if (!owed.length) return pass(`${url} renders (its sections have no headings to look for).`);
    return missing.length
      ? fail(
          missing.slice(0, 12).map((m) => `"${m.heading}" (${m.section}) is not on the page`),
          { owed: owed.length, missing: missing.length },
        )
      : pass(
          `${url} renders all ${owed.length} headings of its ${start.sections.length} sections.`,
          { owed: owed.length },
        );
  };

  return {
    // The application exists with a start page, assets of its own and live preview configured.
    'structural.application': async (ctx) => {
      const app = await application(ctx);
      if (isResult(app)) return app;
      const problems = [
        app.startPage?.key ? null : 'it has no start page',
        app.assetsRoot
          ? null
          : 'it has no assets of its own, so shared blocks and media have nowhere to live',
        app.previewTokens ? null : 'preview tokens are off',
        app.previewUrl && /\{key\}/.test(app.previewUrl)
          ? null
          : 'its preview URL format is not set',
      ].filter((x): x is string => Boolean(x));
      return problems.length
        ? fail(problems.map((p) => `Application ${app.key}: ${p}`))
        : pass(
            `Application ${app.key} has a start page, its own assets and live preview on ${app.previewUrl}.`,
          );
    },

    'structural.content-types': (ctx) => typesInCms(ctx, ['components']),
    'structural.templates': (ctx) => typesInCms(ctx, ['templates']),
    // Everything the Blueprint builds is in the CMS: what a push from the repository made.
    'types.pushed': (ctx) => typesInCms(ctx, ['components', 'templates']),

    // Editors can use each component in Visual Builder: it can be added as a section or an
    // element, and it has a default display template of its own (not another team's base one).
    'editor.element-enabled': async (ctx) => {
      const { typePrefix } = optimizelyTarget({ target: ctx.target });
      const items = covered(ctx, 'components');
      if (!items) return pending('There is no approved Blueprint to check against.');
      const types = await contentTypes(ctx);
      if (isResult(types)) return types;
      const templates = await displayTemplates(ctx);
      if (isResult(templates)) return templates;
      const have = new Map(types.map((t) => [t.key.toLowerCase(), t]));
      const problems: string[] = [];
      let checked = 0;
      for (const item of items) {
        // Shared chrome and items inside other components aren't dragged onto a page.
        if (item.attrs?.shared === true || item.attrs?.inline === true) continue;
        const key = typeKeyOf(item, typePrefix);
        const type = have.get(key.toLowerCase());
        if (!type) {
          problems.push(`${item.name}: content type ${key} is not in the CMS`);
          continue;
        }
        const behaviours = type.compositionBehaviors ?? [];
        // A type with no behaviour is shared chrome or an inline item by construction.
        if (!behaviours.length) continue;
        checked++;
        if (!templates.some((t) => t.contentType === type.key && t.isDefault))
          problems.push(`${item.name}: ${type.key} has no default display template of its own`);
      }
      if (problems.length) return fail(problems);
      return checked
        ? pass(
            `${checked} ${checked === 1 ? 'component' : 'components'} can be added in Visual Builder, each with its own default display template.`,
          )
        : fail([
            'No Blueprint component is section-enabled or element-enabled: editors have nothing to add to a page',
          ]);
    },

    // Editors can start a new page from a blueprint of one of the project's experience types.
    'editor.new-experience': async (ctx) => {
      const r = await ctx.read('optimizely-cms', 'blueprint.list', {});
      if (r.code !== 200) return pending(`Blueprints could not be read: ${reason(r)}`);
      const own = (
        (r.body as { blueprints?: { name?: string; contentType?: string; own?: boolean }[] })
          .blueprints ?? []
      ).filter((b) => b.own);
      return own.length
        ? pass(
            `Editors can start from ${own.map((b) => `"${b.name}" (${b.contentType})`).join(', ')}.`,
          )
        : fail(["There is no blueprint for any of the project's experience types"]);
    },

    'structural.experiences': eachPage(composed),
    // The pilot composes the start page only: the pages are migrated later, so its checks look
    // at that one page, whatever the Blueprint keeps.
    'pilot.composed': (ctx) => composed(ctx, pageRef('/')),

    // The application answers on the head's host, over https.
    'hostname.registered': async (ctx) => {
      const app = await application(ctx);
      if (isResult(app)) return app;
      const host = primaryHost(app);
      if (!host)
        return fail([
          `Application ${app.key} has no host: Graph can't route its pages and Visual Builder has nowhere to open the preview`,
        ]);
      const problems = [
        host.type === 'primary' ? null : `${host.host} is not marked primary`,
        host.scheme === 'https' ? null : `${host.host} does not prefer https`,
      ].filter((x): x is string => Boolean(x));
      const preview = (app.hosts ?? []).find((h) => h.type === 'preview');
      return problems.length
        ? fail(problems)
        : pass(
            `${host.host} is the application's primary host${preview ? `, and ${preview.host} its preview host, where Visual Builder opens pages` : ' (Visual Builder opens pages there too: it has no preview host)'}.`,
          );
    },

    // The start page is published and Optimizely Graph serves it on the application's host.
    'graph.published': async (ctx) => {
      const { languages } = optimizelyTarget({ target: ctx.target });
      const r = await ctx.read('optimizely-graph', 'graph.routes', {});
      if (r.code !== 200) return pending(`Optimizely Graph could not be read: ${reason(r)}`);
      const routes = (r.body as { routes?: RouteView[] }).routes ?? [];
      if (!routes.length)
        return fail([
          'Optimizely Graph serves no page of this application: publish the start page, and register the host',
        ]);
      const home = `/${languages[0] ?? 'en'}/`;
      const start = routes.find((x) => x.route === home);
      if (!start)
        return fail([
          `The start page (${home}) is not in Graph; ${routes.length} other ${routes.length === 1 ? 'page is' : 'pages are'}`,
        ]);
      return pass(
        `Optimizely Graph serves ${routes.length} published ${routes.length === 1 ? 'page' : 'pages'} of the application, the start page among them.`,
        {
          routes: routes.map((x) => x.route),
        },
      );
    },

    // Every route Graph serves answers on the head.
    'routes.resolve': async (ctx) => {
      const r = await ctx.read('optimizely-graph', 'graph.routes', {});
      if (r.code !== 200) return pending(`Optimizely Graph could not be read: ${reason(r)}`);
      const routes = ((r.body as { routes?: RouteView[] }).routes ?? []).filter(
        (x) => x.route && x.host,
      );
      if (!routes.length) return fail(['Optimizely Graph serves no page of this application yet']);
      const results = await Promise.all(
        routes
          .slice(0, 50)
          .map(async (x) => ({ route: x.route!, ...(await page(cfg, `${x.host}${x.route}`)) })),
      );
      const broken = results.filter((x) => x.status !== 200);
      return broken.length
        ? fail(
            broken.map((x) => `${x.route} answered ${x.status || 'nothing'}`),
            { checked: results.length },
          )
        : pass(
            `${results.length} ${results.length === 1 ? 'route answers' : 'routes answer'} 200 on the head.`,
            { checked: results.length },
          );
    },

    // The head has the preview route Visual Builder opens, and it is not behind a login.
    'head.preview-route': async (ctx) => {
      const app = await application(ctx);
      if (isResult(app)) return app;
      const host = buildHost(app);
      if (!host) return fail(['The application has no host to open the preview on']);
      const route = /^\{host\}(\/[^?]*)/.exec(app.previewUrl ?? '')?.[1] ?? '/preview';
      const bare = await page(cfg, `https://${host.host}${route}`);
      if (behindLogin(bare))
        return fail([
          `${host.host}${route} is behind a login: Visual Builder loads it in a frame, so Vercel Authentication must be off for the project`,
        ]);
      if (bare.status !== 200)
        return fail([
          `${host.host}${route} answered ${bare.status || `nothing (${bare.error ?? 'no response'})`}`,
        ]);
      // The route exists. Now as Visual Builder opens it: the start page's latest version in the
      // editing frame, with a preview token. An editor can select and edit only what the page
      // marks, and saves reach the frame only through the CMS's own script.
      const links = await ctx.read('optimizely-cms', 'content.previews', {
        path: `/content/${app.key}`,
      });
      if (links.code !== 200)
        return pending(
          `${host.host}${route} answers and is not behind a login; the editing frame could not be opened to look inside (${reason(links)}).`,
        );
      const framed = await page(cfg, (links.body as { edit: string }).edit);
      if (framed.status !== 200)
        return fail([
          `${host.host}${route} answered ${framed.status || 'nothing'} when opened with a preview token, as Visual Builder opens it`,
        ]);
      const count = (pattern: RegExp) => (framed.html.match(pattern) ?? []).length;
      const fields = count(/data-epi-edit=/g);
      const blocks = count(/data-epi-block-id=/g);
      // What must be marked depends on what the page holds. An application is created on an
      // empty start page, and the shared header and footer arrive before its sections: a page
      // with no sections has none to select, and that is not a fault of the preview route.
      const start = await pageContent(ctx, `/content/${app.key}`, 'The start page');
      if (isResult(start)) return start;
      const sections = start.sections.length;
      const problems = [
        /communicationinjector\.js/.test(framed.html)
          ? null
          : "the preview does not load the CMS's communicationinjector.js, so edits never refresh it",
        fields || !sections
          ? null
          : 'nothing on the page is marked editable (no data-epi-edit): properties need pa(...)',
        blocks || !sections
          ? null
          : 'no section can be selected (no data-epi-block-id): the composition wrapper needs pa(node)',
      ].filter((x): x is string => Boolean(x));
      if (problems.length) return fail(problems, { fields, blocks, sections });
      return sections
        ? pass(
            `${host.host}${route} opens the start page in the editing frame: ${fields} editable fields, ${blocks} selectable sections and blocks.`,
            { fields, blocks, sections },
          )
        : pass(
            `${host.host}${route} opens the start page in the editing frame and loads the CMS's script. The page has no sections yet, so there is none to select (${fields} editable fields so far); this is checked again once it has.`,
            { fields, blocks, sections },
          );
    },

    'head.pages-render': eachPage(renders),
    'pilot.renders': (ctx) => renders(ctx, pageRef('/')),

    // A page reads like the source's: every heading a visitor sees there is here too.
    'parity.render': eachPage(async (ctx, pg) => {
      const pair = await sourceAndCandidate(ctx, pg);
      if ('status' in pair) return pair;
      const [source, candidate] = await Promise.all([
        page(cfg, pair.source),
        page(cfg, pair.candidate),
      ]);
      if (candidate.status !== 200)
        return fail([`${pair.candidate} answered ${candidate.status || 'nothing'}`]);
      if (source.status !== 200 || isChallengePage(source.html))
        return pending(
          `The source page ${pair.source} could not be read (${source.status || 'no answer'}${source.status === 200 ? ', a bot check' : ''}); compare it at the demo review.`,
        );
      if (redirectedAway(pair.source, source.url))
        return pending(
          `The source page moved to ${source.url}; compare with that page at the demo review.`,
        );
      const owed = [...new Set(headingsIn(source.html))].filter((h) => h.length > 2);
      if (!owed.length)
        return pending(`The source page ${pair.source} shows no headings to compare.`);
      const text = readableText(candidate.html);
      const missing = owed.filter((h) => !showsHeading(text, h));
      // A source builds part of its page in the browser, and its header carries menus the demo
      // doesn't: most headings present is the bar, the missing ones are listed either way.
      const share = (owed.length - missing.length) / owed.length;
      const data = { headings: owed.length, missing };
      return share >= 0.9
        ? pass(
            `${owed.length - missing.length} of the source's ${owed.length} headings are on the new page${missing.length ? ` (not: ${missing.slice(0, 5).join('; ')})` : ''}.`,
            data,
          )
        : fail(
            missing.slice(0, 15).map((h) => `"${h}" is on the source page and not on the new one`),
            data,
          );
    }),

    // A page looks like the source's, section by section, as a model sees both.
    'parity.visual': eachPage(async (ctx, pg) => {
      const pair = await sourceAndCandidate(ctx, pg);
      if ('status' in pair) return pair;
      if (!ctx.compareScreens) return pending('No model is connected to compare screenshots.');
      const r = await ctx.compareScreens({
        path: pg.path,
        source: pair.source,
        candidate: pair.candidate,
      });
      if ('error' in r) return pending(`The pages could not be compared: ${r.error}`);
      return r.verdict === 'match'
        ? pass(
            `${pg.label} matches the source${r.minor?.length ? ` (minor: ${r.minor.slice(0, 5).join('; ')})` : ''}.`,
            r,
          )
        : fail(r.differences.slice(0, 18), r);
    }),

    // The pages say what the source's say: nine in ten of a source page's own words are on the
    // new page, for 98% of the pages. Counted the same way on both sides, as a visitor reads them.
    'parity.page': async (ctx) => {
      const pages = pagesOf(ctx, 50);
      const measured: { path: string; have: number; want: number }[] = [];
      const unread: string[] = [];
      const problems: string[] = [];
      for (const pg of pages) {
        const pair = await sourceAndCandidate(ctx, pg);
        if ('status' in pair) return pair;
        const [source, candidate] = await Promise.all([
          page(cfg, pair.source),
          page(cfg, pair.candidate),
        ]);
        if (source.status !== 200 || isChallengePage(source.html)) {
          unread.push(pg.path);
          continue;
        }
        if (redirectedAway(pair.source, source.url)) continue;
        if (candidate.status !== 200) {
          problems.push(`${pg.path} answered ${candidate.status || 'nothing'} on the new site`);
          measured.push({ path: pg.path, have: 0, want: 1 });
          continue;
        }
        const want = wordsOf(readableText(source.html));
        const got = wordsOf(readableText(candidate.html));
        const have = [...want].filter((w) => got.has(w)).length;
        measured.push({ path: pg.path, have, want: want.size });
        if (want.size && have < want.size * 0.9) {
          const missing = [...want].filter((w) => !got.has(w)).slice(0, 8);
          problems.push(
            `${pg.path} has ${Math.round((have / want.size) * 100)}% of the source page's words (missing, for example: ${missing.join(', ')})`,
          );
        }
      }
      if (!measured.length)
        return pending(
          unread.length
            ? `No source page could be read (${unread.slice(0, 5).join(', ')}): compare them at the review.`
            : 'No page to compare.',
        );
      const enough = measured.filter((m) => !m.want || m.have >= m.want * 0.9).length;
      const parity = Math.round((enough / measured.length) * 100);
      const note = unread.length ? `; ${unread.length} source pages could not be read` : '';
      return parity >= 98
        ? pass(`Content parity ${parity}% across ${measured.length} pages${note}.`, {
            parity,
            measured,
          })
        : fail([`Content parity ${parity}% (98% needed)`, ...problems.slice(0, 15)], {
            parity,
            measured,
          });
    },

    // Every image the team uploaded says what it shows.
    'media.alt-text': async (ctx) => {
      const { cmsUrl } = optimizelyTarget({ target: ctx.target });
      const app = await application(ctx);
      if (isResult(app)) return app;
      if (!app.assetsRoot) return pending('The application has no assets of its own to look in.');
      // An application's own media is served under its assets root.
      const prefix = `${cmsUrl.replace(/\/$/, '')}/siteassets/${app.assetsRoot}/`;
      const r = await ctx.read('optimizely-graph', 'graph.query', {
        query:
          'query Media($prefix: String) { _Image(limit: 100, where: { _metadata: { url: { default: { startsWith: $prefix } } } }) { total items { _metadata { displayName } ... on ImageMedia { AltText } } } }',
        variables: { prefix },
      });
      if (r.code !== 200) return pending(`The application's media could not be read: ${reason(r)}`);
      const images = (
        r.body as {
          data?: {
            _Image?: {
              total?: number;
              items?: { AltText?: string | null; _metadata?: { displayName?: string } }[];
            };
          };
        }
      ).data?._Image;
      const items = images?.items ?? [];
      if (!items.length) return pending("No published image in the application's media yet.");
      const total = images?.total ?? items.length;
      const bare = items
        .filter((i) => !(i.AltText ?? '').trim())
        .map((i) => i._metadata?.displayName ?? '?');
      // A task that uploads one file answers for that file: another task's image, uploaded a
      // moment ago and not yet described, is that task's to put right, and failing every upload
      // for it stopped them all.
      const own =
        ctx.scope.collection === 'media' && ctx.scope.items.length
          ? (ctx.blueprint?.collections.media ?? []).filter((m) => ctx.scope.items.includes(m.key))
          : null;
      if (own) {
        const mine = bare.filter((name) => own.some((m) => namedFor(name, m)));
        return mine.length
          ? fail(
              mine.map(
                (name) =>
                  `${name} has no alt text: call media.upload again with its path and \`alt\``,
              ),
              { images: total, without: mine.length },
            )
          : pass(
              `No image of ${own.map((m) => m.key).join(', ') || 'this task'} lacks alt text (${total} images in the application's media${bare.length ? `, ${bare.length} of other tasks still without` : ''}).`,
              { images: total },
            );
      }
      const without = bare;
      return without.length
        ? fail(
            without.slice(0, 20).map((name) => `${name} has no alt text`),
            { images: total, without: without.length },
          )
        : pass(`${total} images, each with alt text.`, { images: total });
    },

    // A page that moved still answers at its old address, with a permanent redirect to the new one.
    'experience.redirects-resolve': async (ctx) => {
      const { languages } = optimizelyTarget({ target: ctx.target });
      if (!ctx.blueprint) return pending('There is no approved Blueprint to check against.');
      // A page that moved to a new route, and a page the Blueprint keeps as a parent while its
      // visitors go elsewhere (attrs.redirect, as the source did): the head redirects both.
      const external = (to: string) => /^https?:\/\//i.test(to);
      const moved = pathedPages(ctx)
        .map((p) => ({ from: String(p.attrs!.path), to: redirectOf(p) ?? p.attrs?.route }))
        .filter(
          (m): m is { from: string; to: string } =>
            typeof m.to === 'string' &&
            (external(m.to) ||
              (m.to.startsWith('/') && pageRef(m.to).path !== pageRef(m.from).path)),
        );
      if (!moved.length)
        return pass(
          'No page moved: every page keeps its source path, so there is nothing to redirect.',
        );
      const app = await application(ctx);
      if (isResult(app)) return app;
      const host = buildHost(app);
      if (!host) return fail(['The application has no host']);
      const problems: string[] = [];
      for (const m of moved.slice(0, 50)) {
        let status = 0;
        let location = '';
        try {
          const res = await cfg.fetch(`https://${host.host}${m.from}`, {
            redirect: 'manual',
            signal: AbortSignal.timeout(cfg.timeoutMs),
          });
          status = res.status;
          location = res.headers.get('location') ?? '';
        } catch {
          /* reported as no answer */
        }
        const landedAt = location ? new URL(location, `https://${host.host}`) : null;
        const landed = landedAt ? landedAt.pathname.replace(/\/$/, '') : '';
        const target = external(m.to) ? null : pageRef(m.to);
        const wanted = target
          ? [target.path, target.route(languages[0] ?? 'en').replace(/\/$/, '')].map((x) =>
              x.replace(/\/$/, ''),
            )
          : [];
        const arrived = target
          ? wanted.includes(landed)
          : landedAt?.href.replace(/\/$/, '') === m.to.replace(/\/$/, '');
        if (status !== 301 && status !== 308)
          problems.push(
            `${m.from} answered ${status || 'nothing'}, not a permanent redirect to ${m.to}`,
          );
        else if (!arrived) problems.push(`${m.from} redirects to ${location}, not ${m.to}`);
      }
      return problems.length
        ? fail(problems.slice(0, 20), { moved: moved.length })
        : pass(
            `${moved.length} moved ${moved.length === 1 ? 'page redirects' : 'pages redirect'} permanently to ${moved.length === 1 ? 'its' : 'their'} new address.`,
            { moved: moved.length },
          );
    },

    // The shared header, footer and navigation have their content: every page shows them, so the
    // task that fills them, once, before the pages, passes only when each block holds its links
    // and items (footer columns, menu groups and entries) with nothing empty and no placeholder
    // copy, and the start page renders what they hold.
    'parity.chrome': async (ctx) => {
      const { typePrefix, languages } = optimizelyTarget({ target: ctx.target });
      if (!ctx.blueprint) return pending('There is no approved Blueprint to check against.');
      const kept = built(ctx.blueprint.collections.components).filter(
        (c) => c.attrs?.inline !== true,
      );
      const marked = kept.filter((c) => c.attrs?.shared === true);
      const shared = marked.length
        ? marked
        : kept.filter((c) => /header|footer|nav|menu/i.test(`${c.key} ${c.name}`));
      if (!shared.length) return pending('The Blueprint marks no component as shared.');
      const app = await application(ctx);
      if (isResult(app)) return app;
      const host = buildHost(app);
      if (!host) return fail(['The application has no host']);
      const start = await pageContent(ctx, `/content/${app.key}`, 'The start page');
      if (isResult(start)) return start;

      // The blocks the start page shows: the ones it points at (its header and footer), and the
      // ones those point at (the navigation). One nothing points at is looked for by its name.
      type Block = { contentType?: string; properties?: Record<string, unknown> };
      const byType = new Map(shared.map((c) => [typeKeyOf(c, typePrefix).toLowerCase(), c]));
      const found = new Map<string, Block>();
      const seen = new Set<string>();
      const queue = referencesIn(start.properties);
      for (let reads = 0; queue.length && found.size < shared.length && reads < 24;) {
        const key = queue.shift()!;
        if (seen.has(key)) continue;
        seen.add(key);
        reads++;
        const r = await ctx.read('optimizely-cms', 'content.read', { key });
        if (r.code === 404) continue;
        if (r.code !== 200)
          return pending(`An item the start page points at could not be read: ${reason(r)}`);
        const block = r.body as Block;
        const component = byType.get(String(block.contentType ?? '').toLowerCase());
        // An image or another page: not a shared block, and not followed.
        if (!component) continue;
        found.set(component.key, block);
        queue.push(...referencesIn(block.properties));
      }
      const problems: string[] = [];
      const unreferenced: string[] = [];
      for (const c of shared) {
        if (found.has(c.key)) continue;
        const path = `/shared/${app.key}/${c.name}`;
        const r = await ctx.read('optimizely-cms', 'content.read', { path });
        if (r.code === 200) {
          found.set(c.key, r.body as Block);
          unreferenced.push(c.name);
        } else if (r.code === 404)
          problems.push(
            `${c.name} has no shared block: neither the start page nor a block it shows points at one of type ${typeKeyOf(c, typePrefix)}, and there is none at ${path}. Create it under /shared/${app.key}/, fill it from the source, point the start page (or the header) at it and publish`,
          );
        else return pending(`${c.name}'s shared block could not be read: ${reason(r)}`);
      }

      const held = shared.flatMap((c) => {
        const block = found.get(c.key);
        return block ? [{ component: c, ...blockContent(block.properties) }] : [];
      });
      for (const b of held) {
        const name = b.component.name;
        if (b.component.attrs?.children && !b.items && !b.links.length)
          problems.push(
            `${name} has no items: create each column, group and link (or menu entry) in it, from the source site's ${name.toLowerCase()}`,
          );
        else if (!b.texts.length && !b.links.length && !b.items && !b.references)
          problems.push(`${name} has no content: fill its shared block from the source`);
        if (b.emptyItems)
          problems.push(
            `${name} has ${b.emptyItems} empty ${b.emptyItems === 1 ? 'item' : 'items'}: fill each from the source, or remove it`,
          );
        const nowhere = b.links.filter((l) => l.text && (!l.url || l.url === '#'));
        if (nowhere.length)
          problems.push(
            `${name} has ${nowhere.length === 1 ? 'a link that goes' : 'links that go'} nowhere: ${few(nowhere.map((l) => `"${l.text}"`))}`,
          );
        const placeholders = placeholdersIn(
          [...b.texts, ...b.links.map((l) => l.text)].join(' | '),
        );
        if (placeholders.length)
          problems.push(`${name} holds placeholder copy: "${placeholders.join('", "')}"`);
      }

      // And the start page renders them.
      const url = `https://${host.host}/${languages[0] ?? 'en'}/`;
      const p = await page(cfg, url);
      if (p.status !== 200)
        return fail([
          `The start page answered ${p.status || 'nothing'} on ${host.host}`,
          ...problems,
        ]);
      // On the page: in what a visitor reads, or in a label (a link shown as an icon alone).
      const text = fold(visibleText(p.html));
      const markup = fold(
        p.html.replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, ' ').replace(/&amp;/g, '&'),
      );
      const shown = (t: string) => text.includes(fold(t)) || markup.includes(fold(t));
      for (const tag of ['header', 'footer']) {
        const region = regionOf(p.html, tag);
        if (!region) problems.push(`the start page has no ${tag}`);
        const placeholders = placeholdersIn(visibleText(region));
        if (placeholders.length)
          problems.push(
            `the start page's ${tag} shows placeholder copy: "${placeholders.join('", "')}"`,
          );
      }
      for (const b of held) {
        const missing = b.owed.filter((t) => !shown(t));
        // Nine in ten is the bar, as for a page's headings: a component may leave one out on
        // purpose (a link it shows only when signed in).
        if (missing.length > b.owed.length * 0.1)
          problems.push(
            `${b.component.name} holds ${b.owed.length} links and headings, and ${missing.length} are not on the start page (${few(missing.map((t) => `"${t}"`))}): ${
              unreferenced.includes(b.component.name)
                ? 'nothing the start page shows points at the block, so point the start page (or the header) at it and publish'
                : 'publish the block and the start page, and check its component renders every item'
            }`,
          );
      }
      const data = {
        blocks: held.map((b) => ({
          component: b.component.key,
          links: b.links.length,
          items: b.items,
          owed: b.owed.length,
        })),
      };
      return problems.length
        ? fail(problems, data)
        : pass(
            `The shared ${held.map((b) => b.component.name).join(', ')} hold their content (${held.reduce((n, b) => n + b.links.length, 0)} links, ${held.reduce((n, b) => n + b.items, 0)} items, no placeholders) and the start page of ${host.host} renders it.`,
            data,
          );
    },

    // Page titles: each page's <title> on the new site is the source page's <title>. Sites often
    // give a page an SEO title its heading doesn't carry; the SEO step sets it on the page, and
    // the head puts it in the <title>. Content parity leaves titles to this check.
    'seo.titles': (ctx) => {
      const { languages } = optimizelyTarget({ target: ctx.target });
      // What every page of the task shares: where the source is, and where the build is looked at.
      let both:
        Promise<{ origin: string; app: ApplicationView; host: string } | CheckResult> | undefined;
      const sites = () =>
        (both ??= (async () => {
          const inv = ((await ctx.document('page-inventory')) ??
            (await ctx.document('parity-inventory'))) as { origin?: string } | null;
          const origin = inv?.origin?.replace(/\/$/, '');
          if (!origin)
            return pending('No source inventory gives the source site to compare titles with.');
          const app = await application(ctx);
          if (isResult(app)) return app;
          const host = buildHost(app);
          if (!host) return fail(['The application has no host to read the pages on']);
          return { origin, app, host: host.host };
        })());
      return eachPage(
        async (c, pg) => {
          const at = await sites();
          if ('status' in at) return at;
          const sourceUrl = `${at.origin}${pg.path === '/' ? '/' : pg.path}`;
          const url = `https://${at.host}${pg.route(languages[0] ?? 'en')}`;
          const [source, candidate] = await Promise.all([page(cfg, sourceUrl), page(cfg, url)]);
          if (candidate.status !== 200)
            return fail([`${url} answered ${candidate.status || 'nothing'}`]);
          if (source.status !== 200 || isChallengePage(source.html))
            return pending(
              `The source page ${sourceUrl} could not be read (${source.status || 'no answer'}${source.status === 200 ? ', a bot check' : ''}), so its title was not compared.`,
            );
          if (redirectedAway(sourceUrl, source.url))
            return pending(`The source page moved to ${source.url}: it has no title of its own.`);
          const want = pageTitle(source.html);
          if (!want) return pending(`The source page ${sourceUrl} has no <title> to compare.`);
          const have = pageTitle(candidate.html);
          const data = { title: have, source: want };
          if (fold(have) === fold(want))
            return pass(`${pg.label} carries its source page's title, "${want}".`, data);
          // The head shows the published page. What the page's latest version holds says whose
          // fault a different title is: nobody set it, it is set and waits for its release, or
          // it is published and the head doesn't read it.
          const held = await pageContent(c, pg.cms(at.app.key), pg.label);
          if (isResult(held)) return held;
          const set = Object.entries(held.properties).find(
            ([name, v]) => /title/i.test(name) && typeof v === 'string' && fold(v) === fold(want),
          );
          if (!set)
            return fail(
              [
                `${pg.label} has the title "${have}"; the source page's is "${want}". Set it in the page's SEO title property, word for word`,
              ],
              data,
            );
          if ((held.status ?? '').toLowerCase() !== 'published')
            return {
              ...pending(
                `${pg.label} holds the source's title in ${set[0]} ("${want}") in a version that is not published yet. The head shows published content only, so its <title> is compared once the page is published.`,
              ),
              data,
            };
          return fail(
            [
              `${pg.label} has the title "${have}", but its published ${set[0]} property holds the source's "${want}": the head's <title> doesn't read the page's title property. That's head code (generateMetadata in the page route): send it back to integrate-head, not to content. A page published in the last minute may still be served from the host's cache: check once more first`,
            ],
            data,
          );
        },
        { cap: 60, atOnce: 6 },
      )(ctx);
    },

    // The start page carries the shared header and footer, and they render.
    'head.header-footer': async (ctx) => {
      const { languages } = optimizelyTarget({ target: ctx.target });
      const app = await application(ctx);
      if (isResult(app)) return app;
      const host = buildHost(app);
      if (!host) return fail(['The application has no host']);
      const p = await page(cfg, `https://${host.host}/${languages[0] ?? 'en'}/`);
      if (p.status !== 200) return fail([startPageAnswered(p.status, host.host)]);
      const links = (tag: string) =>
        (new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`, 'i').exec(p.html)?.[0].match(/<a\b/gi) ?? [])
          .length;
      const problems = [
        /<header\b/i.test(p.html) ? null : 'the page has no header',
        /<footer\b/i.test(p.html) ? null : 'the page has no footer',
        /<footer\b/i.test(p.html) && !links('footer') ? 'the footer has no links' : null,
      ].filter((x): x is string => Boolean(x));
      return problems.length
        ? fail(problems)
        : pass(
            `The start page renders its header (${links('header')} links) and footer (${links('footer')} links).`,
          );
    },

    // A portal's Blueprint (customer portal playbook, Gate 1), in this platform's model contract.
    // The shared blueprint.coverage reads another platform's (field types, a rendering name, a
    // query budget); blueprint.personas, which reads only the personas, runs beside this one.
    'blueprint.portal': async (ctx) => {
      const { typePrefix } = optimizelyTarget({ target: ctx.target });
      if (!ctx.blueprint?.collections) return fail(['No Blueprint has been written']);
      const inventory = (await ctx.document('page-inventory')) as {
        pages?: { path?: string; url?: string }[];
      } | null;
      const problems = portalBlueprintProblems(ctx.blueprint, inventory, typePrefix);
      if (problems.length)
        return fail([
          ...problems.slice(0, 10),
          ...(problems.length > 10 ? [`and ${problems.length - 10} more`] : []),
        ]);
      const kept = (c: string) => built(ctx.blueprint!.collections[c]);
      const forOneRole = kept('pages')
        .flatMap(placementsOf)
        .filter((s) => s.audience !== EVERYONE).length;
      return pass(
        `${kept('pages').length} pages on ${kept('templates').length} page ${kept('templates').length === 1 ? 'type' : 'types'} and ${kept('components').length} components, each a ${typePrefix} content type with a default display template of its own; ${forOneRole} ${forOneRole === 1 ? 'section is' : 'sections are'} shown to one role.`,
      );
    },

    // The portal's door, on the editing address: a signed-out reader is sent to the sign-in
    // screen, the demo accounts sign in, nobody else does, and a session is let through.
    'portal.sign-in': async (ctx) => {
      const personas = personasOf(ctx);
      if (!personas.length) return pending('The Blueprint lists no persona with a demo email.');
      const app = await application(ctx);
      if (isResult(app)) return app;
      const host = buildHost(app);
      if (!host) return fail(['The application has no host to sign in on']);
      const problems = await signInProblems(`https://${host.host}`, personas);
      return problems.length
        ? fail(problems)
        : pass(
            `On ${host.host} a signed-out reader is sent to the sign-in screen, ${personas.length === 1 ? 'the demo account signs' : `all ${personas.length} demo accounts sign`} in, and another email is refused.`,
          );
    },

    // The pilot's page: the start page, composed and published, as the default persona reads it.
    'portal.pilot-page': async (ctx) => {
      const personas = personasOf(ctx);
      if (!personas.length) return pending('The Blueprint lists no persona with a demo email.');
      const app = await application(ctx);
      if (isResult(app)) return app;
      const host = buildHost(app);
      if (!host) return fail(['The application has no host to read the page on']);
      const origin = `https://${host.host}`;
      const start = routedPages(ctx).find((p) => pathOf(p) === '/');
      const allowed = Array.isArray(start?.attrs?.personas) ? strings(start.attrs.personas) : null;
      const reader = (allowed && personas.find((p) => allowed.includes(p.key))) || personas[0]!;
      const s = await signIn(origin, reader.email);
      if (!s.cookie)
        return fail([
          `${reader.name} can't sign in on ${host.host} (${SESSION_PATH} answered ${s.status || 'nothing'})`,
        ]);
      const r = await renderProblems(ctx, {
        origin,
        application: app.key,
        ref: pageRef('/'),
        reader,
        cookie: s.cookie,
        wantSections: true,
      });
      if (r.pending) return pending(r.pending);
      return r.problems.length
        ? fail(r.problems)
        : pass(
            `Signed in as ${reader.name}, the start page renders its ${r.sections.length} ${r.sections.length === 1 ? 'section' : 'sections'} on ${host.host}.`,
            { sections: r.sections.map((x) => ({ name: x.name, contentType: x.contentType })) },
          );
    },

    // Each portal page renders for a persona who may open it, with the sections they are shown.
    // (The website playbooks' head.pages-render reads signed out: here that is the sign-in screen.)
    'portal.pages-render': async (ctx) => {
      const r = await pagesRender(ctx, buildHost);
      if ('status' in r) return r;
      if (r.problems.length) return fail(r.problems.slice(0, 15), { read: r.read });
      if (r.pending.length) return pending(r.pending.join('; '));
      return r.read.length
        ? pass(
            `${r.read.length} ${r.read.length === 1 ? 'page renders' : 'pages render'} their sections: ${r.read.join(', ')}.`,
            { read: r.read },
          )
        : pending('The Blueprint lists no page to read.');
    },

    // Content by role: each role's own sections are in the CMS where the Blueprint places them,
    // each persona's pages show theirs, and none shows a section set for another role.
    'portal.role-content': async (ctx) => {
      const { typePrefix, languages } = optimizelyTarget({ target: ctx.target });
      if (!ctx.blueprint) return pending('There is no approved Blueprint to check against.');
      const personas = personasOf(ctx);
      if (!personas.length) return pending('The Blueprint lists no persona with a demo email.');
      const app = await application(ctx);
      if (isResult(app)) return app;
      const host = buildHost(app);
      if (!host) return fail(['The application has no host to read the portal on']);
      const origin = `https://${host.host}`;
      const audiences = new Set(personas.map((p) => p.audience));
      const components = new Map(
        built(ctx.blueprint.collections.components).map((c) => [c.key, c]),
      );
      const problems: string[] = [];
      const waiting: string[] = [];
      const session = sessions(origin);
      let forOneRole = 0;
      let pagesWith = 0;
      for (const item of routedPages(ctx).slice(0, 20)) {
        const ref = pageRef(String(item.attrs!.path));
        const content = await pageContent(ctx, ref.cms(app.key), ref.label);
        if (isResult(content)) {
          (content.status === 'pending' ? waiting : problems).push(content.detail);
          continue;
        }
        const roleSections = content.sections.filter((s) => audienceOf(s) !== EVERYONE);
        for (const s of roleSections)
          if (!audiences.has(audienceOf(s)))
            problems.push(
              `"${s.name}" on ${ref.path} is shown to ${audienceOf(s)}, which is no persona's audience`,
            );
        // What the Blueprint gives each persona on this page is there, for that role alone.
        for (const persona of built(ctx.blueprint.collections.personas)) {
          const audience = String(persona.attrs?.audience ?? persona.key);
          const variants = Array.isArray(persona.attrs?.variants) ? persona.attrs.variants : [];
          for (const v of variants as { page?: unknown; component?: unknown }[]) {
            const component = typeof v?.component === 'string' ? components.get(v.component) : null;
            if (v?.page !== item.key || !component) continue;
            const type = typeKeyOf(component, typePrefix).toLowerCase();
            const same = content.sections.filter((s) => s.contentType?.toLowerCase() === type);
            if (!same.some((s) => audienceOf(s) === audience))
              problems.push(
                `${ref.path} has no ${component.name} section shown to ${audience}: ${persona.name}'s own content is missing`,
              );
            else if (same.some((s) => audienceOf(s) === EVERYONE))
              problems.push(
                `${ref.path} also shows a ${component.name} section to everyone, so ${persona.name} sees both`,
              );
          }
        }
        if (!roleSections.length) continue;
        forOneRole += roleSections.length;
        pagesWith++;
        const allowed = Array.isArray(item.attrs?.personas) ? strings(item.attrs.personas) : null;
        for (const reader of personas.filter((p) => !allowed || allowed.includes(p.key))) {
          const s = await session(reader);
          if (!s.cookie) {
            problems.push(`${reader.name} can't sign in (${SESSION_PATH} answered ${s.status})`);
            continue;
          }
          const p = await open(`${origin}${ref.route(languages[0] ?? 'en')}`, s.cookie);
          if (p.status !== 200 || isSignIn(p.url)) {
            problems.push(
              `${ref.path} ${isSignIn(p.url) ? 'shows the sign-in screen' : `answered ${p.status || 'nothing'}`} as ${reader.name}`,
            );
            continue;
          }
          const marked = [...p.html.matchAll(/data-audience="([^"]*)"/g)].map((m) => m[1]!);
          const others = [
            ...new Set(marked.filter((a) => a !== EVERYONE && a !== reader.audience)),
          ];
          const own = roleSections.filter((x) => audienceOf(x) === reader.audience);
          const shown = marked.filter((a) => a === reader.audience).length;
          if (others.length)
            problems.push(
              `${ref.path} shows ${reader.name} a section set for ${others.join(', ')}`,
            );
          if (shown < own.length)
            problems.push(
              `${ref.path} shows ${reader.name} ${shown} of the ${own.length} ${own.length === 1 ? 'section' : 'sections'} set for ${reader.audience} (each rendered section carries data-audience)`,
            );
          const text = fold(visibleText(p.html));
          for (const x of own)
            for (const h of headingsOf(x.properties))
              if (!literalParts(h).every((part) => text.includes(part)))
                problems.push(`"${h}" (${x.name}) is not on ${ref.path} as ${reader.name}`);
        }
      }
      if (problems.length) return fail(problems.slice(0, 15), { forOneRole, pages: pagesWith });
      if (waiting.length) return pending(waiting.join('; '));
      return forOneRole
        ? pass(
            `${forOneRole} ${forOneRole === 1 ? 'section is' : 'sections are'} shown to one role, on ${pagesWith} ${pagesWith === 1 ? 'page' : 'pages'}: each persona sees their own and none of another role's.`,
            { forOneRole, pages: pagesWith },
          )
        : fail([
            'No section on any page is shown to one role: the brief asks for content by role, so place each role’s sections with their audience',
          ]);
    },

    // The portal where the presenter uses it: on the application's primary host (production)
    // the sign-in works as on the editing address and every page renders for its persona.
    // (routes.resolve would follow each route to the sign-in screen and call that an answer.)
    'portal.production': async (ctx) => {
      const personas = personasOf(ctx);
      if (!personas.length) return pending('The Blueprint lists no persona with a demo email.');
      const app = await application(ctx);
      if (isResult(app)) return app;
      const host = primaryHost(app);
      if (!host) return fail(['The application has no primary host: production has no address']);
      const door = await signInProblems(`https://${host.host}`, personas);
      if (door.length) return fail(door);
      const r = await pagesRender(ctx, primaryHost);
      if ('status' in r) return r;
      if (r.problems.length) return fail(r.problems.slice(0, 15), { read: r.read });
      if (r.pending.length) return pending(r.pending.join('; '));
      return pass(
        `On production (${host.host}) the demo accounts sign in and ${r.read.length} ${r.read.length === 1 ? 'page renders' : 'pages render'} for a persona who may open ${r.read.length === 1 ? 'it' : 'them'}.`,
        { read: r.read },
      );
    },
  };
}
