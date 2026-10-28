/**
 * Rendered parity, page by page, outside a project run: the same `parity.render` check the Lead
 * applies, against a live editing host and the source site.
 *
 *   pnpm --filter @lw/platforms exec tsx scripts/parity-report.ts \
 *     --host dycom-ansco-associates-sitecoreai-v2 --origin https://anscollc.com \
 *     --pages /,/about,/quality --lists CardGrid,StatsCounter,Accordion
 *
 * `--host` is the Vercel project (its editing host is <host>-editing.vercel.app); `--lists` names
 * the components whose model has child items.
 */
import { SITECORE_DEFAULTS } from '@lw/connectors';
import { createPlatforms } from '../src/index';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const host = arg('host');
const origin = arg('origin');
const pages = (arg('pages') ?? '/').split(',').filter(Boolean);
const lists = (arg('lists') ?? '').split(',').filter(Boolean);
if (!host || !origin) {
  console.error(
    'Usage: parity-report --host <vercel project> --origin <source site> [--pages /,/a] [--lists A,B]',
  );
  process.exit(2);
}

const check = createPlatforms({ sitecore: SITECORE_DEFAULTS }).get('sitecoreai')!.checks![
  'parity.render'
]!;
const ctx = {
  projectId: 'report',
  target: { cmHost: '', siteCollection: '', site: '', languages: ['en'], hostingProject: host },
  scope: { collection: null, items: [] },
  blueprint: {
    collections: {
      pages: pages.map((p) => ({ key: p, name: p, attrs: { path: p } })),
      components: lists.map((n) => ({
        key: n,
        name: n,
        attrs: { rendering: n, children: { max: 99 } },
      })),
    },
  },
  read: async () => ({ code: 404, body: {} }),
  credential: async () => null,
  document: async (id: string) => (id === 'page-inventory' ? { origin } : null),
};

// One page at a time, so each line says what that page lacks.
let failed = 0;
for (const page of pages) {
  const r = await check({
    ...ctx,
    blueprint: {
      collections: {
        ...ctx.blueprint.collections,
        pages: [{ key: page, name: page, attrs: { path: page } }],
      },
    },
  } as never);
  if (r.status === 'fail') failed++;
  console.log(
    `${r.status.toUpperCase().padEnd(7)} ${page}\n  ${r.detail.split('; ').join('\n  ')}`,
  );
}
process.exit(failed ? 1 : 0);
