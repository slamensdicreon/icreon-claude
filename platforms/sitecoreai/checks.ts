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

/** Items named `names` under a root, looking up to two folders deep. */
async function findByName(ctx: PlatformCheckContext, root: string, names: string[]) {
  const want = new Set(names.map((n) => n.toLowerCase()));
  const found = new Map<string, Child>();
  let level = [root];
  for (let depth = 0; depth < 3 && level.length && found.size < want.size; depth++) {
    const next: string[] = [];
    for (const path of level.slice(0, 40)) {
      const it = await item(ctx, path, true);
      for (const c of it?.children?.nodes ?? []) {
        if (want.has(c.name.toLowerCase())) found.set(c.name.toLowerCase(), c);
        else next.push(c.path);
      }
    }
    level = next;
  }
  return found;
}

const inScope = (ctx: PlatformCheckContext, collection: string) =>
  (ctx.blueprint?.collections[collection] ?? []).filter((i) => i.status !== 'drop');

export function sitecoreChecks(cfg: VerifyConfig): Record<string, PlatformCheck> {
  /** Does each route resolve on Experience Edge with the given Context ID? */
  async function routes(ctx: PlatformCheckContext, paths: string[], credentialId: string) {
    const c = await ctx.credential(credentialId);
    if (!c?.contextId)
      return { missing: null as string[] | null, why: `no ${credentialId} Context ID is stored` };
    const t = sitecoreTarget(ctx);
    const url = new URL('/v1/content/api/graphql/v1', cfg.edgeUrl);
    url.searchParams.set('sitecoreContextId', c.contextId);
    const missing: string[] = [];
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
    }
    return { missing, why: '' };
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
      for (const t of templates) {
        const hit = found.get(t.name.toLowerCase());
        if (!hit) problems.push(`template ${t.name} not under ${root}`);
        else if (!(await item(ctx, `${hit.path}/__Standard Values`)))
          problems.push(`${t.name} has no standard values`);
      }
      return problems.length
        ? fail(problems)
        : pass(`${templates.length} templates exist with standard values.`);
    },

    // Every component has its rendering, and the site offers it in Available Renderings.
    'structural.renderings': async (ctx) => {
      const components = inScope(ctx, 'components');
      if (!components.length) return pending('The Blueprint has no components to check.');
      const b = sitecoreBindings(ctx.target);
      const root = `/sitecore/layout/Renderings/Project/${b.module}`;
      const names = components.map((c) => String(c.attrs?.rendering ?? c.name));
      const found = await findByName(ctx, root, names);
      const available = await item(ctx, `${b.sitePath}/Presentation/Available Renderings`, true);
      const offered = new Set<string>();
      for (const group of available?.children?.nodes ?? []) {
        const g = await item(ctx, group.path);
        const v = g?.fields?.nodes.find((f) => f.name === 'Renderings')?.value ?? '';
        for (const part of v.split('|')) if (part) offered.add(id(part));
      }
      const problems: string[] = [];
      for (const n of names) {
        const hit = found.get(n.toLowerCase());
        if (!hit) problems.push(`rendering ${n} not under ${root}`);
        else if (!offered.has(id(hit.itemId))) problems.push(`${n} isn't in Available Renderings`);
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
  };
}
