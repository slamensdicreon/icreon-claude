import { fileURLToPath } from 'node:url';
import { OPTIMIZELY_DEFAULTS, SITECORE_DEFAULTS } from '@lw/connectors';
import { createProjectState } from '@lw/domain';
import { InMemoryEventStore, type Projections } from '@lw/events';
import type { Blueprint } from '@lw/plan';
import { createPlatforms } from '@lw/platforms';
import { loadPlaybook } from '@lw/playbook-sdk';
import { MemoryBlobStore } from '@lw/tool-gateway';
import { ArtifactLibrary } from '@lw/tool-workspace';
import { selfCheck, type CheckRow } from '../src';

/**
 * Gate 1 on an Optimizely playbook, as the Solution Architect's own run of its acceptance checks
 * sees it: every check the plan's `draft-blueprint` step names, the pack's and the shared ones, on
 * a Blueprint and a page inventory, with the source site answered from memory.
 */

export const playbookDir = (id: string) =>
  fileURLToPath(new URL(`../../../playbooks/${id}`, import.meta.url));

/** The example Blueprints carry this prefix on every key. */
export const EXAMPLE_TARGET = {
  cmsUrl: 'https://app-acme.cms.optimizely.com',
  application: 'Acme Site',
  typePrefix: 'Acme',
  languages: ['en'],
};
export const EXAMPLE_ORIGIN = 'https://www.example.com';

/** A source page: its markup, and where it answers from when it redirects. */
export type SourceSite = (path: string) => { html: string; movedTo?: string } | null;

const sourcePage = (title: string, body: string) =>
  `<html><head><title>${title}</title><meta name="description" content="About ${title}."></head><body>${body}</body></html>`;

/**
 * The example sites' source: a home page whose footer has a newsletter form, whose hero image is
 * on a media host of its own and which embeds its layout data; `/services` sends visitors home;
 * every other page is plain copy.
 */
export const exampleSource: SourceSite = (path) => {
  if (path === '/services') return { html: exampleSource('/')!.html, movedTo: '/' };
  // No sitemap, no files: only pages answer.
  if (path.includes('.')) return null;
  if (path !== '/') return { html: sourcePage(`Page ${path}`, `<h1>${path}</h1><p>Copy.</p>`) };
  return {
    html: sourcePage(
      'Example Co',
      '<header><form role="search" action="/search"><input name="q"></form></header>' +
        '<h1>Welcome</h1><img src="https://cdn.example.com/site/media-1.jpg" alt="">' +
        '<footer><form id="newsletter" action="/subscribe"><input type="email" name="email"></form></footer>' +
        `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
          props: {
            layout: ['HeroBanner', 'RichText', 'Container'].map((componentName) => ({
              componentName,
            })),
          },
        })}</script>`,
    ),
  };
};

/** The demo's source: a homepage with a search box and a hero image on a media host of its own. */
export const demoSource: SourceSite = (path) =>
  path === '/'
    ? {
        html: sourcePage(
          'Example Co',
          '<header><form role="search" action="/search"><input name="q"></form></header>' +
            '<h1>Welcome</h1><img src="https://cdn.example.com/home/home-hero-background.webp" alt="">',
        ),
      }
    : null;

const fetcher = (site: SourceSite) =>
  (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const page = url.origin === EXAMPLE_ORIGIN ? site(url.pathname.replace(/(.)\/$/, '$1')) : null;
    const res = new Response(page?.html ?? '', { status: page ? 200 : 404 });
    Object.defineProperty(res, 'url', {
      value: page?.movedTo ? `${EXAMPLE_ORIGIN}${page.movedTo}` : String(input),
    });
    return res;
  }) as typeof fetch;

/** The page inventory Discovery would have written for a Blueprint's pages on the example source. */
export function exampleInventory(blueprint: Blueprint, over: Record<string, unknown> = {}) {
  const pages = (blueprint.collections.pages ?? []).filter((p) => p.status !== 'drop');
  const moved = pages.filter((p) => typeof p.attrs.redirect === 'string');
  const listed = pages.filter((p) => !moved.includes(p));
  return {
    origin: EXAMPLE_ORIGIN,
    crawl: {
      pagesFound: listed.length,
      pagesInventoried: listed.length,
      partial: false,
      sampling: 'every page the crawl and the sitemap found',
    },
    pages: listed.map((p) => ({
      path: String(p.attrs.path),
      title: p.attrs.path === '/' ? 'Example Co' : `Page ${String(p.attrs.path)}`,
      description:
        p.attrs.path === '/' ? 'About Example Co.' : `About Page ${String(p.attrs.path)}.`,
    })),
    forms: [{ id: 'newsletter', by: 'the site', pages: ['/'], fields: ['Email'] }],
    redirects: moved.map((p) => ({ from: String(p.attrs.path), to: String(p.attrs.redirect) })),
    layoutData: { pages: ['/'], components: ['HeroBanner', 'RichText', 'Container'] },
    mediaHosts: ['https://cdn.example.com/site/'],
    errorPage: {
      status: 404,
      title: 'Page not found',
      h1: 'Page not found',
      text: 'Try the home page.',
    },
    ...over,
  };
}

/**
 * Every check a step of the playbook names (`draft-blueprint` unless another is given), run on
 * these documents.
 */
export async function gateOne(
  playbookId: string,
  docs: { blueprint: unknown; inventory: unknown },
  source: SourceSite = exampleSource,
  step = 'draft-blueprint',
): Promise<{ named: string[]; rows: CheckRow[] }> {
  const playbook = await loadPlaybook(playbookDir(playbookId));
  const pack = createPlatforms({
    sitecore: SITECORE_DEFAULTS,
    optimizely: { ...OPTIMIZELY_DEFAULTS, fetch: fetcher(source) },
  }).get(playbook.manifest.platform)!;
  const store = new InMemoryEventStore();
  const library = new ArtifactLibrary(store, new MemoryBlobStore());
  const state = {
    ...createProjectState('p1'),
    playbook: { id: playbook.manifest.id, version: playbook.manifest.version },
    intake: { platform: playbook.manifest.platform, target: EXAMPLE_TARGET },
  };
  for (const [artifactId, content] of [
    ['blueprint', docs.blueprint],
    ['page-inventory', docs.inventory],
  ] as const)
    if (content)
      await library.write('p1', {
        artifactId,
        kind: artifactId === 'blueprint' ? 'blueprint' : 'inventory',
        title: artifactId,
        format: 'json',
        content: JSON.stringify(content),
        producer: 'solution-architect',
      });
  const run = selfCheck({
    store,
    projections: { catchUp: async () => {}, get: () => state } as unknown as Projections,
    playbook,
    library,
    platform: {
      checks: pack.checks,
      read: async () => ({ code: 404, body: { error: 'Not connected' } }),
      credential: async () => null,
    },
  });
  const rows = await run('p1', {
    taskId: step,
    templateId: step,
    acceptance: [],
    collection: null,
    itemKeys: [],
  });
  const named = playbook.plan.templates
    .find((t) => t.id === step)!
    .acceptance.map((a) => a.replace(/^validator:/, ''));
  return { named, rows };
}
