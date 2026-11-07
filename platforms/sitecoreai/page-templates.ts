import type { CheckResult, PlatformCheck, PlatformCheckContext } from '../src/index';
import { mappingProblems } from './mapping';
import { sitecoreBindings } from './pack';

/**
 * Large sites are planned and migrated per template; small sites page by page. The rule lives here,
 * in one place, and the Blueprint check below holds the Solution Architect to it: agents don't
 * choose between the two.
 *
 * - A site of LARGE_SITE_PAGES pages or more (what the discovery crawl found) is large. Each of
 *   its crawl templates of BULK_TEMPLATE_PAGES pages or more becomes a `page-templates` item: a
 *   field mapping proven on its example pages, then applied to the rest in bulk. Its other pages
 *   (the home page, landing and one-off pages, small templates) are planned one by one.
 * - A smaller site has no `page-templates`: every page is planned and migrated on its own, as
 *   before.
 */
export const LARGE_SITE_PAGES = 400;
export const BULK_TEMPLATE_PAGES = 20;

const pass = (detail: string): CheckResult => ({ status: 'pass', detail });
const fail = (problems: string[]): CheckResult => ({
  status: 'fail',
  detail: `${problems.slice(0, 8).join('; ')}${problems.length > 8 ? `; and ${problems.length - 8} more` : ''}.`,
});
const pending = (detail: string): CheckResult => ({ status: 'pending', detail });

interface InventoryTemplate {
  id?: string;
  pages?: number;
  patterns?: { pattern?: string; pages?: number }[];
  examples?: string[];
}

interface Inventory {
  pages?: unknown[];
  crawl?: { pagesFound?: number; crawlId?: string } | null;
  templates?: InventoryTemplate[];
}

type Item = NonNullable<PlatformCheckContext['blueprint']>['collections'][string][number];

/** How big the source is, by the discovery inventory, and whether it counts as large. */
export function siteScale(inv: Inventory | null): {
  pages: number;
  large: boolean;
  bulk: InventoryTemplate[];
} {
  const pages = Number(inv?.crawl?.pagesFound) || inv?.pages?.length || 0;
  const large = pages >= LARGE_SITE_PAGES;
  const bulk = large
    ? (inv?.templates ?? []).filter((t) => t?.id && Number(t.pages) >= BULK_TEMPLATE_PAGES)
    : [];
  return { pages, large, bulk };
}

/** One entry of a page-templates mapping: a Sitecore field and where its value comes from. */
interface MappingEntry {
  field?: unknown;
  from?: unknown;
  component?: unknown;
}

const mappingOf = (t: Item): MappingEntry[] =>
  Array.isArray(t.attrs?.mapping) ? (t.attrs!.mapping as MappingEntry[]) : [];

const examplesOf = (ctx: PlatformCheckContext, t: Item) =>
  (ctx.blueprint?.collections.pages ?? []).filter(
    (p) => p.status !== 'drop' && p.attrs?.mergedInto === t.key,
  );

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Most exception pages a template's import may leave; past it the mapping is likely wrong. */
export const MAX_EXCEPTION_SHARE = 0.1;
/** Imported pages whose rendering is compared with the source, and of those, looked at. */
const TEXT_SAMPLE = 20;
const VISUAL_SAMPLE = 3;

/** `n` items spread evenly through a list (first, last and between), for a fair sample. */
export function spread<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  return Array.from({ length: n }, (_, i) => xs[Math.round((i * (xs.length - 1)) / (n - 1))]!);
}

export function pageTemplateChecks(
  base: Record<string, PlatformCheck> = {},
): Record<string, PlatformCheck> {
  return {
    // The size rule, on the Blueprint: per template for a large site's big templates, page by
    // page for everything else.
    'blueprint.page-templates': async (ctx) => {
      const bp = ctx.blueprint;
      if (!bp?.collections) return pending('No Blueprint has been written yet.');
      const inv = (await ctx.document('page-inventory')) as Inventory | null;
      if (!inv) return pending('No page inventory to size the site by.');
      const scale = siteScale(inv);
      const all = bp.collections['page-templates'] ?? [];
      const kept = all.filter((t) => t.status !== 'drop');
      if (!scale.large) {
        if (kept.length)
          return fail([
            `the source has ${count(scale.pages, 'page')}, fewer than ${LARGE_SITE_PAGES}: a site this size is planned page by page. Remove page-templates (${kept.map((t) => t.key).join(', ')}) and give each of their pages its own entry in pages`,
          ]);
        return pass(
          `A small site (${count(scale.pages, 'page')}): every page is planned and migrated on its own.`,
        );
      }

      const problems: string[] = [];
      if (!(inv.templates ?? []).length)
        problems.push(
          `the source has ${scale.pages} pages, but the page inventory records no templates: the Content Analyst adds them from crawl.status, and a site this size is planned per template`,
        );
      const byCrawl = new Map(all.map((t) => [String(t.attrs?.crawlTemplate ?? ''), t]));
      for (const t of scale.bulk)
        if (!byCrawl.has(t.id!))
          problems.push(
            `template ${t.id} (${t.pages} pages) has no page-templates entry: plan it per template (attrs.crawlTemplate "${t.id}"), or add it with status "drop" and attrs.reason`,
          );
      const sizes = new Map((inv.templates ?? []).map((t) => [t.id, Number(t.pages) || 0]));
      const templates = new Set((bp.collections.templates ?? []).map((t) => t.key));
      for (const t of kept) {
        const a = t.attrs ?? {};
        const crawlTemplate = String(a.crawlTemplate ?? '');
        const size = sizes.get(crawlTemplate);
        if (!crawlTemplate || size === undefined)
          problems.push(
            `${t.key} names no template of the inventory in attrs.crawlTemplate${crawlTemplate ? ` ("${crawlTemplate}" isn't one)` : ''}`,
          );
        else if (size < BULK_TEMPLATE_PAGES)
          problems.push(
            `${t.key} covers ${count(size, 'page')}, fewer than ${BULK_TEMPLATE_PAGES}: plan those pages one by one in pages instead`,
          );
        if (!a.crawlId && !inv.crawl?.crawlId)
          problems.push(`${t.key} has no attrs.crawlId: the crawl its pages are listed in`);
        if (!a.template || !templates.has(String(a.template)))
          problems.push(
            `${t.key} needs attrs.template, the key of its page template in templates${a.template ? ` ("${String(a.template)}" isn't one)` : ''}`,
          );
        const mapping = mappingOf(t);
        if (!mapping.length)
          problems.push(
            `${t.key} has no attrs.mapping: list each field its pages fill, as { "component", "field", "from" }`,
          );
        if (mapping.length)
          for (const p of mappingProblems(mapping).slice(0, 3)) problems.push(`${t.key}: ${p}`);
        const examples = examplesOf(ctx, t);
        if (!examples.length)
          problems.push(
            `${t.key} has no example pages: add its examples to pages with status "merge" and attrs.mergedInto "${t.key}", so it is proven on them before the bulk import`,
          );
        else if (examples.length > 5)
          problems.push(
            `${t.key} has ${examples.length} example pages: 2 to 5 prove a mapping; the rest come with the bulk import`,
          );
      }
      if (problems.length) return fail(problems);
      const bulkPages = kept.reduce(
        (n, t) => n + (sizes.get(String(t.attrs?.crawlTemplate)) ?? 0),
        0,
      );
      const own = (bp.collections.pages ?? []).filter(
        (p) => p.status !== 'drop' && !(p.status === 'merge' && p.attrs?.mergedInto),
      ).length;
      return pass(
        `A large site (${count(scale.pages, 'page')}): ${count(kept.length, 'template')} planned per template (${bulkPages} pages, proven on their examples first), ${count(own, 'page')} planned one by one.`,
      );
    },

    // A template's bulk import: finished, few pages that didn't fit (each built by an agent since),
    // and a spread of the imported pages rendering like their source pages.
    'template.imported': async (ctx) => {
      const items =
        ctx.scope.collection === 'page-templates'
          ? (ctx.blueprint?.collections['page-templates'] ?? []).filter(
              (t) => t.status !== 'drop' && ctx.scope.items.includes(t.key),
            )
          : [];
      if (!items.length) return pending('This task imports no page template.');
      const problems: string[] = [];
      const notes: string[] = [];
      const home = `${sitecoreBindings(ctx.target).sitePath}/Home`;
      for (const t of items) {
        const doc = (await ctx.document(`template-import-${t.key}`)) as {
          status?: string;
          total?: number;
          imported?: { path: string }[];
          exceptions?: { path: string; reason?: string | null }[];
        } | null;
        if (!doc) {
          problems.push(`${t.key} hasn't been imported: run import.start with template "${t.key}"`);
          continue;
        }
        if (doc.status !== 'done') {
          problems.push(
            `${t.key}'s import is ${doc.status ?? 'unfinished'}: follow it with import.status until it is done`,
          );
          continue;
        }
        const total = Number(doc.total) || 0;
        const off = doc.exceptions ?? [];
        if (total && off.length / total > MAX_EXCEPTION_SHARE) {
          problems.push(
            `${off.length} of ${total} pages of ${t.key} didn't fit its mapping (more than ${Math.round(MAX_EXCEPTION_SHARE * 100)}%): fix template-mapping-${t.key} from their reasons (${[...new Set(off.map((e) => e.reason ?? ''))].slice(0, 2).join('; ')}) and retry the import, rather than building them one by one`,
          );
          continue;
        }
        // Each exception page built by hand since: it exists in Sitecore now.
        const unbuilt: string[] = [];
        for (const e of off) {
          const r = await ctx.read('sitecore-authoring', 'item.read', { path: `${home}${e.path}` });
          if (r.code !== 200) unbuilt.push(e.path);
        }
        if (unbuilt.length)
          problems.push(
            `${count(unbuilt.length, 'exception page')} of ${t.key} ${unbuilt.length === 1 ? "isn't" : "aren't"} built yet: ${unbuilt.slice(0, 5).join(', ')}${unbuilt.length > 5 ? ` and ${unbuilt.length - 5} more` : ''}. Build each as you would any page, or retry the import once what it waits on is done`,
          );
        // A spread of the imported pages, through the page checks: they render like the source.
        const imported = (doc.imported ?? []).map((p) => p.path);
        const sample = (n: number) => ({
          ...ctx,
          scope: { collection: null, items: [] },
          blueprint: {
            collections: {
              ...(ctx.blueprint?.collections ?? {}),
              pages: spread(imported, n).map((path, i) => ({
                key: `imported-${i}`,
                name: path,
                attrs: { path },
              })),
            },
          },
        });
        for (const [id, n] of [
          ['parity.render', TEXT_SAMPLE],
          ['parity.visual', VISUAL_SAMPLE],
        ] as const) {
          const check = base[id];
          if (!check || !imported.length) continue;
          const r = await check(sample(n));
          if (r.status === 'fail') problems.push(`${t.key}, sampled imported pages: ${r.detail}`);
          else if (r.status === 'pass') notes.push(`${id} on ${Math.min(n, imported.length)}`);
        }
        if (!problems.length)
          notes.unshift(
            `${t.name}: ${imported.length} pages imported, ${off.length} built by hand`,
          );
      }
      return problems.length ? fail(problems) : pass(`Imported: ${notes.join('; ')}.`);
    },

    // A template's proof: its mapping, as it worked on the example pages, written down for the
    // bulk import. The example pages themselves are checked by the page checks beside this one.
    'template.mapping': async (ctx) => {
      const items =
        ctx.scope.collection === 'page-templates'
          ? (ctx.blueprint?.collections['page-templates'] ?? []).filter(
              (t) => t.status !== 'drop' && ctx.scope.items.includes(t.key),
            )
          : [];
      if (!items.length) return pending('This task proves no page template.');
      const problems: string[] = [];
      const proven: string[] = [];
      for (const t of items) {
        const doc = (await ctx.document(`template-mapping-${t.key}`)) as {
          template?: string;
          mapping?: MappingEntry[];
          examples?: { path?: string; itemId?: string }[];
        } | null;
        if (!doc) {
          problems.push(
            `no template-mapping-${t.key} document: write it (artifacts.write, json) once its example pages pass`,
          );
          continue;
        }
        const fields = new Set(
          (doc.mapping ?? []).map((m) => `${String(m.component ?? '')}/${String(m.field ?? '')}`),
        );
        const missing = mappingOf(t).filter(
          (m) => !fields.has(`${String(m.component ?? '')}/${String(m.field ?? '')}`),
        );
        if (missing.length)
          problems.push(
            `template-mapping-${t.key} leaves out ${missing.map((m) => `${m.component ? `${String(m.component)}.` : ''}${String(m.field)}`).join(', ')} from the Blueprint's mapping: keep every field, with how it was really filled`,
          );
        for (const p of mappingProblems(
          doc.mapping,
          (doc as { mediaFolder?: unknown }).mediaFolder,
        ))
          problems.push(`template-mapping-${t.key}: ${p}`);
        const want = examplesOf(ctx, t).map((p) => String(p.attrs?.path ?? '').replace(/\/$/, ''));
        const done = new Map(
          (doc.examples ?? []).map((e) => [String(e.path ?? '').replace(/\/$/, ''), e]),
        );
        const notDone = want.filter((path) => !done.get(path)?.itemId);
        if (notDone.length)
          problems.push(
            `template-mapping-${t.key} doesn't record ${notDone.join(', ')} as migrated: list each example page with its path and the itemId of its page item`,
          );
        if (!problems.length) proven.push(`${t.name} (${want.length} examples)`);
      }
      return problems.length
        ? fail(problems)
        : pass(`Mapping proven and recorded for the bulk import: ${proven.join(', ')}.`);
    },
  };
}
