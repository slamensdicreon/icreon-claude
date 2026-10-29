import type {
  ArtifactDocument,
  DocBlock,
  DocCell,
  PullRequestDocument,
  TaskContract,
} from '@lw/contracts';
import { fromPos } from './clock';
import type { BlueprintRowDef, DemoCall, DemoScenario, DemoTask, When } from './types';

/**
 * Ansell: a Vite 7 single-page concept moving to SitecoreAI, mid-way through phase 4
 * (components) with phase 5 in parallel. Transcribed from the Cypher Control Center prototype.
 */

const TODAY = 3;
const DAY: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4 };

/** "Mon 9:12 AM" or "2:02 PM" (today) → scenario time. */
export function when(s: string, today = TODAY, days = DAY): When {
  const m = /^(?:(\w{3}) )?(\d{1,2}):(\d{2}) (AM|PM)$/.exec(s.trim());
  if (!m) throw new Error(`Bad time ${s}`);
  const h = (Number(m[2]) % 12) + (m[4] === 'PM' ? 12 : 0) + Number(m[3]) / 60;
  return [m[1] ? days[m[1]]! : today, h];
}

const at = (x: number): When => fromPos(x);
const today = (h: number): When => [TODAY, h];

const CONTRACTS: Record<string, TaskContract> = {
  'component-engineer': {
    inputs: 'Blueprint v2 mappings for this batch. Team branch launchworks/components-batch-2',
    outputs:
      'Content SDK components with fields replacing reads from corpus.ts, component map entries, a commit on the team branch',
    acceptance:
      'Engineering Lead review. Builds green on the preview head. Edits inline in Page builder',
    rollback: 'Revert the commit on the team branch. Redeploy the previous preview',
    maxAttempts: 3,
  },
  'rendering-registrar': {
    inputs: 'Blueprint v2 mappings for this batch. Team branch launchworks/components-batch-2',
    outputs:
      'Rendering definitions, datasource and parameter templates, component map entries. Serialization commit',
    acceptance:
      'Structural Validator: zero critical. Component available in Page builder on the preview editing host',
    rollback:
      'Delete created item IDs. Revert the serialization commit. Redeploy the previous preview',
    maxAttempts: 3,
  },
  'layout-engineer': {
    inputs: 'Blueprint v2 templates and page designs',
    outputs:
      'Data and page templates with standard values, partial and page designs. Serialization commit',
    acceptance:
      'Structural Validator: zero critical. Every template has standard values and insert options',
    rollback: 'Delete created template items. Revert the serialization commit',
    maxAttempts: 3,
  },
  'head-integrator': {
    inputs: 'The Content SDK head on main, the batch branch, environment variables in the vault',
    outputs: 'A green preview build and deployment, editing host registered',
    acceptance: 'Build green. Page builder opens the home page on the preview editing host',
    rollback: 'Promote the previous preview deployment',
    maxAttempts: 3,
  },
  'structural-validator': {
    inputs: 'Items created by the batch, the SXA and Click Click Launch rule set (31 rules)',
    outputs: 'A conformance report in the Workbench',
    acceptance: 'Quality Lead triage of every warning',
    rollback: 'Nothing to roll back: validation is read-only',
    maxAttempts: 3,
  },
};

const contract = (agent: string) => CONTRACTS[agent];

const T = (
  id: string,
  agent: string,
  title: string,
  start: number,
  end: number,
  state: DemoTask['state'],
  deps: string[],
  extra: Partial<DemoTask> = {},
): DemoTask => ({
  id,
  agent,
  phase: 4,
  title,
  start: today(start),
  end: today(end),
  state,
  deps,
  contract: contract(agent),
  ...extra,
});

/** Today's detailed plan, phases 4 and 5. */
const TODAY_TASKS: DemoTask[] = [
  T(
    'p1',
    'component-engineer',
    'Port pilot: Hero, QuickActions, HazardRoute',
    8,
    10.5,
    'done',
    [],
    { group: 'Pilot slice and batch 1', itemKeys: ['hero-video', 'quick-actions', 'hazard-route'] },
  ),
  T(
    'p2',
    'component-engineer',
    'Port batch 1: GlobalHeader, MegaMenu, GlobalFooter',
    10.5,
    12.75,
    'done',
    ['p1'],
    { group: 'Pilot slice and batch 1', itemKeys: ['global-header', 'mega-menu', 'global-footer'] },
  ),
  T('t4', 'component-engineer', 'Port SampleKitPromo', 12.75, 14.5, 'running', ['p2'], {
    group: 'Batch 2: Samples, Guardian, Slots',
    itemKeys: ['sample-kit-promo'],
  }),
  T('p4', 'component-engineer', 'Port GuardianPlanner', 14.5, 15.5, 'planned', ['t4'], {
    group: 'Batch 2: Samples, Guardian, Slots',
    itemKeys: ['guardian-planner'],
  }),
  T(
    'p5',
    'component-engineer',
    'Port CampaignSlots and CampaignSlot',
    15.5,
    16.5,
    'planned',
    ['p4'],
    { group: 'Batch 2: Samples, Guardian, Slots', itemKeys: ['campaign-slots'] },
  ),
  T(
    'p6',
    'component-engineer',
    'Port batch 3: Sustainability, Story, StatBand, ServicePillars',
    16.5,
    18.5,
    'planned',
    ['p5'],
    { group: 'Batch 3: Sustainability, Story', itemKeys: ['sustainability-band', 'story'] },
  ),
  T('p7', 'component-engineer', 'Rework search overlay', 18.5, 19.75, 'waiting', ['t12'], {
    group: 'Search overlay rework',
    itemKeys: ['search-overlay'],
  }),
  T('r1', 'rendering-registrar', 'Register pilot (3)', 10.5, 11.5, 'done', ['p1'], {
    group: 'Register and validate each batch',
    itemKeys: ['hero-video', 'quick-actions', 'hazard-route'],
  }),
  T('r2', 'rendering-registrar', 'Register batch 1 (3)', 12.75, 13.67, 'done', ['p2'], {
    group: 'Register and validate each batch',
    itemKeys: ['global-header', 'mega-menu', 'global-footer'],
  }),
  T(
    'r3',
    'rendering-registrar',
    'HazardRoute thumbnail, Available Renderings',
    13.67,
    14.4,
    'running',
    ['r1'],
    { group: 'Register and validate each batch', itemKeys: ['hazard-route'] },
  ),
  T('r4', 'rendering-registrar', 'Register SampleKitPromo', 14.5, 15, 'planned', ['t4'], {
    group: 'Register and validate each batch',
    itemKeys: ['sample-kit-promo'],
  }),
  T('r5', 'rendering-registrar', 'Register GuardianPlanner', 15.5, 16, 'planned', ['p4'], {
    group: 'Register and validate each batch',
    itemKeys: ['guardian-planner'],
  }),
  T('r6', 'rendering-registrar', 'Register CampaignSlots', 16.5, 17, 'planned', ['p5'], {
    group: 'Register and validate each batch',
    itemKeys: ['campaign-slots'],
  }),
  T('r7', 'rendering-registrar', 'Register batch 3 (4)', 18.5, 19.25, 'planned', ['p6'], {
    group: 'Register and validate each batch',
    itemKeys: ['sustainability-band', 'story'],
  }),
  T('l1', 'layout-engineer', 'Data templates: Product, Brand, Hazard', 11, 13, 'done', [], {
    phase: 5,
    group: '9 data templates',
  }),
  T(
    't6',
    'layout-engineer',
    'Data templates: Topic, Service, Sample Kit, 3 more',
    13,
    15,
    'running',
    ['l1'],
    { phase: 5, group: '9 data templates' },
  ),
  T('l3', 'layout-engineer', 'Home page template and standard values', 15, 16, 'planned', ['t6'], {
    phase: 5,
    group: 'Home template, partial and page designs',
  }),
  T('l4', 'layout-engineer', 'Partial designs: header, footer', 16, 17, 'planned', ['l3'], {
    phase: 5,
    group: 'Home template, partial and page designs',
  }),
  T('l5', 'layout-engineer', 'Page design: Home', 17, 17.5, 'planned', ['l4'], {
    phase: 5,
    group: 'Home template, partial and page designs',
  }),
  T(
    'h1',
    'head-integrator',
    'Carry Tailwind 4 and 12 stylesheets into the head',
    8,
    10,
    'done',
    [],
    { group: 'Head integration and preview deploys' },
  ),
  T('h2', 'head-integrator', 'Preview deploy 6', 13.25, 14, 'done', ['r2'], {
    group: 'Head integration and preview deploys',
  }),
  T(
    'h3',
    'head-integrator',
    'Middleware: personalize, redirects, editing',
    14,
    15.5,
    'running',
    ['h2'],
    { group: 'Head integration and preview deploys' },
  ),
  T('t7', 'head-integrator', 'Preview deploy 7', 16.5, 17, 'planned', ['p5', 'l4'], {
    group: 'Head integration and preview deploys',
  }),
  T('h5', 'head-integrator', 'Preview deploy 8', 19.25, 19.75, 'planned', ['r7'], {
    group: 'Head integration and preview deploys',
  }),
  T('q1', 'structural-validator', 'Validate pilot', 11.5, 11.85, 'done', ['r1'], {
    group: 'Register and validate each batch',
    itemKeys: ['hero-video', 'quick-actions', 'hazard-route'],
  }),
  T('q2', 'structural-validator', 'Validate batch 1', 13.67, 14, 'done', ['r2'], {
    group: 'Register and validate each batch',
    itemKeys: ['global-header', 'mega-menu', 'global-footer'],
  }),
  T('t9', 'structural-validator', 'Validate batch 2', 15, 15.35, 'ready', ['r4'], {
    group: 'Register and validate each batch',
  }),
  T('q4', 'structural-validator', 'Validate batch 3', 19.25, 19.6, 'planned', ['r7'], {
    group: 'Register and validate each batch',
  }),
  T('t10', 'editor-experience-qa', 'Page builder smoke on deploy 7', 17, 17.75, 'planned', ['t7'], {
    group: 'Page builder smoke on each deploy',
  }),
  T(
    't12',
    'solution-architect',
    'Consult: where search reads content',
    13.83,
    14.6,
    'waiting',
    [],
    { group: 'Blueprint consults', workstream: 'discovery' },
  ),
  T(
    's2',
    'solution-architect',
    'Page design review with the Layout Engineer',
    17,
    17.5,
    'planned',
    ['l5'],
    { phase: 5, group: 'Page design review', workstream: 'discovery' },
  ),
  T('t11', 'content-lead', 'Plan migration order for 89 items', 17.5, 18.5, 'planned', [], {
    phase: 6,
    group: 'Migration plan',
    workstream: 'content',
  }),
];

/** The rest of the engagement, one task per activity (ENG in the prototype). */
const E = (
  phase: number,
  id: string,
  agent: string,
  title: string,
  s: number,
  e: number,
  state: DemoTask['state'],
  deps: string[] = [],
): DemoTask => ({
  id,
  agent,
  phase,
  title,
  group: title,
  start: at(s),
  end: at(e),
  state,
  deps,
  contract: contract(agent),
});
const d = (day: number, h: number) => day + (h - 8) / 10;

const ENGAGEMENT: DemoTask[] = [
  E(
    0,
    'e0a',
    'tenant-provisioner',
    'Verify GitHub, SitecoreAI, Edge and Vercel access',
    d(0, 9),
    d(0, 10),
    'done',
  ),
  E(1, 'e1a', 'repo-analyst', 'Clone and build ansell-main', d(0, 10), d(0, 11), 'done', ['e0a']),
  E(1, 'e1b', 'repo-analyst', 'Component and media inventory', d(0, 11), d(0, 15), 'done', ['e1a']),
  E(
    1,
    'e1c',
    'content-analyst',
    'Content inventory from corpus.ts and nav.ts',
    d(0, 10),
    d(0, 14),
    'done',
    ['e0a'],
  ),
  E(1, 'e1d', 'research-agent', 'Platform Notes', d(0, 10), d(0, 13), 'done', ['e0a']),
  E(2, 'e2a', 'solution-architect', 'Draft Blueprint v1', d(0, 15), d(1, 10), 'done', [
    'e1b',
    'e1c',
    'e1d',
  ]),
  E(2, 'e2b', 'chief-of-staff', 'Director review and Gate 1', d(1, 10), d(1, 11.33), 'done', [
    'e2a',
  ]),
  E(
    3,
    'e3a',
    'tenant-provisioner',
    'Site collection, site, language, grid',
    d(2, 8),
    d(2, 11),
    'done',
    ['e2b'],
  ),
  E(
    3,
    'e3b',
    'head-integrator',
    'Scaffold the Content SDK Next.js head',
    d(2, 8),
    d(2, 15),
    'done',
    ['e2b'],
  ),
  E(
    3,
    'e3c',
    'deployment-engineer',
    'Hosting project and environment',
    d(2, 11),
    d(2, 14),
    'done',
    ['e2b'],
  ),
  E(3, 'e3d', 'structural-validator', 'Foundation conformance check', d(2, 15), d(2, 16), 'done', [
    'e3a',
  ]),
  E(
    4,
    'e4a',
    'component-engineer',
    'Sample kit rail and mobile drawer',
    d(4, 14),
    d(4, 18),
    'planned',
    ['p7'],
  ),
  E(6, 'e6a', 'content-migrator', 'Create 89 data items', d(5, 8), d(5, 16), 'planned', [
    'r7',
    'l5',
  ]),
  E(6, 'e6b', 'media-migrator', 'Upload 17 media files', d(5, 8), d(5, 13), 'planned', ['r7']),
  E(6, 'e6c', 'content-migrator', 'Compose the home page', d(5, 16), d(6, 10), 'planned', ['e6a']),
  E(6, 'e6d', 'parity-auditor', 'Parity audit and visual diff', d(6, 8), d(6, 12), 'planned', [
    'e6c',
  ]),
  E(
    7,
    'e7a',
    'experience-enabler',
    'Regional campaign slot as a page variant',
    d(6, 12),
    d(6, 15),
    'planned',
    ['e6c'],
  ),
  E(7, 'e7b', 'experience-enabler', 'A/B test on the Hero', d(6, 15), d(6, 17), 'planned', ['e7a']),
  E(
    7,
    'e7c',
    'experience-enabler',
    'SEO fields, redirects, 404 and 500 pages',
    d(6, 12),
    d(6, 18),
    'planned',
    ['e6c'],
  ),
  E(8, 'e8a', 'deployment-engineer', 'Production head on Vercel', d(7, 8), d(7, 12), 'planned', [
    'e7c',
  ]),
  E(
    8,
    'e8b',
    'deployment-engineer',
    'Register the editing host, publish to Edge',
    d(7, 12),
    d(7, 15),
    'planned',
    ['e8a'],
  ),
  E(8, 'e8c', 'editor-experience-qa', 'Page builder smoke test', d(7, 15), d(7, 18), 'planned', [
    'e8b',
  ]),
  E(9, 'e9a', 'perf-a11y-qa', 'Lighthouse and axe', d(8, 8), d(8, 11), 'planned', ['e8b']),
  E(
    9,
    'e9b',
    'editor-experience-qa',
    'Editor experience QA, full pass',
    d(8, 8),
    d(8, 13),
    'planned',
    ['e8c'],
  ),
  E(9, 'e9c', 'chief-of-staff', 'Acceptance Report and Gate 2', d(8, 13), d(8, 17), 'planned', [
    'e9a',
    'e9b',
  ]),
  E(
    10,
    'e10a',
    'handover-writer',
    'Runbook, component catalog, known gaps',
    d(9, 8),
    d(9, 16),
    'planned',
    ['e9c'],
  ),
];

// ---------------------------------------------------------------------------------------------
// Activity: the log rows plus each agent's own recent calls
// ---------------------------------------------------------------------------------------------

const ROWS: [string, string, string, string, string, string, string, string?, string?][] = [
  [
    '2:02 PM',
    'rendering-registrar',
    'Authoring API',
    'createItem Renderings/Project/ansell/Page Content/HazardRoute',
    '200',
    '412 ms',
    '1.2k',
  ],
  ['2:02 PM', 'component-engineer', 'Sandbox', 'next build', '0', '44 s', '–'],
  [
    '2:01 PM',
    'rendering-registrar',
    'Authoring API',
    'createItem Templates/Project/ansell/Hazard',
    '200',
    '388 ms',
    '1.1k',
  ],
  [
    '2:00 PM',
    'structural-validator',
    'Validators',
    'conformance batch 2',
    'pass, 1 warning',
    '9 s',
    '4.0k',
    'warn',
    'Naming: rendering parameters template “SampleKitParams” should be “SampleKitPromo Parameters”.',
  ],
  ['1:59 PM', 'head-integrator', 'Vercel', 'deploy preview 6', 'ready', '2 m 48 s', '0.6k'],
  [
    '1:58 PM',
    'rendering-registrar',
    'GitHub',
    'openPullRequest 12 Register batch 2 renderings',
    '201',
    '1.0 s',
    '0.9k',
  ],
  [
    '1:57 PM',
    'component-engineer',
    'GitHub',
    'commit 3f2a Port HazardRoute, QuickActions',
    '201',
    '0.9 s',
    '0.4k',
  ],
  ['1:51 PM', 'head-integrator', 'Vercel', 'build 6', 'green', '2 m 12 s', '0.3k'],
  [
    '1:49 PM',
    'structural-validator',
    'Validators',
    'conformance pilot slice',
    'pass',
    '8 s',
    '3.8k',
  ],
  [
    '1:44 PM',
    'rendering-registrar',
    'Authoring API',
    'createItem Renderings/Project/ansell/Page Content/QuickActions',
    '200',
    '401 ms',
    '1.2k',
  ],
  ['1:40 PM', 'engineering-lead', 'Review', 'accept QuickActions', 'ok', '–', '6.1k'],
  ['1:40 PM', 'chief-of-staff', 'Planner', 'close pilot slice, open batch 2', 'ok', '–', '2.2k'],
  [
    '1:22 PM',
    'engineering-lead',
    'Review',
    'reject GlobalHeader (search overlay hard-wired to corpus.ts)',
    'reject',
    '–',
    '5.4k',
    'warn',
  ],
  [
    '1:05 PM',
    'component-engineer',
    'Content SDK CLI',
    'component scaffold GlobalHeader',
    '0',
    '3.1 s',
    '0.2k',
  ],
];

const AGENT_CALLS: [string, string, string, string, string, string][] = [
  [
    'chief-of-staff',
    '2:02 PM',
    'Planner',
    'rebalance engineering queue after the pilot',
    'ok',
    '1.1s',
  ],
  ['chief-of-staff', '1:58 PM', 'Decision Log', 'read D-01 to D-07', 'ok', '80ms'],
  ['discovery-lead', 'Tue 11:20 AM', 'Review', 'accept Blueprint v1', 'ok', '–'],
  ['engineering-lead', '2:01 PM', 'Review', 'accept HazardRoute fields', 'ok', '–'],
  ['quality-lead', '2:00 PM', 'Review', 'triage batch 2 warning', 'ok', '–'],
  [
    'repo-analyst',
    'Mon 9:12 AM',
    'GitHub',
    'clone slamensdicreon/ansell (152 files, 43 MB)',
    '200',
    '4.1s',
  ],
  [
    'repo-analyst',
    'Mon 9:20 AM',
    'Sandbox',
    'pnpm install --frozen-lockfile, vite build',
    '0',
    '51s',
  ],
  [
    'content-analyst',
    'Mon 10:05 AM',
    'Sandbox',
    'evaluate data/corpus.ts (1,619 lines)',
    '0',
    '2.2s',
  ],
  [
    'research-agent',
    'Mon 11:05 AM',
    'Docs',
    'Content SDK for Next.js: component map, middleware',
    '200',
    '2.1s',
  ],
  [
    'solution-architect',
    '1:52 PM',
    'Blackboard',
    'read Blueprint v2 / Search overlay',
    'ok',
    '60ms',
  ],
  ['tenant-provisioner', 'Wed 9:14 AM', 'Sitecore CLI', 'ser push (module: ansell)', '0', '31s'],
  [
    'component-engineer',
    '1:55 PM',
    'Content SDK CLI',
    'component scaffold SampleKitPromo',
    '0',
    '3.2s',
  ],
  ['rendering-registrar', '1:59 PM', 'Sitecore CLI', 'ser push (module: ansell)', '0', '12.8s'],
  [
    'layout-engineer',
    '1:50 PM',
    'Authoring API',
    'createItem Templates/Project/ansell/Product',
    '200',
    '356ms',
  ],
  ['deployment-engineer', 'Wed 9:40 AM', 'Deploy API', 'set environment variables', '200', '1.2s'],
];

export function calls(rows = ROWS, agentCalls = AGENT_CALLS, t = when): DemoCall[] {
  const out: DemoCall[] = rows.map(([time, agent, tool, op, code, ms, tok, sev, note]) => ({
    at: t(time),
    agent,
    tool,
    op,
    code,
    ms,
    tok,
    sev: (sev ?? '') as DemoCall['sev'],
    note,
  }));
  for (const [agent, time, tool, op, code, ms] of agentCalls)
    if (!out.some((c) => c.agent === agent && c.op === op))
      out.push({ at: t(time), agent, tool, op, code, ms, tok: '–' });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Blueprint
// ---------------------------------------------------------------------------------------------

const BP_V2: BlueprintRowDef[] = [
  {
    key: 'hero-video',
    src: 'Hero.tsx',
    target: 'HeroVideo',
    fields: 'Kicker, Title, Lead, Video, Poster',
    params: 'Theme',
    ph: '–',
    variants: 'Default, Image',
    status: 'registered',
    pilot: true,
  },
  {
    key: 'quick-actions',
    src: 'Hero.tsx (QuickActions)',
    target: 'QuickActions',
    fields: 'Actions: icon, title, description, link (3)',
    params: '–',
    ph: '–',
    variants: 'Default',
    status: 'registered',
    pilot: true,
  },
  {
    key: 'hazard-route',
    src: 'HazardRoute.tsx',
    target: 'HazardRoute',
    fields: 'Kicker, Title, hazards from Data/Hazards (8)',
    params: 'Default hazard',
    ph: '–',
    variants: 'Default',
    status: 'registered',
    pilot: true,
  },
  {
    key: 'global-header',
    src: 'Header.tsx (UtilityBar, Header)',
    target: 'GlobalHeader (partial design)',
    fields: 'Logo, utility links, locale label',
    params: 'Sticky',
    ph: 'header-utility',
    variants: 'Default',
    status: 'registered',
  },
  {
    key: 'mega-menu',
    src: 'MegaMenu.tsx, data/nav.ts',
    target: 'MegaMenu',
    fields: 'Menus from Data/Navigation (3), sections, side cards',
    params: '–',
    ph: '–',
    variants: 'Default',
    status: 'registered',
  },
  {
    key: 'global-footer',
    src: 'Footer.tsx',
    target: 'GlobalFooter (partial design)',
    fields: 'Columns, social links, legal',
    params: '–',
    ph: 'footer-{*}',
    variants: 'Default',
    status: 'registered',
  },
  {
    key: 'sample-kit-promo',
    src: 'Samples.tsx',
    target: 'SampleKitPromo',
    fields: 'Kicker, Title, Body, Steps, starter kits from Data/Sample Kits (3)',
    params: '–',
    ph: '–',
    variants: 'Default',
    status: 'in progress',
  },
  {
    key: 'guardian-planner',
    src: 'Guardian.tsx, guardianData.ts, guardianGuides.ts',
    target: 'GuardianPlanner',
    fields: 'Title, Body, priorities (4), guides from Data/Guardian',
    params: '–',
    ph: '–',
    variants: 'Default',
    status: 'in progress',
  },
  {
    key: 'campaign-slots',
    src: 'Slots.tsx',
    target: 'CampaignSlots + CampaignSlot',
    fields: 'Kicker, Title, Body, Image, CTA, Owner, Campaign ID',
    params: 'Columns',
    ph: 'slots-{*}',
    variants: 'Default',
    status: 'in progress',
    was: 'One component with a hard-coded array of 3 slots',
  },
  {
    key: 'sustainability-band',
    src: 'Sustainability.tsx',
    target: 'SustainabilityBand',
    fields: 'Title, Body, Stats (4), Map, Report links, Sources',
    params: '–',
    ph: '–',
    variants: 'Default',
    status: 'planned',
  },
  {
    key: 'story',
    src: 'Story.tsx',
    target: 'Story + StatBand + ServicePillars',
    fields: 'Title, Body, Image, Stats (4), Services from Data/Services (5)',
    params: 'Theme',
    ph: '–',
    variants: 'Default',
    status: 'planned',
    was: 'One component with stats and services inline',
  },
  {
    key: 'search-overlay',
    src: 'SearchBody.tsx, search-engine.ts',
    target: 'Search overlay (application component, not a rendering)',
    fields: 'Reads products, topics, documents',
    params: '–',
    ph: '–',
    variants: '–',
    status: 'in progress',
  },
  {
    key: 'sample-kit-rail',
    src: 'KitRail.tsx, Drawer.tsx, state/site.tsx',
    target: 'Sample kit rail and mobile drawer (application components)',
    fields: 'Reads products and starter kits',
    params: '–',
    ph: '–',
    variants: '–',
    status: 'planned',
  },
  {
    key: 'staging-curtain',
    src: 'staging/StagingCurtain.tsx',
    target: 'Dropped: pitch intro animation',
    fields: '–',
    params: '–',
    ph: '–',
    variants: '–',
    status: 'dropped',
  },
  {
    key: 'ui-library',
    src: 'components/ui (56 files)',
    target: 'Kept as library code, not renderings',
    fields: '–',
    params: '–',
    ph: '–',
    variants: '–',
    status: 'merged',
  },
];

/** Version 1, as approved at Gate 1: Slots and Story were single components then. */
const BP_V1: BlueprintRowDef[] = BP_V2.map((r) =>
  r.key === 'campaign-slots'
    ? {
        ...r,
        target: 'CampaignSlots',
        fields: 'Kicker, Title, Body, slots (3, hard-coded)',
        ph: '–',
        was: undefined,
      }
    : r.key === 'story'
      ? {
          ...r,
          target: 'Story',
          fields: 'Title, Body, Image, Stats (4), Services (5)',
          was: undefined,
        }
      : r,
);

// ---------------------------------------------------------------------------------------------
// Workbench documents
// ---------------------------------------------------------------------------------------------

export const table = (columns: string[], rows: DocCell[][], num: number[] = []): DocBlock => ({
  type: 'table',
  columns: columns.map((label, i) => ({
    label,
    ...(num.includes(i) ? { align: 'num' as const } : {}),
  })),
  rows,
});
export const doc = (meta: string, intro: string | null, blocks: DocBlock[]): ArtifactDocument => ({
  doc: 'lw.document/1',
  meta,
  intro,
  blocks,
});
export const mono = (text: string) => ({ text, mono: true });
const chip = (c: string, text: string, sub?: string) => ({
  text,
  chip: c,
  ...(sub ? { sub } : {}),
});

const NOTES = doc('frozen after phase 2', null, [
  table(
    ['Fact', 'Value', 'Source'],
    [
      [
        'Source framework',
        'Vite 7, React 19.1, Tailwind 4, pnpm workspace, Node 22. Not Next.js',
        'package.json, vite.config.ts',
      ],
      ['Target head', 'Content SDK for Next.js, pinned at project start', 'Sitecore docs'],
      ['Component registration', 'Explicit entries in .sitecore/component-map.ts', 'Sitecore docs'],
      [
        'Base renderings',
        'Cloned or derived from Renderings/Project/click-click-launch',
        'Tenant inspection',
      ],
      [
        'Replit plugins',
        'cartographer, dev-banner, runtime-error-modal. Removed from the new head',
        'vite.config.ts',
      ],
      ['Repository size', '43 MB, under the 500 MB SitecoreAI deploy limit', 'Measured'],
      [
        'Personalization',
        'Page variants and component A/B/n built in. CampaignSlot owner and campaign ID map to a regional page variant',
        'Entitlement check, Slots.tsx',
      ],
    ],
  ),
]);

const INV_COMPONENTS = doc(
  'Repo Analyst, Mon',
  'App.tsx composes 11 homepage sections and 4 global overlays. 56 shadcn/ui primitives sit under components/ui as library code.',
  [
    table(
      ['Class', 'Count', 'In ansell-main'],
      [
        [
          'Content sections',
          '9',
          'Hero, QuickActions, HazardRoute, Samples, Guardian, Slots, Sustainability, Story, Footer',
        ],
        ['Navigation', '2', 'UtilityBar and Header, MegaMenu'],
        ['Overlays with state', '4', 'SearchBody, KitRail, Drawer, Toast'],
        ['Pitch only', '1', 'StagingCurtain'],
        ['Library', '56', 'components/ui (Radix and shadcn)'],
      ],
      [1],
    ),
    {
      type: 'note',
      text: 'Flagged: no router in use (wouter installed, never imported), 30 analytics events pushed to dataLayer, 2 features without a backend (sample requests, search).',
    },
  ],
);

const INV_PAGES = doc(
  'Content Analyst, Mon',
  'One route: the homepage. Content comes from data/corpus.ts and data/nav.ts, which become Sitecore data items so marketers can edit them.',
  [
    table(
      ['Content type', 'Items', 'Data template'],
      [
        ['Products', '24', 'Product'],
        ['Brands', '15', 'Brand'],
        ['Safety topics', '13', 'Topic'],
        ['Hazards', '8', 'Hazard'],
        ['Document types', '9', 'Document Type'],
        ['Company links', '6', 'Org Link'],
        ['Services', '5', 'Service'],
        ['Sample starter kits', '3', 'Sample Kit'],
        ['Campaign slots', '3', 'Campaign Slot'],
        ['Navigation menus', '3', 'Nav Menu'],
        [{ text: 'Total', strong: true }, { text: '89', strong: true }, ''],
      ],
      [1],
    ),
    {
      type: 'note',
      text: 'External destinations: 27 links to ansell.com stay external (D-02). Language: en-US only.',
    },
  ],
);

const INV_MEDIA = doc(
  'Repo Analyst, Mon',
  '22 files, 41 MB in public/ansell/assets. 17 are referenced and migrate. 5 are never referenced and are excluded (D-06).',
  [
    {
      type: 'images',
      layout: 'gallery',
      items: ['cut', 'chem', 'lifesci', 'abrasion', 'hero', 'recycle'].map((k) => ({
        ref: `image:${k}`,
        caption: '',
      })),
    },
    table(
      ['Files', 'Count', 'Status'],
      [
        [
          'Hazard, sector and news photos (jpg)',
          '12',
          'Migrate. Sourced from Ansell Shop, rights to confirm',
        ],
        ['Hero video and poster', '2', 'Migrate'],
        ['Story image, sustainability map, Ansell logo', '3', 'Migrate'],
        [
          'hero-loop, hero-loop-cleanroom, hero-loop-healthcare (mp4)',
          '3',
          'Excluded, 32 MB, unreferenced',
        ],
        ['Cleanroom and healthcare keyframes (png)', '2', 'Excluded, unreferenced'],
        ['Icreon logo', '1', 'Excluded, pitch asset'],
      ],
      [1],
    ),
  ],
);

const PILOT = doc(
  '1:40 PM today',
  'Hero, QuickActions and HazardRoute ported from the Vite app, registered, and available in Page builder on preview deploy 6. Each drops onto the home page and edits inline. HazardRoute now reads its 8 hazards from a Data folder, so marketers can edit hazards without a release.',
  [
    {
      type: 'scores',
      items: [
        { label: 'Performance', value: 88 },
        { label: 'Accessibility', value: 97 },
        { label: 'Best practices', value: 100 },
        { label: 'SEO', value: 92 },
      ],
    },
    {
      type: 'images',
      layout: 'compare',
      items: [
        { ref: 'image:hero', caption: 'Source: Vite build, desktop' },
        { ref: 'image:hero', caption: 'Target: preview deploy 6, desktop' },
      ],
    },
    { type: 'heading', text: 'Deviations' },
    {
      type: 'list',
      items: [
        'Hero video autoplay waits for the Next.js client boundary. Poster shows first, as in the Vite build.',
        'Quick action counts (kit badge) need the sample kit rail, which lands in batch 2.',
        'Performance 88 is below the Vite build because the 4.4 MB hero video now loads from the Media Library. A CDN rendition is planned for phase 8.',
      ],
    },
  ],
);

const CONFORMANCE = doc(
  '2:00 PM today',
  '3 renderings checked against 31 SXA and Click Click Launch rules. 0 critical, 1 warning.',
  [
    table(
      ['Check', 'Result'],
      [
        ['Rendering under Project module path', chip('done', 'Pass')],
        ['Datasource template inherits CCL base', chip('done', 'Pass')],
        [
          'Rendering parameters template naming',
          chip('waiting', 'Warning', 'SampleKitParams should be “SampleKitPromo Parameters”'),
        ],
        ['Available Renderings entry present', chip('done', 'Pass')],
        ['Datasource location points to Data folder', chip('done', 'Pass')],
        ['Placeholder settings defined', chip('done', 'Pass')],
      ],
    ),
  ],
);

const PR12: PullRequestDocument = {
  doc: 'lw.pull_request/1',
  number: 12,
  title: 'Register batch 2 renderings',
  head: 'launchworks/components-batch-2',
  base: 'main',
  state: 'open',
  author: 'rendering-registrar',
  openedAt: '1970-01-01T00:00:00.000Z',
  mergedAt: null,
  mergedBy: null,
  url: 'https://github.com/slamensdicreon/ansell/pull/12',
  summary: null,
  filesChanged: 21,
  files: [
    { path: 'authoring/items/ansell/Renderings/SampleKitPromo.yml', additions: 41, deletions: 0 },
    { path: 'authoring/items/ansell/Templates/Sample Kit.yml', additions: 74, deletions: 0 },
    { path: 'src/components/sample-kit-promo/SampleKitPromo.tsx', additions: 88, deletions: 0 },
    { path: 'src/styles/kit.css', additions: 0, deletions: 0 },
    { path: '.sitecore/component-map.ts', additions: 2, deletions: 0 },
  ],
};

const PR11: PullRequestDocument = {
  ...PR12,
  number: 11,
  title: 'Pilot slice components',
  head: 'launchworks/pilot-slice',
  state: 'merged',
  mergedBy: 'engineering-lead',
  url: 'https://github.com/slamensdicreon/ansell/pull/11',
  summary: 'Hero.tsx and HazardRoute.tsx carried over with fields replacing reads from corpus.ts.',
  filesChanged: 17,
  files: [],
};

// ---------------------------------------------------------------------------------------------
// Escalations and scenarios
// ---------------------------------------------------------------------------------------------

const SEARCH_OPTS = [
  'Build the search index from Experience Edge at build time',
  'Add Sitecore Search (needs a license, outside this scope)',
  'Keep corpus.ts in code and edit it through pull requests',
];
const KIT_OPTS = [
  'SitecoreAI Forms posting to an endpoint Ansell provides',
  'Keep the hand-off to the ansell.com contact page, as the concept does today',
  'Ship the kit builder, defer submission to a later release',
];

export const ansell: DemoScenario = {
  id: 'ansell',
  name: 'Ansell',
  client: 'Ansell',
  initials: 'AN',
  subtitle: 'ansell-main to SitecoreAI',
  timezone: 'America/New_York',
  fixtures: 'ansell',
  source: {
    repo: 'slamensdicreon/ansell',
    url: null,
    framework: 'Vite 7, React 19',
    label: 'Vite build of ansell-main',
  },
  target: { collection: 'Ansell', site: 'ansell.com', hosting: 'Vercel, ansell-website' },
  budgets: { usd: 1200, tokens: 8_000_000, hours: 240 },
  spent: { usd: 286, tokens: 2_200_000 },
  started: [0, 9],
  present: [TODAY, 14 + 2 / 60],
  phases: [
    { number: 0, entered: [0, 9], exited: [0, 10] },
    { number: 1, entered: [0, 10], exited: [0, 15] },
    { number: 2, entered: [0, 15], exited: [1, 11 + 20 / 60] },
    { number: 3, entered: [2, 8], exited: [2, 16] },
    { number: 4, entered: [3, 8] },
    { number: 5, entered: [3, 11] },
  ],
  stats: [
    {
      metric: 'components_registered',
      label: 'Renderings',
      icon: 'application',
      note: 'Registered in SitecoreAI',
    },
    {
      metric: 'pages_migrated',
      label: 'Content items',
      icon: 'document',
      note: 'From corpus.ts in phase 6',
    },
    { metric: 'media_uploaded', label: 'Media', icon: 'image', note: '5 unused files excluded' },
    {
      metric: 'qa_pass',
      label: 'QA pass',
      icon: 'task--complete',
      note: 'Of renderings registered',
    },
  ],
  metrics: {
    components_registered: [9, 15],
    pages_migrated: [0, 89],
    media_uploaded: [0, 17],
    qa_pass: [7, 9],
    parity: [null, null],
  },
  agents: {
    'chief-of-staff': {
      state: 'active',
      now: 'Briefing the Director',
      tokens: 164_000,
      note: 'Owns the plan, status, escalations, decision log and budget. Writes no code, creates no items.',
    },
    'discovery-lead': {
      state: 'done',
      now: 'Workstream complete in phase 2',
      tokens: 410_000,
      note: 'Decomposes discovery, dispatches analysts, reviews inventories and the Blueprint.',
    },
    'engineering-lead': {
      state: 'active',
      now: 'Reviewing the SampleKitPromo port',
      tokens: 980_000,
      note: 'Decomposes the build, dispatches engineers, reviews every component against acceptance criteria.',
    },
    'content-lead': {
      state: 'idle',
      now: 'Activates in phase 6',
      tokens: 0,
      note: 'Owns migration and personalization readiness from phase 6.',
    },
    'quality-lead': {
      state: 'active',
      now: 'Triaging one naming warning in batch 2',
      tokens: 240_000,
      note: 'Owns validation across every phase.',
    },
    'repo-analyst': {
      tokens: 260_000,
      note: 'Parses the source app: components, props, routing, dependencies, media.',
    },
    'content-analyst': {
      tokens: 180_000,
      note: 'Extracts the content inventory. Here the concept is not deployed, so it reads data/corpus.ts and data/nav.ts instead of crawling.',
    },
    'research-agent': { tokens: 95_000, note: 'Verifies platform facts. Frozen after phase 2.' },
    'solution-architect': {
      state: 'waiting',
      now: 'Consulted: where search reads its corpus',
      tokens: 390_000,
      note: 'Owns the Implementation Blueprint. Consulted in phases 4 and 5.',
    },
    'tenant-provisioner': {
      tokens: 120_000,
      note: 'Creates the site collection, site, language, grid and module folders.',
    },
    'component-engineer': {
      state: 'active',
      now: 'Porting SampleKitPromo: starter kits from a Data folder (step 3 of 5)',
      tokens: 540_000,
      note: 'Ports the Vite components into the Content SDK Next.js head and registers them in the component map.',
    },
    'rendering-registrar': {
      state: 'active',
      now: 'Registering HazardRoute: Available Renderings',
      tokens: 430_000,
      note: 'Creates rendering definitions, datasource and parameter templates, thumbnails, Available Renderings.',
    },
    'layout-engineer': {
      state: 'active',
      now: 'Data templates: Product, Brand, Hazard',
      tokens: 170_000,
      note: 'Page templates, standard values, partial and page designs.',
    },
    'head-integrator': {
      state: 'active',
      now: 'Watching preview build 7',
      tokens: 380_000,
      note: 'Owns the new Content SDK Next.js head: sitecore.config.ts, middleware, editing host, and the Tailwind 4 and CSS carried over from Vite.',
    },
    'deployment-engineer': {
      tokens: 70_000,
      note: 'Deploys the head, registers the editing host, publishes to Edge.',
    },
    'content-migrator': {
      note: 'Creates the home page and the 89 data items from the corpus, composes placeholders, rewrites links.',
    },
    'media-migrator': {
      note: 'Uploads the 17 media files in use with alt text. Skips the 5 unused files.',
    },
    'experience-enabler': {
      note: 'Personalization and A/B/n readiness. Turns the regional campaign slot into a page variant.',
    },
    'structural-validator': {
      state: 'active',
      now: 'Validating batch 2 (3 renderings)',
      tokens: 90_000,
      note: 'Checks item structure against SXA and Click Click Launch rules.',
    },
    'visual-qa': {
      note: 'Screenshot-diffs the Vite build against the Sitecore build at three breakpoints.',
    },
    'editor-experience-qa': { note: 'Drives Page builder as a marketer would.' },
    'perf-a11y-qa': { note: 'Lighthouse and axe on the home page.' },
    'parity-auditor': {
      note: 'Diffs text, links and media between the Vite build and the Sitecore build.',
    },
    'handover-writer': { note: 'Writes the runbook, component catalog and known-gaps register.' },
  },
  tasks: [...ENGAGEMENT.slice(0, 11), ...TODAY_TASKS, ...ENGAGEMENT.slice(11)],
  calls: calls(),
  messages: [
    {
      at: when('Mon 11:40 AM'),
      brief: 'Discovery summary: ansell-main',
      lines: [
        'The source is a Vite 7 and React 19 single-page app, not Next.js. The team builds a new Content SDK Next.js head and carries the components and Tailwind 4 styles into it (D-01).',
        'One route: the homepage, 11 sections plus 4 overlays. All 27 menu destinations link out to ansell.com.',
        'Content lives in data/corpus.ts and data/nav.ts: 89 items across 9 types. It becomes Sitecore data items so marketers can edit it.',
        'Two features have no backend today: the sample kit request and search. Both need a decision before phase 6.',
        'Media: 22 files, 41 MB. 5 are never referenced, including 32 MB of hero loops. They are excluded.',
      ],
      note: 'Blueprint v1 is ready for your review in the Workbench.',
      links: [
        ['Open Blueprint', 'wb:blueprint'],
        ['Component inventory', 'wb:invComponents'],
        ['Media inventory', 'wb:invMedia'],
      ],
    },
    {
      at: when('9:30 AM'),
      brief: 'Phase 4 brief: Components',
      lines: [
        'Produces: 15 renderings, available in Page builder on the preview editing host.',
        'Activates: Component Engineer, Rendering Registrar, Head Integrator, Structural Validator. Layout Engineer runs phase 5 in parallel.',
        'Exit: every Blueprint component ported, registered and available in Page builder.',
      ],
      note: 'Expect one decision on where search reads its content from.',
      links: [
        ['Open plan', 'plan'],
        ['Open team', 'team'],
      ],
    },
    {
      at: when('1:40 PM'),
      text: 'Pilot slice is done. Hero, QuickActions and HazardRoute are registered and the home page builds in Page builder on preview deploy 6. The review card is above. Batch 2 continues meanwhile under the Blueprint.',
      links: [
        ['Pilot report', 'wb:pilot'],
        ['Site preview', 'preview'],
      ],
    },
    {
      at: when('1:58 PM'),
      text: '9 of 15 renderings registered. Build is green on preview deploy 6. Nothing else needs you right now.',
    },
  ],
  decisions: [
    {
      ref: 'D-01',
      q: 'The source is a Vite 7 single-page app, not Next.js',
      a: 'Build a new Content SDK Next.js head and carry the components and Tailwind 4 styles into it',
      by: 'Director',
      at: when('Mon 11:52 AM'),
    },
    {
      ref: 'D-02',
      q: 'Scope of pages',
      a: 'Home page only. The 27 menu links stay external to ansell.com',
      by: 'Director',
      at: when('Mon 11:55 AM'),
    },
    {
      ref: 'D-03',
      q: 'Source of truth for content',
      a: 'The repository: data/corpus.ts and data/nav.ts. The concept is not deployed, so there is nothing to crawl',
      by: 'Director',
      at: [0, 11 + 55.5 / 60],
    },
    {
      ref: 'D-04',
      q: 'Gate 1: Blueprint v1',
      a: 'Approved with three edits: Slots split into a container and child cards, Story split into three renderings, StagingCurtain dropped',
      by: 'Director',
      at: when('Tue 11:20 AM'),
      scopeKey: 'gate-1',
    },
    {
      ref: 'D-05',
      q: 'Fonts',
      a: 'Keep Barlow and Source Sans 3 from the repo until Ansell supplies its official faces',
      by: 'Director',
      at: when('Tue 11:22 AM'),
    },
    {
      ref: 'D-06',
      q: 'Unused media',
      a: 'Exclude the 3 hero loops and 2 keyframes (32 MB) that no component references',
      by: 'Cypher (convention)',
      at: when('Tue 11:30 AM'),
    },
  ],
  blueprint: {
    v1: BP_V1,
    v2: BP_V2,
    producedAt: at(d(1, 10)),
    gateRaisedAt: at(d(1, 10)),
    approvedAt: when('Tue 11:20 AM'),
    v2At: when('Tue 11:25 AM'),
  },
  artifacts: [
    {
      id: 'invComponents',
      kind: 'inventory',
      title: 'Component inventory',
      short: 'Components',
      producer: 'repo-analyst',
      at: when('Mon 3:00 PM'),
      doc: INV_COMPONENTS,
    },
    {
      id: 'invPages',
      kind: 'inventory',
      title: 'Route and content inventory',
      short: 'Content',
      producer: 'content-analyst',
      at: when('Mon 2:00 PM'),
      doc: INV_PAGES,
    },
    {
      id: 'invMedia',
      kind: 'inventory',
      title: 'Media inventory',
      short: 'Media',
      producer: 'repo-analyst',
      at: when('Mon 3:00 PM'),
      doc: INV_MEDIA,
    },
    {
      id: 'notes',
      kind: 'platform_notes',
      title: 'Platform Notes',
      short: 'Platform Notes',
      producer: 'research-agent',
      at: when('Mon 1:00 PM'),
      doc: NOTES,
    },
    {
      id: 'pilot',
      kind: 'report',
      title: 'Pilot slice report',
      short: 'Pilot report',
      producer: 'engineering-lead',
      at: when('1:40 PM'),
      doc: PILOT,
    },
    {
      id: 'conformance',
      kind: 'report',
      title: 'Conformance: batch 2',
      short: 'Conformance',
      producer: 'structural-validator',
      at: when('2:00 PM'),
      doc: CONFORMANCE,
    },
    {
      id: 'pr11',
      kind: 'pull_request',
      title: '11 Pilot slice components',
      short: 'PR 11',
      producer: 'component-engineer',
      at: when('1:38 PM'),
      doc: PR11,
    },
    {
      id: 'pr12',
      kind: 'pull_request',
      title: '12 Register batch 2 renderings',
      short: 'PR 12',
      producer: 'rendering-registrar',
      at: when('1:58 PM'),
      doc: PR12,
    },
  ],
  pages: [
    {
      key: 'hero',
      name: 'Hero',
      path: '#hero',
      migrated: true,
      parity: 99,
      visual: 96,
      pilot: true,
    },
    {
      key: 'qa',
      name: 'Quick actions',
      path: '#qa',
      migrated: true,
      parity: 100,
      visual: 98,
      pilot: true,
    },
    {
      key: 'route',
      name: 'Hazard route',
      path: '#route',
      migrated: true,
      parity: 97,
      visual: 95,
      pilot: true,
    },
    { key: 'samples', name: 'Samples', path: '#samples' },
    { key: 'guardian', name: 'Guardian', path: '#guardian' },
    { key: 'slots', name: 'Campaign slots', path: '#slots' },
    { key: 'sustain', name: 'Sustainability', path: '#sustain' },
    { key: 'story', name: 'Story', path: '#story' },
  ],
  preview: {
    source: 'Vite build of ansell-main',
    target: 'SitecoreAI, preview deploy 6',
    targetDeployment: '6',
  },
  credentials: [
    {
      sys: 'GitHub',
      scope: 'repo slamensdicreon/ansell (read), branch write: launchworks/*',
      verified: [TODAY, 8 + 2 / 60],
    },
    {
      sys: 'SitecoreAI Automation client',
      scope: 'xmcloud.cm:admin, xmclouddeploy.*',
      verified: [TODAY, 8 + 2 / 60],
      expiresDays: 29,
    },
    {
      sys: 'Experience Edge',
      scope: 'context ID (delivery, preview)',
      verified: [TODAY, 8 + 2 / 60],
    },
    {
      sys: 'Vercel',
      scope: 'project: ansell-website (deploy, env)',
      verified: [TODAY, 8 + 2 / 60],
    },
  ],
  conventions: [
    ['Head', 'Content SDK Next.js, ported from Vite'],
    ['Naming', 'PascalCase renderings, kebab-case files'],
    ['Grid', 'Tailwind'],
    ['Languages', 'en-US'],
    ['Source of truth', 'Repository (ansell-main)'],
    ['Redirects', '301 for changed slugs'],
    ['Head hosting', 'Vercel (preview per batch)'],
  ],
  settings: { pilotReview: true, publishReview: false },
  live: {
    nowLines: {
      'component-engineer': [
        'Porting SampleKitPromo: starter kits from a Data folder (step 3 of 5)',
        'Porting SampleKitPromo: inline editing on steps (step 4 of 5)',
        'Porting SampleKitPromo: component map entry (step 5 of 5)',
        'Porting GuardianPlanner: priorities from Data',
        'Porting CampaignSlot: owner and campaign ID fields',
      ],
      'rendering-registrar': [
        'Registering HazardRoute: Available Renderings',
        'Registering SampleKitPromo: datasource template',
        'Registering SampleKitPromo: rendering parameters',
        'Registering GuardianPlanner: thumbnail',
        'Serialization push (module: ansell)',
      ],
      'head-integrator': [
        'Watching preview build 7',
        'Preview build 7: compiling the carried-over Tailwind 4 styles',
        'Preview build 7: green, registering editing host',
        'Watching preview build 8',
      ],
      'structural-validator': [
        'Validating batch 2 (3 renderings)',
        'Validating batch 2: inheritance checks',
        'Validating batch 2: Available Renderings',
        'Idle until batch 3 lands',
      ],
      'layout-engineer': [
        'Data templates: Product, Brand, Hazard',
        'Data templates: Topic, Service, Sample Kit',
        'Home page template: standard values',
        'Partial designs: GlobalHeader, GlobalFooter',
      ],
    },
    ops: [
      [
        'rendering-registrar',
        'Authoring API',
        'createItem Renderings/Project/ansell/Page Content/SampleKitPromo',
        '200',
        '398 ms',
        '1.2k',
      ],
      ['component-engineer', 'Sandbox', 'tsc --noEmit', '0', '9 s', '–'],
      [
        'structural-validator',
        'Validators',
        'conformance batch 2: inheritance',
        'pass',
        '4 s',
        '2.1k',
      ],
      ['head-integrator', 'Vercel', 'build 7', 'green', '2 m 31 s', '0.3k'],
      [
        'layout-engineer',
        'Authoring API',
        'createItem Templates/Project/ansell/Sample Kit',
        '200',
        '360 ms',
        '0.9k',
      ],
      ['rendering-registrar', 'Sitecore CLI', 'ser push (module: ansell)', '0', '12.1 s', '0.5k'],
      [
        'component-engineer',
        'GitHub',
        'commit 7c1e Port SampleKitPromo, GuardianPlanner',
        '201',
        '0.8 s',
        '0.4k',
      ],
      ['engineering-lead', 'Review', 'accept SampleKitPromo', 'ok', '–', '5.9k'],
      [
        'rendering-registrar',
        'Authoring API',
        'createItem Templates/Project/ansell/Rendering Parameters/SampleKitPromo Parameters',
        '200',
        '372 ms',
        '1.0k',
      ],
    ],
  },
  escalations: {
    'E-06': () => ({
      id: 'E-06',
      type: 'gate',
      title: 'Pilot slice review',
      reversible: false,
      waitNote: 'Waits for you. Batch 2 continues meanwhile',
      context:
        'Hero, QuickActions and HazardRoute are registered and the home page builds in Page builder on preview deploy 6. HazardRoute reads the 8 hazards from a Data folder instead of corpus.ts.',
      impact:
        'Approving confirms the pattern for the remaining 12 renderings. Sending back holds batch 2 at its next checkpoint.',
      evidence: [
        { label: 'Pilot slice report', go: 'wb:pilot' },
        { label: 'Home page in preview', go: 'preview:#hero' },
        { label: 'Pull request 11', go: 'wb:pr11' },
      ],
      onApprove: async (p) => {
        await p.decide(
          'Pilot slice review',
          'Approved. Pattern confirmed for the remaining 12 renderings',
          'director',
          'pilot-review',
        );
        p.think(900, () =>
          p.say(
            'Pilot slice approved and logged. The pattern is confirmed for the remaining 12 renderings. Batch 2 carries on without a checkpoint hold.',
          ),
        );
      },
      onSendBack: async (p, notes) => {
        await p.moveTask('t4', 'waiting', 'Pilot sent back');
        await p.setAgent('component-engineer', {
          state: 'waiting',
          now: 'Holding at checkpoint: pilot sent back',
        });
        p.think(1200, () =>
          p.say(
            `Noted: “${notes}”. Batch 2 holds at its next checkpoint. The Engineering Lead is re-planning the pilot against your notes and will report within the hour.`,
          ),
        );
      },
    }),
    'E-07': () => ({
      id: 'E-07',
      type: 'decision',
      title: 'Where search reads its content',
      reversible: true,
      context:
        'SearchBody and search-engine.ts (about 930 lines) answer queries from corpus.ts in the browser. Once products, topics and documents live in Sitecore, search needs a new source.',
      impact: 'The search overlay port waits on this. Batch 2 continues on the other components.',
      lead: {
        leadId: 'engineering-lead',
        mode: 'shadow',
        optionIdx: 0,
        reasoning:
          'The Blueprint keeps products, topics and documents in Sitecore, so search should read them from there too.',
      },
      options: [
        { label: SEARCH_OPTS[0]!, rec: true },
        { label: SEARCH_OPTS[1]! },
        { label: SEARCH_OPTS[2]! },
      ],
      defaultIdx: 0,
      deadlineMinutes: 20,
      evidence: [
        { label: 'Blueprint v2, search row', go: 'wb:blueprint' },
        { label: 'Solution Architect', go: 'inspect:solution-architect' },
        {
          label: 'search-engine.ts on GitHub',
          go: 'ext:https://github.com/slamensdicreon/ansell/blob/main/src/lib/search-engine.ts',
        },
      ],
      onResolve: async (p, i, by) => {
        await p.setAgent('component-engineer', {
          state: 'active',
          now:
            i === 0
              ? 'Porting the search overlay to read an index built from Edge'
              : i === 1
                ? 'Stubbing the search overlay for Sitecore Search'
                : 'Keeping corpus.ts as a typed module in the head',
        });
        await p.setAgent('solution-architect', {
          state: 'idle',
          now: 'Consult closed. Standing by for phase 5',
        });
        await p.moveTask('t12', 'done');
        await p.moveTask('p7', 'planned');
        await p.reviseBlueprint((rows) =>
          rows.map((r) =>
            r.key === 'search-overlay'
              ? {
                  ...r,
                  fields:
                    i === 0
                      ? 'Index built from Edge GraphQL at build time'
                      : i === 1
                        ? 'Sitecore Search widget'
                        : 'corpus.ts kept in code',
                  was: 'Reads corpus.ts in the browser',
                }
              : r,
          ),
        );
        const ref = await p.decide(
          'Where search reads its content',
          SEARCH_OPTS[i]!,
          by === 'default' ? 'default' : 'director',
          'blueprint:search-overlay',
        );
        p.think(1400, () =>
          p.say(
            `Logged as ${ref}: ${SEARCH_OPTS[i]}. The search overlay port resumed. Blueprint updated.`,
          ),
        );
      },
      onUndo: async (p) => {
        await p.setAgent('component-engineer', {
          now: 'Search port paused. Porting SampleKitPromo',
        });
      },
    }),
    'E-08': () => ({
      id: 'E-08',
      type: 'access',
      title: 'Thumbnail upload returned 403',
      context:
        'The Authoring API refused the HazardRoute rendering thumbnail with 403. The Automation credential verified at 8:02 AM with xmcloud.cm:admin. The media upload mutation may need an additional scope on this tenant.',
      impact:
        'Rendering Registrar is blocked on thumbnails. Renderings register without them, so Page builder shows blank tiles until this is fixed.',
      options: [
        { label: 'Re-verify the credential and retry the upload', rec: true },
        { label: 'Continue without thumbnails. Retry them in phase 9' },
      ],
      defaultIdx: 0,
      deadlineMinutes: 15,
      reversible: true,
      evidence: [
        { label: 'Failing call in Activity', go: 'activity:uploadMedia' },
        { label: 'Credential scopes in Settings', go: 'settings:credentials' },
      ],
      onResolve: async (p, i) => {
        if (i === 0) {
          await p.setAgent('rendering-registrar', {
            state: 'waiting',
            now: 'Waiting: credential re-verification',
          });
          p.think(2600, async () => {
            await p.setAgent('rendering-registrar', {
              state: 'active',
              now: 'Registering HazardRoute: thumbnail uploaded, Available Renderings',
            });
            await p.log({
              agent: 'tool-server',
              tool: 'Authoring API',
              op: 'verify token scopes',
              code: 'xmcloud.cm:admin',
              ms: '640 ms',
              tok: '–',
            });
            await p.log({
              agent: 'rendering-registrar',
              tool: 'Authoring API',
              op: 'uploadMedia Project/Ansell/Thumbnails/HazardRoute.png (retry)',
              code: '200',
              ms: '1.1 s',
              tok: '0.4k',
            });
            await p.say(
              'Re-verified: the credential carries xmcloud.cm:admin. The 403 was a transient media library lock. The retry returned 200 and the Rendering Registrar resumed with no scope change.',
            );
          });
        } else {
          await p.setAgent('rendering-registrar', {
            state: 'active',
            now: 'Registering HazardRoute without a thumbnail',
          });
          await p.log({
            agent: 'chief-of-staff',
            tool: 'Planner',
            op: 'add task: thumbnails retry (phase 9)',
            code: 'ok',
          });
          p.think(1200, () =>
            p.say(
              'Thumbnails deferred to phase 9 and logged as a Risk. The Rendering Registrar resumed. Page builder tiles for batch 2 stay blank until then.',
            ),
          );
        }
      },
    }),
    'E-09': () => ({
      id: 'E-09',
      type: 'decision',
      title: 'Sample kit requests have nowhere to go',
      reversible: true,
      context:
        'KitRail.tsx collects company, work email, ZIP and consent, then creates an SK-26 reference in the browser. Nothing is sent. VERCEL.md confirms fulfillment is not deployed.',
      impact:
        'Phase 6 cannot finish the Samples experience without a destination. Workflow and integrations are outside this scope, so option A needs an endpoint from Ansell IT.',
      options: [
        { label: KIT_OPTS[0]!, rec: true },
        { label: KIT_OPTS[1]! },
        { label: KIT_OPTS[2]! },
      ],
      defaultIdx: 1,
      deadlineMinutes: 30,
      evidence: [
        { label: 'Blueprint v2, kit rail row', go: 'wb:blueprint' },
        { label: 'Route and content inventory', go: 'wb:invPages' },
      ],
      onResolve: async (p, i, by) => {
        await p.decide(
          'Sample kit request destination',
          KIT_OPTS[i]!,
          by === 'default' ? 'default' : 'director',
          'blueprint:sample-kit-rail',
        );
        p.think(1200, () =>
          p.say(
            i === 0
              ? 'Logged. I will ask Ansell IT for the endpoint through you. Until it arrives, the form posts to a test sink and the request stays open as a Risk.'
              : i === 1
                ? 'Logged. The form keeps its current hand-off to ansell.com. Nothing new is built.'
                : 'Logged. The kit builder ships and the submit step shows a contact link until a later release.',
          ),
        );
      },
    }),
  },
  scenarios: [
    {
      key: 'hero',
      label: 'Raise the search source decision',
      run: async (p) => {
        if (!(await p.raise('E-07'))) return;
        await p.setAgent('component-engineer', {
          now: 'Search port paused. Porting SampleKitPromo',
        });
        await p.say(
          'Search needs a decision on where it reads content once the corpus moves into Sitecore. The card above has my recommendation. The rest of batch 2 is not affected.',
        );
      },
    },
    {
      key: 'kit',
      label: 'Raise the sample kit destination decision',
      run: async (p) => {
        if (!(await p.raise('E-09'))) return;
        await p.say(
          'KitRail collects a request and sends it nowhere today. Phase 6 needs a destination. The card above has the options.',
        );
      },
    },
    {
      key: 'thumb',
      label: 'Raise the thumbnail 403 access blocker',
      run: async (p) => {
        if (p.state.escalations['E-08']) return;
        await p.setAgent('rendering-registrar', {
          state: 'blocked',
          now: 'Blocked: thumbnail upload 403',
        });
        await p.log({
          agent: 'rendering-registrar',
          tool: 'Authoring API',
          op: 'uploadMedia Project/Ansell/Thumbnails/HazardRoute.png',
          code: '403',
          ms: '220 ms',
          tok: '0.4k',
          sev: 'bad',
          note: 'Forbidden. Media upload refused for the Automation client.',
        });
        await p.raise('E-08');
        await p.say(
          'A 403 on the HazardRoute thumbnail upload. I recommend re-verifying the credential and retrying. Renderings keep registering meanwhile.',
        );
      },
    },
    {
      key: 'pilot',
      label: 'Raise the pilot slice review',
      run: async (p) => void (await p.raise('E-06')),
    },
  ],
  open: [['E-06', 22]],
  auto: [
    [6, 'hero'],
    [16, 'thumb'],
  ],
};
