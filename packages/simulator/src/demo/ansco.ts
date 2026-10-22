import { calls, doc, mono, table, when as whenAt } from './ansell';
import { fromPos } from './clock';
import type { BlueprintRowDef, DemoScenario, DemoTask, When } from './types';

/**
 * Ansco & Associates (Dycom): a Next.js 16 App Router site moving to SitecoreAI, at the end of
 * phase 2 with Gate 1 waiting on the Director. Transcribed from the Cypher Control Center
 * prototype.
 */

const TODAY = 1;
const DAYS: Record<string, number> = { Wed: 0, Thu: 1, Fri: 2 };
const when = (s: string): When => whenAt(s, TODAY, DAYS);
const today = (h: number): When => [TODAY, h];
const d = (day: number, h: number) => day + (h - 8) / 10;

const T = (
  id: string,
  agent: string,
  phase: number,
  title: string,
  start: number,
  end: number,
  state: DemoTask['state'],
  deps: string[],
  group: string,
  workstream?: DemoTask['workstream'],
): DemoTask => ({
  id,
  agent,
  phase,
  title,
  group,
  start: today(start),
  end: today(end),
  state,
  deps,
  ...(workstream !== undefined ? { workstream } : {}),
});

const E = (
  phase: number,
  id: string,
  agent: string,
  title: string,
  s: number,
  e: number,
  deps: string[] = [],
  state: DemoTask['state'] = 'planned',
): DemoTask => ({
  id,
  agent,
  phase,
  title,
  group: title,
  start: fromPos(s),
  end: fromPos(e),
  state,
  deps,
});

const TASKS: DemoTask[] = [
  E(
    0,
    'a0a',
    'tenant-provisioner',
    'Verify GitHub, SitecoreAI, Edge, Vercel and Postgres access',
    d(0, 9),
    d(0, 10),
    [],
    'done',
  ),
  E(
    1,
    'a1a',
    'repo-analyst',
    'Clone and build dycom-ansco-associates',
    d(0, 10),
    d(0, 11),
    ['a0a'],
    'done',
  ),
  E(
    1,
    'a1b',
    'repo-analyst',
    'Route, component and media inventory',
    d(0, 11),
    d(0, 15),
    ['a1a'],
    'done',
  ),
  E(
    1,
    'a1c',
    'content-analyst',
    'Content inventory from src/content',
    d(0, 12),
    d(0, 16),
    ['a0a'],
    'done',
  ),
  T(
    'd7',
    'repo-analyst',
    1,
    'Form and API route audit',
    8,
    9.5,
    'done',
    [],
    'Form and API route audit',
  ),
  T(
    'd8',
    'repo-analyst',
    2,
    'Legacy package and unused media audit',
    9.5,
    10.5,
    'done',
    [],
    'Discovery follow-ups',
  ),
  T(
    'd9',
    'content-analyst',
    2,
    'Spanish FAQ alignment check',
    10,
    11,
    'done',
    [],
    'Discovery follow-ups',
  ),
  T(
    'd1',
    'solution-architect',
    2,
    'Blueprint v1: component mapping',
    8,
    11,
    'done',
    [],
    'Draft Blueprint v1',
  ),
  T(
    'd2',
    'solution-architect',
    2,
    'Blueprint v1: page templates and designs',
    11,
    13,
    'done',
    ['d1'],
    'Draft Blueprint v1',
  ),
  T(
    'd3',
    'solution-architect',
    2,
    'Placeholder scheme for 2 page designs',
    13,
    14.75,
    'running',
    ['d2'],
    'Draft Blueprint v1',
  ),
  T(
    'd4',
    'solution-architect',
    2,
    'Finalize Blueprint v1 for Gate 1',
    14.75,
    15.5,
    'planned',
    ['d3'],
    'Draft Blueprint v1',
  ),
  T(
    'd5',
    'research-agent',
    2,
    'Platform Notes: Content SDK and App Router',
    9,
    11,
    'done',
    [],
    'Platform Notes',
  ),
  T(
    'd6',
    'research-agent',
    2,
    'Confirm the supported Next.js major',
    13.5,
    14.5,
    'running',
    ['d5'],
    'Platform Notes',
  ),
  T(
    'd10',
    'discovery-lead',
    2,
    'Review Blueprint v1',
    15.5,
    16.25,
    'planned',
    ['d4'],
    'Discovery Lead review and Gate 1',
  ),
  T(
    'g1',
    'chief-of-staff',
    2,
    'Gate 1: your approval',
    16.25,
    16.75,
    'waiting',
    ['d10'],
    'Discovery Lead review and Gate 1',
    'discovery',
  ),
  T(
    'e1',
    'tenant-provisioner',
    3,
    'Foundation dry run: site, en-US and es-US',
    12,
    13.5,
    'done',
    [],
    'Dycom collection, Ansco site, en-US and es-US',
  ),
  T(
    'e2',
    'tenant-provisioner',
    3,
    'Provision the Dycom collection and Ansco site',
    17,
    18.5,
    'waiting',
    ['g1'],
    'Dycom collection, Ansco site, en-US and es-US',
  ),
  T(
    'e3',
    'head-integrator',
    3,
    'Scaffold the Content SDK head from the Next.js app',
    17,
    19.5,
    'planned',
    ['g1'],
    'Content SDK head from the existing Next.js app',
  ),
  T(
    'e4',
    'deployment-engineer',
    3,
    'Vercel project and environment',
    17,
    18,
    'planned',
    ['g1'],
    'Vercel project, environment and DATABASE_URL',
  ),
  T(
    'q1',
    'structural-validator',
    3,
    'Foundation conformance check',
    18.5,
    19,
    'planned',
    ['e2'],
    'Foundation conformance check',
  ),
  E(
    4,
    'a4a',
    'component-engineer',
    'Batch 1: hero, intro, panels, tiles, service cards',
    d(3, 8),
    d(3, 14),
    ['q1'],
  ),
  E(
    4,
    'a4b',
    'component-engineer',
    'Batch 2: FAQ, counters, read more, video, benefits',
    d(3, 14),
    d(4, 11),
    ['a4a'],
  ),
  E(
    4,
    'a4c',
    'component-engineer',
    'Batch 3: locations, job search, two forms',
    d(4, 11),
    d(4, 18),
    ['a4b'],
  ),
  E(4, 'a4d', 'rendering-registrar', 'Register and validate each batch', d(3, 10), d(4, 18), [
    'a4a',
  ]),
  E(5, 'a5a', 'layout-engineer', '7 page templates and data templates', d(3, 8), d(3, 16), ['q1']),
  E(5, 'a5b', 'layout-engineer', '2 page designs and 2 footer partials', d(3, 16), d(4, 12), [
    'a5a',
  ]),
  E(6, 'a6a', 'content-migrator', 'Create 15 pages', d(5, 8), d(5, 14), ['a4c', 'a5b']),
  E(
    6,
    'a6b',
    'content-migrator',
    '50 locations, 13 FAQ entries in two languages',
    d(5, 14),
    d(6, 10),
    ['a6a'],
  ),
  E(6, 'a6c', 'media-migrator', 'Upload 90 images', d(5, 8), d(5, 16), ['a4c']),
  E(6, 'a6d', 'parity-auditor', 'Parity audit and visual diff', d(6, 10), d(6, 16), ['a6b']),
  E(7, 'a7a', 'experience-enabler', '301 map for WordPress-era URLs', d(7, 8), d(7, 12), ['a6d']),
  E(7, 'a7b', 'experience-enabler', 'A/B test on the careers hero', d(7, 12), d(7, 15), ['a7a']),
  E(7, 'a7c', 'experience-enabler', 'SEO fields, 404 and 500 pages', d(7, 8), d(7, 17), ['a6d']),
  E(8, 'a8a', 'deployment-engineer', 'Production head on Vercel', d(8, 8), d(8, 12), ['a7c']),
  E(8, 'a8b', 'deployment-engineer', 'Editing host, publish to Edge', d(8, 12), d(8, 15), ['a8a']),
  E(8, 'a8c', 'editor-experience-qa', 'Form submissions reach Postgres', d(8, 15), d(8, 18), [
    'a8b',
  ]),
  E(9, 'a9a', 'perf-a11y-qa', 'Lighthouse and axe on 7 templates', d(9, 8), d(9, 13), ['a8b']),
  E(9, 'a9b', 'editor-experience-qa', 'Editor experience QA, full pass', d(9, 8), d(10, 12), [
    'a8c',
  ]),
  E(9, 'a9c', 'chief-of-staff', 'Acceptance Report and Gate 2', d(10, 12), d(10, 17), [
    'a9a',
    'a9b',
  ]),
  E(10, 'a10a', 'handover-writer', 'Runbook, component catalog, known gaps', d(11, 8), d(11, 16), [
    'a9c',
  ]),
];

const ROWS: [string, string, string, string, string, string, string, string?, string?][] = [
  [
    '1:58 PM',
    'solution-architect',
    'Blackboard',
    'write Blueprint v1 / page designs: Corporate, Careers',
    'ok',
    '90 ms',
    '3.1k',
  ],
  [
    '1:52 PM',
    'research-agent',
    'Docs',
    'Content SDK release notes: supported Next.js versions',
    '200',
    '2.4 s',
    '5.2k',
  ],
  ['1:45 PM', 'chief-of-staff', 'Planner', 'hold foundation tasks until Gate 1', 'ok', '–', '1.1k'],
  [
    '1:40 PM',
    'discovery-lead',
    'Review',
    'accept page template mapping (7 templates)',
    'ok',
    '–',
    '4.8k',
  ],
  [
    '1:25 PM',
    'tenant-provisioner',
    'Sitecore CLI',
    'ser validate (module: ansco), dry run',
    '0',
    '14 s',
    '0.6k',
  ],
  [
    '12:44 PM',
    'solution-architect',
    'Blackboard',
    'write Blueprint v1 / 18 renderings',
    'ok',
    '110 ms',
    '6.4k',
  ],
  [
    '11:10 AM',
    'discovery-lead',
    'Review',
    'reject FaqAccordion (Spanish handled as a separate page)',
    'reject',
    '–',
    '3.9k',
    'warn',
    'Raised as a decision: Spanish as a language version or a separate page.',
  ],
  [
    '10:40 AM',
    'content-analyst',
    'Sandbox',
    'diff faq.tsx and faq-es.tsx: 13 matched pairs',
    '0',
    '1.1 s',
    '2.2k',
  ],
  [
    '9:20 AM',
    'repo-analyst',
    'Sandbox',
    'trace imports of lib/api-client-react and artifacts/api-server',
    '0',
    '4 s',
    '1.7k',
  ],
  [
    '8:35 AM',
    'repo-analyst',
    'Sandbox',
    'read app/api/contact and subcontractor-request route handlers',
    '0',
    '1.2 s',
    '2.0k',
  ],
  [
    'Wed 10:12 AM',
    'repo-analyst',
    'Sandbox',
    'pnpm install --frozen-lockfile, next build',
    '0',
    '1 m 22 s',
    '0.4k',
  ],
  [
    'Wed 9:05 AM',
    'tool-server',
    'Vault',
    'verify DATABASE_URL',
    'not provided',
    '–',
    '–',
    'warn',
    'The repository excludes credentials. Forms need a database on preview.',
  ],
];

const AGENT_CALLS: [string, string, string, string, string, string][] = [
  ['chief-of-staff', '9:00 AM', 'Planner', 'open phase 2, Blueprint', 'ok', '0.6s'],
  [
    'discovery-lead',
    '11:10 AM',
    'Review',
    'reject FaqAccordion (Spanish handled as a page)',
    'reject',
    '–',
  ],
  [
    'repo-analyst',
    'Wed 10:04 AM',
    'GitHub',
    'clone slamensdicreon/dycom-ansco-associates (243 files, 31 MB)',
    '200',
    '3.6s',
  ],
  ['content-analyst', 'Wed 1:30 PM', 'Sandbox', 'evaluate src/content (9 modules)', '0', '2.9s'],
  ['research-agent', '10:05 AM', 'Docs', 'Content SDK: App Router support', '200', '2.0s'],
];

const BP: BlueprintRowDef[] = [
  {
    key: 'hero-banner',
    src: 'Banner.tsx, BackgroundVideo.tsx',
    target: 'HeroBanner',
    fields: 'Title, Lead, Image, Vimeo URL, CTA',
    params: 'Height',
    ph: '–',
    variants: 'Home, Compact',
    status: 'planned',
  },
  {
    key: 'section-intro',
    src: 'Blocks.tsx (SectionIntro)',
    target: 'SectionIntro',
    fields: 'Title, Body',
    params: 'Heading level',
    ph: '–',
    variants: 'Default',
    status: 'planned',
  },
  {
    key: 'icon-tiles',
    src: '(corporate)/page.tsx (whatWeDo)',
    target: 'IconTiles',
    fields: 'Title, Body, tiles from Data/Tiles (4)',
    params: '–',
    ph: '–',
    variants: 'Default',
    status: 'planned',
  },
  {
    key: 'promo-panel',
    src: 'Blocks.tsx (Panel)',
    target: 'PromoPanel',
    fields: 'Image, Title, Text, Link',
    params: '–',
    ph: '–',
    variants: 'Default, Tall',
    status: 'planned',
  },
  {
    key: 'service-cards',
    src: '(corporate)/page.tsx (services)',
    target: 'ServiceCards',
    fields: 'Title, Body, services from Data/Services',
    params: 'Columns',
    ph: '–',
    variants: 'Default',
    status: 'planned',
  },
  {
    key: 'contact-block',
    src: '(corporate)/page.tsx (contact)',
    target: 'ContactBlock',
    fields: 'Image, Title, Text. Company details from site settings',
    params: '–',
    ph: '–',
    variants: 'Default',
    status: 'planned',
  },
  {
    key: 'fancy-box',
    src: 'Blocks.tsx (FancyBox, VideoEmbed, TalentNetworkCta)',
    target: 'FancyBox, VideoEmbed, TalentNetworkCta',
    fields: 'Image, Title, Description, Link. Vimeo URL',
    params: '–',
    ph: '–',
    variants: 'Default',
    status: 'planned',
  },
  {
    key: 'counter-band',
    src: 'Interactive.tsx (Counter, ReadMore)',
    target: 'CounterBand, ReadMore',
    fields: 'Counters: value, label. Preview and body',
    params: '–',
    ph: '–',
    variants: 'Default',
    status: 'planned',
  },
  {
    key: 'faq-accordion',
    src: 'FaqView.tsx, Interactive.tsx (Accordion), faq.tsx, faq-es.tsx',
    target: 'FaqAccordion',
    fields: 'Title, entries from Data/FAQ (13)',
    params: '–',
    ph: '–',
    variants: 'Default',
    status: 'planned',
    was: 'Spanish kept as a separate page at /faq-es/. Open decision',
  },
  {
    key: 'job-search',
    src: 'Interactive.tsx (JobSearchForm)',
    target: 'JobSearch',
    fields: 'Search URL (SAP SuccessFactors), labels',
    params: '–',
    ph: '–',
    variants: 'Default',
    status: 'planned',
  },
  {
    key: 'benefits-carousel',
    src: 'BenefitsCarousel.tsx',
    target: 'BenefitsCarousel',
    fields: 'Label, benefits from Data/Benefits',
    params: '–',
    ph: '–',
    variants: 'Default',
    status: 'planned',
  },
  {
    key: 'locations-grid',
    src: 'LocationsGrid.tsx, content/contact.ts',
    target: 'LocationsGrid',
    fields: '50 locations from Data/Locations',
    params: 'Region filter',
    ph: '–',
    variants: 'Default',
    status: 'planned',
  },
  {
    key: 'contact-form',
    src: 'ContactForm.tsx, app/api/contact',
    target: 'ContactForm',
    fields: 'Labels, subjects, consent text. Submission stays a route handler',
    params: '–',
    ph: '–',
    variants: 'Default',
    status: 'planned',
    was: 'Destination open. Decision pending',
  },
  {
    key: 'subcontractor-form',
    src: 'SubcontractorForm.tsx, app/api/subcontractor-request',
    target: 'SubcontractorForm',
    fields: 'Labels, trade list, consent text. Submission stays a route handler',
    params: '–',
    ph: '–',
    variants: 'Default',
    status: 'planned',
  },
  {
    key: 'rich-text-legal',
    src: 'content/privacy.ts (502 lines)',
    target: 'RichText (legal)',
    fields: 'Title, Body',
    params: '–',
    ph: '–',
    variants: 'Default',
    status: 'planned',
  },
  {
    key: 'global-header',
    src: 'SiteHeader.tsx, content/site.ts',
    target: 'GlobalHeader (partial design)',
    fields: 'Logo, nav from the site tree, phone',
    params: 'Sticky',
    ph: 'header',
    variants: 'Default',
    status: 'planned',
  },
  {
    key: 'footers',
    src: 'SiteFooter.tsx (default, careers), SocialIcons.tsx',
    target: 'CorporateFooter, CareersFooter (partial designs)',
    fields: 'Columns, social links, legal, EEO links',
    params: '–',
    ph: 'footer',
    variants: 'Corporate, Careers',
    status: 'planned',
  },
  {
    key: 'form-libraries',
    src: 'lib/db, lib/api-zod',
    target: 'Kept in the head: schema and validation for the two forms',
    fields: '–',
    params: '–',
    ph: '–',
    variants: '–',
    status: 'merged',
  },
  {
    key: 'legacy-packages',
    src: 'artifacts/api-server, lib/api-client-react, lib/api-spec',
    target: 'Excluded: legacy Express server and a generated client the site never imports',
    fields: '–',
    params: '–',
    ph: '–',
    variants: '–',
    status: 'dropped',
  },
];

const PAGES = [
  ['Home', '/', 'Home', 'Corporate'],
  ['Safety', '/safety/', 'Content page', 'Corporate'],
  ['Quality', '/quality/', 'Content page', 'Corporate'],
  ['About Us', '/about/', 'Content page', 'Corporate'],
  ['Locations', '/contact/locations/', 'Locations', 'Corporate'],
  ['Contact', '/contact/', 'Form page', 'Corporate'],
  ['FAQ', '/faq/', 'FAQ', 'Corporate'],
  ['FAQ (Spanish)', '/faq-es/', 'FAQ, es-US version', 'Corporate'],
  ['Subcontractors', '/subcontractors/', 'Content page', 'Corporate'],
  ['Subcontractor request', '/subcontractor-request/', 'Form page', 'Corporate'],
  ['Privacy policy', '/privacy-policy/', 'Legal', 'Corporate'],
  ['Careers', '/careers/', 'Careers landing', 'Careers'],
  ['Benefits', '/benefits/', 'Careers content', 'Careers'],
  ['Life@Ansco', '/life/', 'Careers content', 'Careers'],
  ['Opportunities', '/opportunities/', 'Careers content', 'Careers'],
] as const;

const pageKey = (path: string) => path.replace(/^\/|\/$/g, '').replace(/\//g, '-') || 'home';

const INV_ROUTES = doc(
  'Repo Analyst, Wed',
  '15 routes in two App Router route groups. Each group has its own layout and footer, which become two page designs.',
  [
    table(
      ['Route', 'Page', 'Template', 'Page design'],
      PAGES.map(([name, path, tpl, layout]) => [mono(path), name, tpl, layout]),
    ),
    {
      type: 'note',
      text: 'Plus a not-found page and three API routes: /api/contact/, /api/subcontractor-request/ and /api/healthz/. trailingSlash is on in next.config.ts, so every URL matches the WordPress site.',
    },
  ],
);

const INV_CONTENT = doc(
  'Content Analyst, Wed',
  'Content lives in 9 typed modules under src/content, edited in code today.',
  [
    table(
      ['Content', 'Module', 'Items', 'Becomes'],
      [
        ['Locations', mono('contact.ts'), '50', 'Location data items'],
        ['FAQ, English', mono('faq.tsx'), '13', 'FAQ entries'],
        [
          'FAQ, Spanish',
          mono('faq-es.tsx'),
          '13',
          'es-US versions of the same entries, if D-06 lands on A',
        ],
        [
          'Home, About, Safety, Quality, Subcontractors',
          mono('corporate.ts'),
          '5',
          'Page items and their datasources',
        ],
        [
          'Careers, Benefits, Life, Opportunities',
          mono('careers.ts'),
          '4',
          'Page items and their datasources',
        ],
        [
          'Navigation, company details, external links',
          mono('site.ts'),
          '1',
          'Site settings and the site tree',
        ],
        ['Privacy policy', mono('privacy.ts'), '1', 'One rich text field, 502 lines of source'],
        [
          'Form copy',
          mono('subcontractor-request.ts, contact.ts'),
          '2',
          'Form rendering datasources',
        ],
      ],
      [2],
    ),
    {
      type: 'note',
      text: 'External destinations stay external: SAP SuccessFactors job search, social profiles, EEO and benefit disclosure links, two PDFs on the legacy WordPress CDN. The PDFs are flagged for upload so they survive the WordPress shutdown.',
    },
  ],
);

const INV_MEDIA = doc(
  'Repo Analyst, Wed',
  '128 images, 30 MB, in public/assets. 90 are referenced and migrate. 38 are never referenced and are excluded (D-05).',
  [
    {
      type: 'images',
      layout: 'gallery',
      items: ['hero', 'who', 'careers', 'subs', 'contact', 'bucket'].map((k) => ({
        ref: `image:${k}`,
        caption: '',
      })),
    },
    table(
      ['Files', 'Count', 'Status'],
      [
        ['Photos (jpg, jpeg, webp)', '85', 'Referenced, migrate with alt text'],
        ['Icons and logos (png, svg)', '13', 'Referenced, migrate'],
        ['Unreferenced images', '38', 'Excluded'],
        ['Vimeo videos', '6', 'Stay on Vimeo, URLs become fields'],
      ],
      [1],
    ),
  ],
);

const FORMS = doc(
  'Repo Analyst, Thu',
  'Two forms post to Next.js route handlers, which validate with lib/api-zod and write to Postgres.',
  [
    table(
      ['Form', 'Route handler', 'Writes to', 'Protection'],
      [
        [
          'Contact',
          mono('app/api/contact/route.ts'),
          mono('contact_inquiries'),
          '32 KB body limit, per-instance rate limit',
        ],
        [
          'Subcontractor request',
          mono('app/api/subcontractor-request/route.ts'),
          mono('contact_inquiries'),
          'Same',
        ],
      ],
    ),
    {
      type: 'paragraph',
      text: "The Content SDK head is also a Next.js app, so both route handlers can stay as they are. The form fields and labels move into Sitecore so marketers can edit the copy. Two gaps carry forward: DATABASE_URL is not in the repository, and the code's own comment asks for a firewall rate limit on Vercel before public launch.",
    },
    {
      type: 'note',
      text: 'Not used by the site: artifacts/api-server (an Express copy of the same endpoints) and lib/api-client-react (a generated client). Both are excluded (D-04).',
    },
  ],
);

const NOTES = doc('Research Agent, in progress. Final at 2:30 PM.', null, [
  table(
    ['Fact', 'Value', 'Source'],
    [
      [
        'Source framework',
        'Next.js 16, App Router, React 19, CSS Modules, pnpm workspace, Node 22',
        'package.json',
      ],
      [
        'Target head',
        'Content SDK for Next.js. The supported Next.js major is being confirmed against the pinned version',
        'Sitecore docs, in progress',
      ],
      [
        'Routing',
        '15 static routes become Sitecore pages served through one catch-all route in the head',
        'Blueprint v1',
      ],
      [
        'Languages',
        'en-US. es-US only if the Spanish FAQ becomes a language version',
        'faq-es.tsx',
      ],
      ['Video', '6 Vimeo embeds, background and inline', 'src'],
      ['Repository size', '31 MB, under the 500 MB SitecoreAI deploy limit', 'Measured'],
    ],
  ),
]);

const FAQ_OPTS = [
  'Make the Spanish FAQ an es-US language version of the FAQ page',
  'Keep /faq-es/ as a separate page in the English tree',
  'Drop the Spanish page',
];
const FORM_OPTS = [
  'Keep both route handlers and Postgres in the head. Labels and copy come from Sitecore',
  'Move both forms to SitecoreAI Forms',
  'Leave forms out of this release',
];

export const ansco: DemoScenario = {
  id: 'ansco',
  name: 'Ansco & Associates',
  client: 'Dycom',
  initials: 'AC',
  subtitle: 'Dycom, Next.js to SitecoreAI',
  timezone: 'America/New_York',
  fixtures: 'ansco',
  source: {
    repo: 'slamensdicreon/dycom-ansco-associates',
    url: null,
    framework: 'Next.js 16, React 19',
    label: 'Next.js build of dycom-ansco-associates',
  },
  target: { collection: 'Dycom', site: 'anscollc.com', hosting: 'Vercel, ansco' },
  budgets: { usd: 1400, tokens: 9_000_000, hours: 240 },
  spent: { usd: 96, tokens: 900_000 },
  started: [0, 9],
  present: [TODAY, 14 + 2 / 60],
  phases: [
    { number: 0, entered: [0, 9], exited: [0, 10] },
    { number: 1, entered: [0, 10], exited: [1, 9.5] },
    { number: 2, entered: [1, 9] },
  ],
  stats: [
    {
      metric: 'components_registered',
      label: 'Renderings',
      icon: 'application',
      note: 'Mapped in Blueprint v1, none built yet',
    },
    {
      metric: 'pages_migrated',
      label: 'Pages',
      icon: 'document',
      note: '15 routes, 2 page designs',
    },
    { metric: 'media_uploaded', label: 'Media', icon: 'image', note: '38 unused images excluded' },
    {
      metric: 'source_mapped',
      label: 'Source mapped',
      icon: 'task--complete',
      note: 'Files mapped in Blueprint v1',
    },
  ],
  metrics: {
    components_registered: [0, 18],
    pages_migrated: [0, 15],
    media_uploaded: [0, 90],
    source_mapped: [52, 54],
    parity: [null, null],
  },
  agents: {
    'chief-of-staff': {
      state: 'active',
      now: 'Preparing your Gate 1 brief',
      tokens: 72_000,
      note: 'Owns the plan, status, escalations, decision log and budget. Writes no code, creates no items.',
    },
    'discovery-lead': {
      state: 'active',
      now: 'Reviewing Blueprint v1 before it reaches you',
      tokens: 188_000,
    },
    'engineering-lead': { state: 'idle', now: 'Activates in phase 3, after Gate 1' },
    'content-lead': { state: 'idle', now: 'Activates in phase 6' },
    'quality-lead': { state: 'idle', now: 'Activates in phase 3, after Gate 1' },
    'repo-analyst': {
      state: 'done',
      now: 'Inventories complete',
      tokens: 214_000,
      note: 'Parses the source app: routes, components, form handlers, dependencies, media.',
    },
    'content-analyst': {
      state: 'done',
      now: 'Inventory complete. Re-reads src/content in phase 6',
      tokens: 156_000,
      note: 'Extracts the content inventory from the typed content modules in src/content. Re-reads them for parity in phase 6.',
    },
    'research-agent': {
      state: 'active',
      now: 'Confirming which Next.js major the pinned Content SDK supports',
      tokens: 61_000,
    },
    'solution-architect': {
      state: 'active',
      now: 'Blueprint v1: placeholder scheme for two page designs (step 4 of 5)',
      tokens: 302_000,
    },
    'tenant-provisioner': {
      state: 'waiting',
      now: 'Foundation dry run passed. Waits for Gate 1',
      tokens: 22_000,
    },
    'component-engineer': {
      note: 'Carries the existing Next.js components into the Content SDK head and registers them in the component map.',
    },
    'head-integrator': {
      note: 'Owns the Content SDK head built from the existing Next.js 16 app: sitecore.config.ts, middleware, editing host, the two form route handlers and their Postgres connection.',
    },
    'content-migrator': {
      note: 'Creates the 15 pages, 50 locations, 13 FAQ entries in English and Spanish, and the privacy policy.',
    },
    'media-migrator': {
      note: 'Uploads the 90 images in use with alt text. Skips the 38 unused images. Vimeo stays external.',
    },
    'experience-enabler': {
      note: 'Personalization and A/B/n readiness, the 301 map for WordPress-era URLs, and the Spanish language switch.',
    },
    'visual-qa': {
      note: 'Screenshot-diffs the Next.js build against the Sitecore build at three breakpoints.',
    },
    'parity-auditor': {
      note: 'Diffs text, links and media between the Next.js build and the Sitecore build.',
    },
  },
  tasks: TASKS,
  calls: calls(ROWS, AGENT_CALLS, when),
  messages: [
    {
      at: when('Wed 5:10 PM'),
      brief: 'Discovery summary: dycom-ansco-associates',
      lines: [
        'The source is Next.js 16 App Router with React 19 and CSS Modules. The pages carry over into the Content SDK head instead of a rebuild (D-01).',
        '15 routes in two route groups, corporate and careers, each with its own layout and footer.',
        'Content lives in typed modules: 50 locations, 13 FAQ entries with a Spanish twin page, careers content, and a 502-line privacy policy.',
        'Two forms write to Postgres through route handlers. DATABASE_URL is not in the repository.',
        'Media: 128 images, 30 MB. 38 are never referenced and are excluded. Video comes from 6 Vimeo embeds.',
      ],
      note: 'URLs keep their trailing slash, matching the WordPress site, so the redirect map stays small.',
      links: [
        ['Route inventory', 'wb:invRoutes'],
        ['Content inventory', 'wb:invContent'],
        ['Media inventory', 'wb:invMedia'],
      ],
    },
    {
      at: when('9:00 AM'),
      brief: 'Phase 2 brief: Blueprint',
      lines: [
        'Produces: Blueprint v1, mapping 52 of 54 source files to renderings, templates and data items.',
        'Activates: Solution Architect, Research Agent, Discovery Lead.',
        'Exit: you approve Blueprint v1 at Gate 1. Nothing is created on the tenant before then.',
      ],
      note: 'Expect two decisions: the Spanish FAQ and where form submissions go.',
      links: [
        ['Open plan', 'plan'],
        ['Open team', 'team'],
      ],
    },
    {
      at: when('1:45 PM'),
      text: 'Blueprint v1 is ready for your review. 18 renderings, 7 page templates, 2 page designs and 2 footer partials cover all 15 routes. The Gate 1 card is above. The foundation tasks are queued behind it.',
      links: [
        ['Open Blueprint', 'wb:blueprint'],
        ['Site preview', 'preview'],
      ],
    },
  ],
  decisions: [
    {
      ref: 'D-01',
      q: 'The source is already Next.js 16 App Router',
      a: 'Carry the pages into the Content SDK head as Sitecore-driven routes. No rebuild',
      by: 'Director',
      at: when('Wed 11:50 AM'),
    },
    {
      ref: 'D-02',
      q: 'URLs',
      a: 'Keep every WordPress-era URL with its trailing slash',
      by: 'Director',
      at: when('Wed 11:52 AM'),
    },
    {
      ref: 'D-03',
      q: 'Source of truth for content',
      a: 'The repository content modules in src/content',
      by: 'Director',
      at: [0, 11 + 52.5 / 60],
    },
    {
      ref: 'D-04',
      q: 'Legacy packages',
      a: 'Exclude artifacts/api-server, lib/api-client-react and lib/api-spec. The site never imports them',
      by: 'Cypher (convention)',
      at: when('9:30 AM'),
    },
    {
      ref: 'D-05',
      q: 'Unused media',
      a: 'Exclude the 38 images no page or component references',
      by: 'Cypher (convention)',
      at: when('9:32 AM'),
    },
  ],
  blueprint: { v1: BP, producedAt: when('12:44 PM') },
  artifacts: [
    {
      id: 'invRoutes',
      kind: 'inventory',
      title: 'Route inventory',
      short: 'Routes',
      producer: 'repo-analyst',
      at: when('Wed 3:00 PM'),
      doc: INV_ROUTES,
    },
    {
      id: 'invContent',
      kind: 'inventory',
      title: 'Content inventory',
      short: 'Content',
      producer: 'content-analyst',
      at: when('Wed 4:00 PM'),
      doc: INV_CONTENT,
    },
    {
      id: 'invMedia',
      kind: 'inventory',
      title: 'Media inventory',
      short: 'Media',
      producer: 'repo-analyst',
      at: when('Wed 3:00 PM'),
      doc: INV_MEDIA,
    },
    {
      id: 'forms',
      kind: 'report',
      title: 'Form and API audit',
      short: 'Forms and API',
      producer: 'repo-analyst',
      at: when('9:30 AM'),
      doc: FORMS,
    },
    {
      id: 'notes',
      kind: 'platform_notes',
      title: 'Platform Notes',
      short: 'Platform Notes',
      producer: 'research-agent',
      at: when('11:00 AM'),
      doc: NOTES,
    },
  ],
  pages: PAGES.map(([name, path, template, layout]) => ({
    key: pageKey(path),
    name,
    path,
    template,
    layout,
  })),
  preview: { source: 'Next.js build of dycom-ansco-associates', target: 'SitecoreAI' },
  credentials: [
    {
      sys: 'GitHub',
      scope: 'repo slamensdicreon/dycom-ansco-associates (read), branch write: launchworks/*',
      verified: [TODAY, 9 + 2 / 60],
    },
    {
      sys: 'SitecoreAI Automation client',
      scope: 'xmcloud.cm:admin, xmclouddeploy.*',
      verified: [TODAY, 9 + 2 / 60],
      expiresDays: 29,
    },
    {
      sys: 'Experience Edge',
      scope: 'context ID (delivery, preview)',
      verified: [TODAY, 9 + 2 / 60],
    },
    { sys: 'Vercel', scope: 'project: ansco (deploy, env)', verified: [TODAY, 9 + 2 / 60] },
    { sys: 'Postgres (forms)', scope: 'DATABASE_URL for contact_inquiries', verified: null },
  ],
  conventions: [
    ['Head', 'Content SDK Next.js, from the existing Next.js 16 app'],
    ['Naming', 'PascalCase renderings, kebab-case files'],
    ['Grid', 'CSS Modules carried over, no utility framework'],
    ['Languages', 'en-US, es-US (pending D-06)'],
    ['Source of truth', 'Repository (dycom-ansco-associates)'],
    ['URLs', 'Trailing slash kept, matching the WordPress site'],
    ['Head hosting', 'Vercel, project ansco'],
  ],
  settings: { pilotReview: true, publishReview: false },
  live: {
    nowLines: {
      'solution-architect': [
        'Blueprint v1: placeholder scheme for two page designs (step 4 of 5)',
        'Blueprint v1: datasource locations for 50 locations (step 4 of 5)',
        'Blueprint v1: footer partial variants (step 5 of 5)',
      ],
      'research-agent': [
        'Confirming which Next.js major the pinned Content SDK supports',
        'Platform Notes: Vimeo embeds and editing host CSP',
        'Platform Notes: es-US language fallback',
      ],
      'discovery-lead': [
        'Reviewing Blueprint v1 before it reaches you',
        'Checking every route has a template',
        'Checking every content module has a data template',
      ],
    },
    ops: [
      [
        'solution-architect',
        'Blackboard',
        'write Blueprint v1 / Data/Locations template',
        'ok',
        '80 ms',
        '2.2k',
      ],
      ['research-agent', 'Docs', 'Content SDK: editing host behind Vercel', '200', '2.1 s', '4.0k'],
      ['discovery-lead', 'Review', 'accept route coverage: 15 of 15', 'ok', '–', '3.3k'],
      [
        'solution-architect',
        'Blackboard',
        'write Blueprint v1 / FaqAccordion language note',
        'ok',
        '70 ms',
        '1.4k',
      ],
      [
        'research-agent',
        'Docs',
        'Experience Edge: es-US language fallback',
        '200',
        '1.8 s',
        '3.1k',
      ],
    ],
  },
  escalations: {
    'E-11': () => ({
      id: 'E-11',
      type: 'gate',
      typeLabel: 'Gate 1',
      title: 'Approve Blueprint v1',
      reversible: false,
      waitNote: 'Waits for you. Foundation starts when you approve.',
      context:
        '18 renderings, 7 page templates, 2 page designs and 2 footer partials cover all 15 routes. 52 of 54 source files are mapped. Two questions stay open: the Spanish FAQ and where form submissions go.',
      impact:
        'Foundation, the head scaffold and hosting start when you approve. Nothing is created on the tenant before then.',
      evidence: [
        { label: 'Blueprint v1', go: 'wb:blueprint' },
        { label: 'Route inventory', go: 'wb:invRoutes' },
        { label: 'Form and API audit', go: 'wb:forms' },
      ],
      gate: { phase: 2, artifactId: 'blueprint', version: 1 },
      onApprove: async (p) => {
        await p.decide('Gate 1: Blueprint v1', 'Approved', 'director', 'gate-1');
        await p.exitPhase(2);
        await p.enterPhase(3);
        await p.setAgent('solution-architect', {
          state: 'idle',
          now: 'Blueprint approved. Consulted in phases 4 and 5',
        });
        await p.setAgent('discovery-lead', { state: 'done', now: 'Workstream complete' });
        await p.setAgent('research-agent', { state: 'done', now: 'Platform Notes final' });
        await p.setAgent('engineering-lead', {
          state: 'active',
          now: 'Dispatching foundation tasks',
        });
        await p.setAgent('quality-lead', {
          state: 'active',
          now: 'Preparing the foundation check',
        });
        await p.setAgent('tenant-provisioner', {
          state: 'active',
          now: 'Creating the Dycom collection and the Ansco site (step 1 of 4)',
        });
        await p.setAgent('head-integrator', {
          state: 'active',
          now: 'Scaffolding the Content SDK head from the Next.js app (step 1 of 5)',
        });
        await p.setAgent('deployment-engineer', {
          state: 'active',
          now: 'Creating the Vercel environment',
        });
        for (const id of ['d3', 'd4', 'd6', 'd10', 'g1']) await p.moveTask(id, 'done');
        for (const id of ['e2', 'e3', 'e4']) await p.moveTask(id, 'running');
        p.think(1100, () =>
          p.say(
            'Gate 1 approved and logged. Foundation starts now. The Tenant Provisioner is creating the site, the Head Integrator is scaffolding the Content SDK head from the existing Next.js app, and the Deployment Engineer is setting up Vercel.',
            {
              links: [
                { label: 'Open plan', target: { kind: 'surface', ref: 'plan' } },
                { label: 'Open team', target: { kind: 'surface', ref: 'team' } },
              ],
            },
          ),
        );
      },
      onSendBack: async (p, notes) => {
        await p.setAgent('solution-architect', {
          state: 'active',
          now: 'Revising Blueprint v1 against your notes',
        });
        p.think(1100, () =>
          p.say(
            `Noted: “${notes}”. Blueprint v1 goes back to the Solution Architect. Foundation stays on hold until you approve v2.`,
          ),
        );
      },
    }),
    'E-12': () => ({
      id: 'E-12',
      type: 'decision',
      title: 'Spanish FAQ: language version or separate page',
      reversible: true,
      context:
        'faq-es.tsx is a Spanish copy of the FAQ at its own URL. The Content Analyst matched all 13 entries one to one. In Sitecore it can be a language version of the same items or a separate page.',
      impact:
        'Decides whether the site gets an es-US language and how marketers edit the Spanish copy. Blueprint v1 cannot close without it.',
      options: [
        { label: FAQ_OPTS[0]!, rec: true },
        { label: FAQ_OPTS[1]! },
        { label: FAQ_OPTS[2]! },
      ],
      defaultIdx: 0,
      deadlineMinutes: 25,
      evidence: [
        { label: 'Content inventory', go: 'wb:invContent' },
        { label: 'Blueprint, FAQ row', go: 'wb:blueprint' },
      ],
      onResolve: async (p, i, by) => {
        await p.reviseBlueprint((rows) =>
          rows.map((r) =>
            r.key === 'faq-accordion'
              ? {
                  ...r,
                  fields:
                    i === 0
                      ? 'Title, entries from Data/FAQ (13), en-US and es-US versions'
                      : i === 1
                        ? 'Title, entries from Data/FAQ (13) and Data/FAQ-ES (13)'
                        : 'Title, entries from Data/FAQ (13)',
                }
              : r,
          ),
        );
        const ref = await p.decide(
          'Spanish FAQ',
          FAQ_OPTS[i]!,
          by === 'default' ? 'default' : 'director',
          'blueprint:faq-accordion',
        );
        p.think(1200, () =>
          p.say(
            `Logged as ${ref}: ${FAQ_OPTS[i]}. Blueprint v1 updated. ${i === 0 ? '/faq-es/ will redirect to the Spanish version of /faq/.' : ''}`.trim(),
          ),
        );
      },
    }),
    'E-13': () => ({
      id: 'E-13',
      type: 'decision',
      title: 'Where form submissions go',
      reversible: true,
      context:
        'The contact and subcontractor forms post to Next.js route handlers that validate with zod and write to Postgres. The Content SDK head is also Next.js, so the handlers can stay.',
      impact:
        'Option A keeps working code and moves only the copy into Sitecore. Option B rebuilds both forms and changes where submissions are stored.',
      options: [
        { label: FORM_OPTS[0]!, rec: true },
        { label: FORM_OPTS[1]! },
        { label: FORM_OPTS[2]! },
      ],
      defaultIdx: 0,
      deadlineMinutes: 20,
      evidence: [
        { label: 'Form and API audit', go: 'wb:forms' },
        { label: 'Blueprint, form rows', go: 'wb:blueprint' },
      ],
      onResolve: async (p, i, by) => {
        await p.decide(
          'Form submissions',
          FORM_OPTS[i]!,
          by === 'default' ? 'default' : 'director',
          'blueprint:contact-form',
        );
        p.think(1200, () =>
          p.say(
            `Logged. ${FORM_OPTS[i]}. ${i === 0 ? 'The forms still need DATABASE_URL on preview before phase 8.' : 'Blueprint v1 updated.'}`,
          ),
        );
      },
    }),
    'E-14': () => ({
      id: 'E-14',
      type: 'access',
      title: 'DATABASE_URL was not provided',
      context:
        'The repository excludes credentials by design. Without DATABASE_URL in the vault, both forms return an error on the preview host, and phase 8 cannot test submissions.',
      impact: 'Nothing blocks the Blueprint today. Foundation can start, but form testing waits.',
      options: [
        { label: 'Request a preview database URL from Dycom IT through you', rec: true },
        { label: 'Use a disposable Postgres for preview. Production URL later' },
      ],
      defaultIdx: 0,
      deadlineMinutes: 30,
      reversible: true,
      evidence: [
        { label: 'Credentials in Settings', go: 'settings:credentials' },
        { label: 'Form and API audit', go: 'wb:forms' },
      ],
      onResolve: async (p, i) => {
        p.think(1200, () =>
          p.say(
            i === 0
              ? 'I drafted the request to Dycom IT for a preview DATABASE_URL. It stays open as an Access item until the URL lands in the vault.'
              : 'A disposable Postgres will back the preview host. The schema in lib/db is applied with db:push. The production URL is still needed before phase 8.',
          ),
        );
      },
    }),
    'E-15': () => ({
      id: 'E-15',
      type: 'risk',
      title: 'Next.js 16 may be ahead of the Content SDK',
      reversible: true,
      context:
        'The repository uses Next.js 16. The Research Agent is confirming which major the pinned Content SDK supports. If it lags, the head runs on the supported major and the pages are checked for version-specific APIs.',
      impact:
        'Small. The 15 pages use standard App Router features. The team proceeds unless you object.',
      options: [
        { label: 'Run the head on the newest Next.js major the Content SDK supports', rec: true },
        { label: 'Stay on Next.js 16 and accept unsupported status' },
      ],
      defaultIdx: 0,
      deadlineMinutes: 15,
      evidence: [
        { label: 'Platform Notes', go: 'wb:notes' },
        { label: 'Research Agent', go: 'inspect:research-agent' },
      ],
      onResolve: async (p, i) => {
        p.think(1000, () =>
          p.say(
            i === 0
              ? 'Logged. The head will run on the supported major, and the Component Engineer checks the pages for version-specific APIs.'
              : 'Logged as a Risk. The head stays on Next.js 16 and the risk carries into the Acceptance Report.',
          ),
        );
      },
    }),
  },
  scenarios: [
    {
      key: 'gate',
      label: 'Raise Gate 1, Blueprint approval',
      run: async (p) => void (await p.raise('E-11')),
    },
    {
      key: 'faq',
      label: 'Raise the Spanish FAQ decision',
      run: async (p) => {
        if (await p.raise('E-12'))
          await p.say(
            'The Spanish FAQ needs a call before Blueprint v1 can close. The card above has my recommendation.',
          );
      },
    },
    {
      key: 'forms',
      label: 'Raise the form destination decision',
      run: async (p) => {
        if (await p.raise('E-13'))
          await p.say(
            'Both forms already work as Next.js route handlers. I recommend keeping them and moving only the copy into Sitecore.',
          );
      },
    },
    {
      key: 'db',
      label: 'Raise the missing DATABASE_URL',
      run: async (p) => {
        if (p.state.escalations['E-14']) return;
        await p.log({
          agent: 'head-integrator',
          tool: 'Vault',
          op: 'read DATABASE_URL for the preview host',
          code: 'missing',
          ms: '–',
          tok: '–',
          sev: 'bad',
          note: 'No value in the vault. Forms will error on preview.',
        });
        await p.raise('E-14');
        await p.say(
          'DATABASE_URL is not in the vault. Foundation can start, but form testing waits on it.',
        );
      },
    },
    {
      key: 'next16',
      label: 'Raise the Next.js 16 risk',
      run: async (p) => void (await p.raise('E-15')),
    },
  ],
  open: [['E-11', 21]],
  auto: [
    [5, 'faq'],
    [14, 'db'],
  ],
};
