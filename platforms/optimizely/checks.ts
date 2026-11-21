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

const primaryHost = (a: ApplicationView) =>
  (a.hosts ?? []).find((h) => h.type === 'primary') ?? (a.hosts ?? [])[0] ?? null;

/**
 * Where the build is looked at: the application's preview host (the editing host, which runs the
 * integration branch) when it has one, else its primary host. The same published content either
 * way; production runs the reviewed code only after the release.
 */
const buildHost = (a: ApplicationView) =>
  (a.hosts ?? []).find((h) => h.type === 'preview') ?? primaryHost(a);

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

export function optimizelyChecks(cfg: OptimizelyVerifyConfig): Record<string, PlatformCheck> {
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

    // A page is composed from the project's own sections, each on a display template.
    'structural.experiences': eachPage(async (ctx, pg) => {
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
    }),

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

    // A page renders on the head and shows what its sections hold.
    'head.pages-render': eachPage(async (ctx, pg) => {
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
    }),

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
        : fail(r.differences.slice(0, 12), r);
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
      const without = items
        .filter((i) => !(i.AltText ?? '').trim())
        .map((i) => i._metadata?.displayName ?? '?');
      const total = images?.total ?? items.length;
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
      if (p.status !== 200) return fail([`The start page answered ${p.status || 'nothing'}`]);
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
  };
}
