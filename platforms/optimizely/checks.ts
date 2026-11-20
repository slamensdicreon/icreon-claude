import type { OptimizelyVerifyConfig } from '@lw/connectors';
import type { CheckResult, PlatformCheck, PlatformCheckContext } from '../src/index';
// Reading a page as a visitor does is the same on every platform.
import {
  headingsOf as headingsIn,
  isChallengePage,
  redirectedAway,
  showsHeading,
  visibleText as readableText,
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

/**
 * The pages a check covers: the task's own (a page's migration is judged on that page), else
 * the start page. Error pages have no route of their own and are left out.
 */
function pagesOf(ctx: PlatformCheckContext): PageRef[] {
  if (ctx.scope.collection !== 'pages' || !ctx.scope.items.length) return [pageRef('/')];
  const own = built(ctx.blueprint?.collections.pages)
    .filter((p) => ctx.scope.items.includes(p.key) && !p.attrs?.errorPage)
    .map((p) => p.attrs?.path)
    .filter((path): path is string => typeof path === 'string' && path.startsWith('/'));
  return own.length ? [...new Set(own)].slice(0, 20).map(pageRef) : [pageRef('/')];
}

/** One verdict over the task's pages: every failure named by its page, pending only when nothing failed. */
const eachPage =
  (one: (ctx: PlatformCheckContext, page: PageRef) => Promise<CheckResult>): PlatformCheck =>
  async (ctx) => {
    const pages = pagesOf(ctx);
    const results: { page: PageRef; result: CheckResult }[] = [];
    for (const p of pages) results.push({ page: p, result: await one(ctx, p) });
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
  const host = primaryHost(app);
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
      return problems.length
        ? fail(problems)
        : pass(`${host.host} is the application's primary host.`);
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
      const host = primaryHost(app);
      if (!host) return fail(['The application has no host to open the preview on']);
      const route = /^\{host\}(\/[^?]*)/.exec(app.previewUrl ?? '')?.[1] ?? '/preview';
      const p = await page(cfg, `https://${host.host}${route}`);
      if (behindLogin(p))
        return fail([
          `${host.host}${route} is behind a login: Visual Builder loads it in a frame, so Vercel Authentication must be off for the project`,
        ]);
      return p.status === 200
        ? pass(`${host.host}${route} answers, and is not behind a login.`)
        : fail([
            `${host.host}${route} answered ${p.status || `nothing (${p.error ?? 'no response'})`}`,
          ]);
    },

    // A page renders on the head and shows what its sections hold.
    'head.pages-render': eachPage(async (ctx, pg) => {
      const { languages } = optimizelyTarget({ target: ctx.target });
      const app = await application(ctx);
      if (isResult(app)) return app;
      const host = primaryHost(app);
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

    // The start page carries the shared header and footer, and they render.
    'head.header-footer': async (ctx) => {
      const { languages } = optimizelyTarget({ target: ctx.target });
      const app = await application(ctx);
      if (isResult(app)) return app;
      const host = primaryHost(app);
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
