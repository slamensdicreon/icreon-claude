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
      const templates = inScope(ctx, 'templates');
      if (!templates.length) return pending('The Blueprint has no templates to check.');
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
      return problems.length
        ? fail(problems)
        : pass(
            `${templates.length} templates exist with standard values, and their insert options match the Blueprint.`,
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
