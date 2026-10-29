import type { VerifyConfig } from '@lw/connectors';
import type { CheckResult, PlatformCheck, PlatformCheckContext } from '../src/index';
import { ownedPaths, sitecoreBindings, sitecoreTarget } from './pack';

/**
 * SitecoreAI acceptance checks: read-only looks at the tenant and at Experience Edge, judged
 * against the approved Blueprint. A check that can't run says why and counts as pending.
 */

interface Item {
  itemId: string;
  name: string;
  path: string;
  children?: { nodes: { itemId: string; name: string; path: string }[] };
  fields?: { nodes: { name: string; value: string }[] };
}

type Child = { itemId: string; name: string; path: string };

const pass = (detail: string): CheckResult => ({ status: 'pass', detail });
const fail = (problems: string[]): CheckResult => ({
  status: 'fail',
  detail: `${problems.slice(0, 8).join('; ')}${problems.length > 8 ? `; and ${problems.length - 8} more` : ''}.`,
});
const pending = (detail: string): CheckResult => ({ status: 'pending', detail });

const id = (s: string) => s.replace(/[{}-]/g, '').toLowerCase();

async function item(
  ctx: PlatformCheckContext,
  path: string,
  children = false,
): Promise<Item | null> {
  const r = await ctx.read('sitecore-authoring', 'item.read', { path, children });
  if (r.code === 404) return null;
  if (r.code !== 200) throw new Error(`reading ${path} answered ${r.code}`);
  return r.body as Item;
}

/**
 * Items named `names` under a root, looking up to two folders deep. With `all`, every item of each
 * name is collected there, and the search covers every level rather than stopping at the first hits.
 */
async function findByName(
  ctx: PlatformCheckContext,
  root: string,
  names: string[],
  all?: Map<string, Child[]>,
) {
  const want = new Set(names.map((n) => n.toLowerCase()));
  const found = new Map<string, Child>();
  let level = [root];
  for (let depth = 0; depth < 3 && level.length && (all || found.size < want.size); depth++) {
    const next: string[] = [];
    for (const path of level.slice(0, 40)) {
      const it = await item(ctx, path, true);
      for (const c of it?.children?.nodes ?? []) {
        const key = c.name.toLowerCase();
        if (want.has(key)) {
          if (!found.has(key)) found.set(key, c);
          all?.set(key, [...(all.get(key) ?? []), c]);
        } else next.push(c.path);
      }
    }
    level = next;
  }
  return found;
}

/** The collection's kept items, or only the task's own when it covers some of them. */
const inScope = (ctx: PlatformCheckContext, collection: string) => {
  const kept = (ctx.blueprint?.collections[collection] ?? []).filter((i) => i.status !== 'drop');
  const own =
    ctx.scope.collection === collection && ctx.scope.items.length ? ctx.scope.items : null;
  return own ? kept.filter((i) => own.includes(i.key)) : kept;
};

/** The rendering item's name from a component's model contract: a name, or { name, componentName }. */
export function renderingName(c: { name: string; attrs?: Record<string, unknown> }): string {
  const r = c.attrs?.rendering;
  if (typeof r === 'string' && r.trim()) return r.trim();
  if (r && typeof r === 'object') {
    const o = r as Record<string, unknown>;
    for (const k of ['name', 'rendering', 'componentName'])
      if (typeof o[k] === 'string' && (o[k] as string).trim()) return (o[k] as string).trim();
  }
  return c.name;
}

export function sitecoreChecks(cfg: VerifyConfig): Record<string, PlatformCheck> {
  /** Does each route resolve on Experience Edge with the given Context ID? */
  async function routes(ctx: PlatformCheckContext, paths: string[], credentialId: string) {
    const c = await ctx.credential(credentialId);
    if (!c?.contextId)
      return {
        missing: null as string[] | null,
        why: `no ${credentialId} Context ID is stored`,
        rendered: new Map<string, unknown>(),
      };
    const t = sitecoreTarget(ctx);
    const url = new URL('/v1/content/api/graphql/v1', cfg.edgeUrl);
    url.searchParams.set('sitecoreContextId', c.contextId);
    const missing: string[] = [];
    const rendered = new Map<string, unknown>();
    for (const path of paths.slice(0, 60)) {
      const res = await cfg.fetch(url.href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: `query($site: String!, $path: String!, $lang: String!) { layout(site: $site, routePath: $path, language: $lang) { item { rendered } } }`,
          variables: { site: t.site, path, lang: t.languages[0] ?? 'en' },
        }),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
      const b = (await res.json().catch(() => ({}))) as {
        data?: { layout?: { item?: { rendered?: unknown } | null } | null };
      };
      if (!b.data?.layout?.item) missing.push(path);
      else rendered.set(path, b.data.layout.item.rendered);
    }
    return { missing, why: '', rendered };
  }

  const pagePaths = (ctx: PlatformCheckContext) => {
    const paths = inScope(ctx, 'pages').map(
      (p) => String(p.attrs?.path ?? '').replace(/\/$/, '') || '/',
    );
    return paths.length ? [...new Set(paths)] : ['/'];
  };

  return {
    // The site and the project's own folders exist, with routes under Home.
    'structural.site': async (ctx) => {
      const b = sitecoreBindings(ctx.target);
      const problems: string[] = [];
      const site = await item(ctx, b.sitePath!, true);
      if (!site) return fail([`No site at ${b.sitePath}`]);
      if (!site.children?.nodes.some((c) => c.name.toLowerCase() === 'home'))
        problems.push(`${b.sitePath} has no Home item`);
      for (const p of ownedPaths(ctx.target).slice(1))
        if (!(await item(ctx, p))) problems.push(`${p} doesn't exist`);
      return problems.length ? fail(problems) : pass(`Site, Home and the project's folders exist.`);
    },

    // Every page template in the Blueprint exists in the project's folder, with standard values.
    'structural.templates': async (ctx) => {
      const all = inScope(ctx, 'templates');
      if (!all.length) return pending('The Blueprint has no templates to check.');
      // A merged template ships inside another: it has no item of its own, its target does.
      const intoOf = (t: (typeof all)[number]) => {
        const a = t.attrs ?? {};
        const v = a.mergedInto ?? a.mergeInto ?? a.mergesInto ?? a.into;
        return typeof v === 'string' ? v : null;
      };
      const merged = all.filter((t) => t.status === 'merge' || intoOf(t));
      const templates = all.filter((t) => !merged.includes(t));
      const root = `/sitecore/templates/Project/${sitecoreBindings(ctx.target).project}`;
      const found = await findByName(
        ctx,
        root,
        templates.map((t) => t.name),
      );
      const problems: string[] = [];
      const byKeyOrName = (ref: string) =>
        templates.find((x) => x.key === ref || x.name.toLowerCase() === ref.toLowerCase());
      for (const t of templates) {
        const hit = found.get(t.name.toLowerCase());
        if (!hit) {
          problems.push(`template ${t.name} not under ${root}`);
          continue;
        }
        const sv = `${hit.path}/__Standard Values`;
        if (!(await item(ctx, sv))) {
          problems.push(`${t.name} has no standard values`);
          continue;
        }
        // Insert options take effect on the standard values, not on the template item itself.
        const wanted = Array.isArray(t.attrs?.insertOptions)
          ? (t.attrs.insertOptions as unknown[]).map(String)
          : [];
        if (!wanted.length) continue;
        const want = wanted.map((ref) => {
          const bt = byKeyOrName(ref);
          return {
            ref,
            name: bt?.name ?? ref,
            hit: bt ? found.get(bt.name.toLowerCase()) : undefined,
          };
        });
        const r = await ctx.read('sitecore-authoring', 'item.read', {
          path: sv,
          fields: ['__Masters'],
        });
        const value =
          r.code === 200
            ? ((r.body as Item).fields?.nodes.find((f) => f.name.toLowerCase() === '__masters')
                ?.value ?? '')
            : '';
        const have = new Set(value.split('|').filter(Boolean).map(id));
        const missing = want.filter((w) => !w.hit || !have.has(id(w.hit.itemId)));
        if (missing.length)
          problems.push(
            `${t.name}'s insert options (__Masters on ${sv}) ${value ? `are ${value}` : 'are empty'}; the Blueprint wants ${want.map((w) => (w.hit ? `${w.name} ${w.hit.itemId}` : `${w.name} (no such template)`)).join(' and ')}, missing ${missing.map((w) => w.name).join(', ')}`,
          );
      }
      for (const m of merged) {
        const into = intoOf(m);
        const target = into ? byKeyOrName(into) : null;
        if (into && (!target || !found.get(target.name.toLowerCase())))
          problems.push(`${m.name} is merged into ${into}, which isn't under ${root}`);
      }
      return problems.length
        ? fail(problems)
        : pass(
            `${templates.length} templates exist with standard values, and their insert options match the Blueprint${merged.length ? `; ${merged.length} merged into others, as the Blueprint says` : ''}.`,
          );
    },

    // Every component has its rendering, and the site offers it in Available Renderings.
    'structural.renderings': async (ctx) => {
      const components = inScope(ctx, 'components');
      if (!components.length) return pending('The Blueprint has no components to check.');
      const b = sitecoreBindings(ctx.target);
      const root = `/sitecore/layout/Renderings/Project/${b.module}`;
      const names = components.map(renderingName);
      const all = new Map<string, Child[]>();
      await findByName(ctx, root, names, all);
      // The site's groups of renderings, and groups kept in folders one level down.
      const groupsPath = `${b.sitePath}/Presentation/Available Renderings`;
      const available = await item(ctx, groupsPath, true);
      const offered = new Set<string>();
      const groups: string[] = [];
      const readGroup = async (path: string, depth: number) => {
        const g = await item(ctx, path, true);
        const field = g?.fields?.nodes.find((f) => f.name === 'Renderings');
        if (field) {
          groups.push(g!.name);
          for (const part of field.value.split('|')) if (part) offered.add(id(part));
        } else if (depth === 0) {
          for (const c of g?.children?.nodes ?? []) await readGroup(c.path, 1);
        }
      };
      for (const group of available?.children?.nodes ?? []) await readGroup(group.path, 0);
      const problems: string[] = [];
      for (const n of names) {
        const hits = all.get(n.toLowerCase()) ?? [];
        if (!hits.length) problems.push(`rendering ${n} not under ${root}`);
        else if (hits.length > 1)
          problems.push(
            `${hits.length} renderings named ${n} (${hits.map((h) => `${h.path} ${h.itemId}`).join(', ')}): keep one, delete the others, and offer the one kept`,
          );
        else if (!offered.has(id(hits[0]!.itemId)))
          problems.push(
            `${n} (${hits[0]!.itemId}) isn't in Available Renderings: none of ${groups.length ? groups.join(', ') : `the groups under ${groupsPath} (there are none)`} lists that ID`,
          );
      }
      return problems.length
        ? fail(problems)
        : pass(`${names.length} renderings exist and are offered in Page builder.`);
    },

    // Each kept page has components on its layout, pointing at renderings by IDs Sitecore can read.
    'structural.layouts': async (ctx) => {
      if (!inScope(ctx, 'pages').length) return pending('The Blueprint has no pages to check.');
      const b = sitecoreBindings(ctx.target);
      const problems: string[] = [];
      const paths = pagePaths(ctx);
      for (const route of paths) {
        const path = `${b.sitePath}/Home${route === '/' ? '' : route}`;
        const r = await ctx.read('sitecore-authoring', 'item.read', {
          path,
          fields: ['__Renderings', '__Final Renderings'],
        });
        if (r.code === 404) {
          problems.push(`no page at ${path}`);
          continue;
        }
        if (r.code !== 200) throw new Error(`reading ${path} answered ${r.code}`);
        const xml = ((r.body as Item).fields?.nodes ?? []).map((f) => f.value).join('');
        const refs = [...xml.matchAll(/<d\b[^>]*>([\s\S]*?)<\/d>/gi)].flatMap((d) =>
          [...d[1]!.matchAll(/<r\b[^>]*>/gi)].map((m) => m[0]),
        );
        if (!refs.length) {
          problems.push(`${route} has no components on its layout`);
          continue;
        }
        // An ID written as 32 bare hex digits isn't an ID to Sitecore: the rendering shows nowhere.
        const unreadable = refs.filter((tag) =>
          [...tag.matchAll(/\b(?:s:)?(?:id|ds)="([^"]*)"/gi)].some((m) =>
            /^\{?[0-9a-f]{32}\}?$/i.test(m[1]!),
          ),
        ).length;
        if (unreadable)
          problems.push(
            `${route}: ${unreadable} of ${refs.length} components point at their rendering or datasource by an ID Sitecore can't read (32 bare hex digits); place them again with layout.compose`,
          );
      }
      return problems.length
        ? fail(problems)
        : pass(
            `${paths.length} page${paths.length === 1 ? ' has' : 's have'} components on a layout Sitecore can read.`,
          );
    },

    // Each kept page renders on the editing host. A green build doesn't prove it: a component that
    // throws while rendering (a client hook in a server component) fails the whole page with 500,
    // and Page builder shows "A rendering error occurred".
    'head.pages-render': async (ctx) => {
      if (!inScope(ctx, 'pages').length) return pending('The Blueprint has no pages to check.');
      const project = sitecoreTarget(ctx).hostingProject?.toLowerCase();
      if (!project) return pending('No hosting project is recorded for the head.');
      const host = `https://${project}-editing.vercel.app`;
      const paths = pagePaths(ctx);
      const problems: string[] = [];
      const cached: string[] = [];
      for (const path of paths.slice(0, 40)) {
        let status = 0;
        try {
          const res = await cfg.fetch(`${host}${path}`, {
            redirect: 'manual',
            signal: AbortSignal.timeout(cfg.timeoutMs),
          });
          status = res.status;
          const cache = res.headers.get('x-vercel-cache')?.toUpperCase();
          if (status === 200 && (cache === 'HIT' || cache === 'STALE' || cache === 'PRERENDER'))
            cached.push(path);
        } catch {
          status = 0;
        }
        if (status === 0 || status >= 500)
          problems.push(
            `${path} answered ${status || 'nothing'} on ${host}: a component throws while rendering; the head's runtime log names it`,
          );
        else if (status === 404) problems.push(`${path} isn't found on ${host}`);
      }
      // An editing host serves unpublished content: a cached render hides Sitecore edits and keeps
      // signed CM media links that expire (every image breaks).
      if (cached.length)
        problems.push(
          `${cached.length} page${cached.length === 1 ? ' is' : 's are'} served from a cached render on ${host} (${cached.slice(0, 3).join(', ')}): the editing host must render per request. Set SITECORE_RENDER_ON_REQUEST=true and leave generateStaticParams out of the page route when it is set`,
        );
      return problems.length
        ? fail(problems)
        : pass(`${paths.length} page${paths.length === 1 ? ' renders' : 's render'} on ${host}.`);
    },

    // The header and footer render on the editing host's pages: their partial designs exist, hold
    // the renderings in headless-header / headless-footer, and every page design includes them.
    'head.header-footer': async (ctx) => {
      const project = sitecoreTarget(ctx).hostingProject?.toLowerCase();
      if (!project) return pending('No hosting project is recorded for the head.');
      const host = `https://${project}-editing.vercel.app`;
      const problems: string[] = [];
      const paths = inScope(ctx, 'pages').length ? pagePaths(ctx).slice(0, 5) : ['/'];
      for (const path of paths) {
        let html = '';
        try {
          const res = await cfg.fetch(`${host}${path}`, {
            signal: AbortSignal.timeout(cfg.timeoutMs),
          });
          if (!res.ok) {
            problems.push(`${path} answered ${res.status} on ${host}`);
            continue;
          }
          html = await res.text();
        } catch {
          problems.push(`${path} didn't answer on ${host}`);
          continue;
        }
        // The app's Layout renders the placeholders inside these wrappers; empty means no partial design.
        const empty = (id: string) => new RegExp(`<div id="${id}">\\s*</div>`).test(html);
        if (empty('header')) problems.push(`${path} has no header`);
        if (empty('footer')) problems.push(`${path} has no footer`);
      }
      return problems.length
        ? fail([
            ...problems,
            'nothing is placed in headless-header / headless-footer: create the Header and Footer partial designs (from the JSS Partial Design template), add them to the page designs and map the page templates with page-designs.map',
          ])
        : pass(
            `The header and footer render on ${paths.length} page${paths.length === 1 ? '' : 's'} of ${host}.`,
          );
    },

    // Rendered parity: each kept page, as the editing host renders it, against the source page.
    // The page as a visitor sees it, not its items: a component that renders nothing, a list with
    // no items, placeholder copy or a missing header fails here even when every item exists.
    'parity.render': async (ctx) => {
      if (!inScope(ctx, 'pages').length) return pending('The Blueprint has no pages to check.');
      const project = sitecoreTarget(ctx).hostingProject?.toLowerCase();
      if (!project) return pending('No hosting project is recorded for the head.');
      const host = `https://${project}-editing.vercel.app`;
      const inv = ((await ctx.document('page-inventory')) ??
        (await ctx.document('parity-inventory'))) as { origin?: string } | null;
      const origin = inv?.origin?.replace(/\/$/, '') ?? null;
      // Components whose model has child items, by the name the head registers them under.
      const lists = new Set(
        (ctx.blueprint?.collections.components ?? [])
          .filter((c) => c.status !== 'drop' && c.attrs?.children)
          .map((c) => renderingName(c).replace(/\s+/g, '')),
      );
      const problems: string[] = [];
      const notes: string[] = [];
      let unread = 0;
      for (const path of pagePaths(ctx).slice(0, 20)) {
        const page = await getText(cfg, `${host}${path}`);
        if (page.status !== 200) {
          problems.push(`${path} answered ${page.status || 'nothing'} on the editing host`);
          continue;
        }
        const text = visibleText(page.body);
        const empty = (id: string) => new RegExp(`<div id="${id}">\\s*</div>`).test(page.body);
        if (empty('header') || empty('footer'))
          problems.push(
            `${path} has no ${empty('header') ? 'header' : 'footer'}${empty('header') && empty('footer') ? ' or footer' : ''}`,
          );
        const placeholders = PLACEHOLDERS.filter((p) => text.includes(p));
        if (placeholders.length)
          problems.push(`${path} shows placeholder copy: "${placeholders.join('", "')}"`);
        for (const c of layoutComponents(page.body))
          if (lists.has(c.name) && !itemCount(c.fields))
            problems.push(
              `${path}: ${c.name} renders no items (its rendering needs a Component Query returning its children, and its datasource needs child items)`,
            );
        if (!origin) continue;
        const source = await getText(cfg, `${origin}${path === '/' ? '/' : `${path}/`}`);
        if (source.status !== 200) {
          unread++;
          continue;
        }
        const want = wordsOf(visibleText(source.body));
        const have = wordsOf(text);
        const shared = [...want].filter((w) => have.has(w)).length;
        const coverage = want.size ? Math.round((shared / want.size) * 100) : 100;
        const heads = headingsOf(source.body);
        const lower = text.toLowerCase();
        const missing = heads.filter((h) => !lower.includes(h.toLowerCase()));
        notes.push(`${path} ${coverage}%`);
        if (coverage < 90)
          problems.push(
            `${path} shows ${coverage}% of the source page's text (90% needed)${missing.length ? `; missing headings: ${missing.slice(0, 5).join(' | ')}` : ''}`,
          );
        else if (heads.length && missing.length / heads.length > 0.1)
          problems.push(`${path} misses source headings: ${missing.slice(0, 5).join(' | ')}`);
      }
      if (problems.length) return fail(problems);
      if (!origin) return pending('No source inventory gives the source site to compare with.');
      if (unread && !notes.length)
        return pending("The source pages couldn't be read to compare with.");
      return pass(
        `Rendered parity with the source: ${notes.join(', ')}${unread ? `; ${unread} source page${unread === 1 ? '' : 's'} unreadable` : ''}.`,
      );
    },

    // Visual parity: each kept page, as the editing host renders it, looks like the source page.
    // Text parity can't see layouts, images or colours; a model compares screenshots of both, as
    // the client will, and names each difference.
    'parity.visual': async (ctx) => {
      if (!inScope(ctx, 'pages').length) return pending('The Blueprint has no pages to check.');
      const project = sitecoreTarget(ctx).hostingProject?.toLowerCase();
      if (!project) return pending('No hosting project is recorded for the head.');
      const host = `https://${project}-editing.vercel.app`;
      const inv = ((await ctx.document('page-inventory')) ??
        (await ctx.document('parity-inventory'))) as { origin?: string } | null;
      const origin = inv?.origin?.replace(/\/$/, '') ?? null;
      if (!origin) return pending('No source inventory gives the source site to compare with.');
      if (!ctx.compareScreens) return pending('No model is connected to compare screenshots.');
      const problems: string[] = [];
      const matched: string[] = [];
      const unread: string[] = [];
      for (const path of pagePaths(ctx).slice(0, 20)) {
        const r = await ctx.compareScreens({
          path,
          source: `${origin}${path === '/' ? '/' : `${path}/`}`,
          candidate: `${host}${path}`,
        });
        if ('error' in r) unread.push(`${path} (${r.error})`);
        else if (r.verdict === 'match') matched.push(path);
        else {
          const shown = r.differences.slice(0, 6);
          const more = r.differences.length - shown.length;
          problems.push(
            `${path} doesn't look like the source: ${shown.join('; ') || 'the layout differs'}${more > 0 ? ` (and ${more} more)` : ''}`,
          );
        }
      }
      if (problems.length) return fail(problems);
      if (!matched.length)
        return pending(`The pages couldn't be compared: ${unread.slice(0, 3).join('; ')}`);
      return pass(
        `${matched.length} page${matched.length === 1 ? ' looks' : 's look'} like the source on ${host}${unread.length ? `; ${unread.length} couldn't be compared` : ''}.`,
      );
    },

    // A component whose model has child items gets them only through a GraphQL Component Query on
    // its rendering: without one the head receives its own fields and an empty list.
    'structural.component-queries': async (ctx) => {
      const lists = inScope(ctx, 'components').filter((c) => c.attrs?.children);
      if (!lists.length) return pass('No component in scope lists child items.');
      const b = sitecoreBindings(ctx.target);
      const root = `/sitecore/layout/Renderings/Project/${b.module}`;
      const all = new Map<string, Child[]>();
      await findByName(ctx, root, lists.map(renderingName), all);
      const problems: string[] = [];
      for (const c of lists) {
        const name = renderingName(c);
        const hit = all.get(name.toLowerCase())?.[0];
        if (!hit) {
          problems.push(`rendering ${name} not under ${root}`);
          continue;
        }
        const r = await ctx.read('sitecore-authoring', 'item.read', {
          path: hit.path,
          fields: ['ComponentQuery'],
        });
        const q =
          (r.body as Item | null)?.fields?.nodes.find((f) => f.name === 'ComponentQuery')?.value ??
          '';
        if (!q.trim())
          problems.push(
            `${name} lists child items but its rendering has no Component Query: set one returning the fields and children its code reads`,
          );
        // `children { … }` takes the default page of 10; `children(first: N) { … }` sets one.
        else if (!/\bchildren\s*[({]/.test(q))
          problems.push(`${name}'s Component Query doesn't read the datasource's children`);
      }
      return problems.length
        ? fail(problems)
        : pass(
            `${lists.length} list component${lists.length === 1 ? ' has' : 's have'} a Component Query reading their children.`,
          );
    },

    // Published: the home route resolves on the live endpoint.
    'edge.published': async (ctx) => {
      const r = await routes(ctx, ['/'], 'edge-live');
      if (!r.missing) return pending(`Can't check Experience Edge: ${r.why}.`);
      return r.missing.length
        ? fail(['The home page does not resolve on Experience Edge (live)'])
        : pass('The home page resolves on Experience Edge (live).');
    },

    // Every page the Blueprint keeps resolves on the live endpoint.
    'routes.resolve': async (ctx) => {
      const paths = pagePaths(ctx);
      const r = await routes(ctx, paths, 'edge-live');
      if (!r.missing) return pending(`Can't check routes: ${r.why}.`);
      return r.missing.length
        ? fail(r.missing.map((p) => `${p} doesn't resolve`))
        : pass(`${paths.length} routes resolve on Experience Edge (live).`);
    },

    // Content parity: each kept page, on Experience Edge (preview), against the source re-crawl.
    'parity.page': async (ctx) => {
      const inv = ((await ctx.document('parity-inventory')) ??
        (await ctx.document('page-inventory'))) as {
        pages?: { path?: string; url?: string; title?: string; words?: number }[];
      } | null;
      if (!inv?.pages?.length) return pending('No source inventory to compare with.');
      const kept = new Set(pagePaths(ctx));
      const source = inv.pages
        .map((p) => ({
          path: (p.path ?? (p.url ? new URL(p.url).pathname : '')).replace(/\/$/, '') || '/',
          title: (p.title ?? '').split(/\s[|–-]\s/)[0]!.trim(),
          words: p.words ?? 0,
        }))
        .filter((p) => kept.has(p.path));
      if (!source.length) return pending('No kept page appears in the source inventory.');
      const r = await routes(
        ctx,
        source.map((p) => p.path),
        'edge-preview',
      );
      if (!r.missing) return pending(`Can't read the new site: ${r.why}.`);
      const pages = source.map((p) => {
        const text = textOf(r.rendered.get(p.path));
        const words = text.split(/\s+/).filter(Boolean).length;
        const titled = !p.title || text.toLowerCase().includes(p.title.toLowerCase());
        const enough = !p.words || words >= p.words * 0.9;
        const ok = r.rendered.has(p.path) && titled && enough;
        return {
          path: p.path,
          ok,
          sourceWords: p.words,
          targetWords: words,
          problem: !r.rendered.has(p.path)
            ? 'missing'
            : !titled
              ? 'title not found'
              : !enough
                ? `${words} of ${p.words} words`
                : null,
        };
      });
      const parity = Math.round((pages.filter((p) => p.ok).length / pages.length) * 1000) / 10;
      const bad = pages.filter((p) => !p.ok).map((p) => `${p.path}: ${p.problem}`);
      return {
        ...(parity >= 98
          ? pass(`Content parity ${parity}% across ${pages.length} pages.`)
          : fail([`Content parity ${parity}% (98% needed)`, ...bad])),
        data: { parity, pages },
      };
    },

    // Every image in the project's media folder carries alt text.
    'media.alt-text': async (ctx) => {
      const root = `/sitecore/media library/Project/${sitecoreBindings(ctx.target).project}`;
      const without: string[] = [];
      let images = 0;
      let level = [root];
      for (let depth = 0; depth < 4 && level.length; depth++) {
        const next: string[] = [];
        for (const path of level.slice(0, 60)) {
          const it = await item(ctx, path, true);
          if (!it) continue;
          const alt = it.fields?.nodes.find((f) => f.name.toLowerCase() === 'alt');
          if (alt) {
            images++;
            if (!alt.value.trim()) without.push(it.path);
          }
          next.push(...(it.children?.nodes ?? []).map((c) => c.path));
        }
        level = next;
      }
      if (!images) return pending(`No images under ${root} yet.`);
      return without.length
        ? fail(without.map((p) => `${p} has no alt text`))
        : pass(`${images} images, each with alt text.`);
    },
  };
}

/** Copy a component shows when its fields are empty or its datasource is missing. */
const PLACEHOLDERS = [
  'Section heading',
  'Describe this section',
  'Add a short introduction',
  'Page heading',
  '[No text in field]',
  'choose a datasource',
  'set a datasource',
  'Lorem ipsum',
];

async function getText(cfg: VerifyConfig, url: string): Promise<{ status: number; body: string }> {
  try {
    const res = await cfg.fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; Launchworks parity check)' },
      signal: AbortSignal.timeout(Math.max(cfg.timeoutMs, 20_000)),
    });
    return { status: res.status, body: await res.text() };
  } catch {
    return { status: 0, body: '' };
  }
}

/** What a visitor reads on an HTML page: scripts, styles and markup removed. */
export function visibleText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Distinct words of five letters or more: what a page says, not its glue words. */
export const wordsOf = (text: string) =>
  new Set((text.toLowerCase().match(/\p{L}{5,}/gu) ?? []) as string[]);

/** The page's visible h1–h3 text (headings only screen readers get are left out). */
export const headingsOf = (html: string) =>
  [...html.matchAll(/<h[1-3]\b([^>]*)>([\s\S]*?)<\/h[1-3]>/gi)]
    .filter((m) => !/class="[^"]*(screen-reader-text|sr-only|visually-hidden)/i.test(m[1]!))
    .map((m) => visibleText(m[2]!))
    .filter((h) => h.length > 2);

/**
 * The components in a Content SDK page's layout data, with the fields each received: read from
 * the React Server Components payload the page carries.
 */
export function layoutComponents(html: string): { name: string; fields: unknown }[] {
  const payload = [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)]
    .map((m) => {
      try {
        return JSON.parse(m[1]!) as string;
      } catch {
        return '';
      }
    })
    .join('');
  const out: { name: string; fields: unknown }[] = [];
  for (const m of payload.matchAll(/"componentName":"([A-Za-z0-9]+)"/g)) {
    const at = payload.indexOf('"fields":', m.index!);
    const next = payload.indexOf('"componentName":', m.index! + 1);
    if (at < 0 || (next >= 0 && at > next)) {
      out.push({ name: m[1]!, fields: null });
      continue;
    }
    const obj = balanced(payload, at + '"fields":'.length);
    let fields: unknown = null;
    try {
      fields = obj ? JSON.parse(obj) : null;
    } catch {
      fields = null;
    }
    out.push({ name: m[1]!, fields });
  }
  return out;
}

/** The JSON object starting at `from`, by matching braces outside strings. */
function balanced(s: string, from: number): string | null {
  if (s[from] !== '{') return null;
  let depth = 0;
  let inStr = false;
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return s.slice(from, i + 1);
  }
  return null;
}

/** How many child items a component received: by its Component Query, or as a list field. */
export function itemCount(fields: unknown): number {
  const f = (fields ?? {}) as {
    items?: unknown[];
    data?: { datasource?: { children?: { results?: unknown[] } } };
  };
  return (
    (f.data?.datasource?.children?.results?.length ?? 0) +
    (Array.isArray(f.items) ? f.items.length : 0)
  );
}

/** The text a rendered Content SDK layout shows: every field value, in its placeholders. */
export function textOf(rendered: unknown): string {
  const out: string[] = [];
  const walk = (v: unknown, inField: boolean) => {
    if (typeof v === 'string') {
      if (inField) out.push(v.replace(/<[^>]+>/g, ' '));
      return;
    }
    if (Array.isArray(v)) return v.forEach((x) => walk(x, inField));
    if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v as Record<string, unknown>))
        walk(x, inField || k === 'fields' || k === 'value');
  };
  walk(rendered, false);
  return out.join(' ').replace(/\s+/g, ' ').trim();
}
