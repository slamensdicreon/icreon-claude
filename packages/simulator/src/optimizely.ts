import type { Workstream } from '@lw/contracts';
import {
  acceptAndClose,
  background,
  blueprintGate,
  byHand,
  enter,
  exit,
  hold,
  kickOff,
  lane,
  sourceOfTruth,
  task,
  work,
  workBatch,
  type Step,
} from './method';
import type { Simulation } from './simulation';

/**
 * The scripted engagement for the Optimizely CMS (SaaS) website playbook
 * (`playbooks/optimizely-saas-migration`). The method is the one every scenario shares
 * (`method.ts`); the tasks are the playbook's own plan, expanded over the site below, so their
 * ids, roles, titles and phases are what a real project of that playbook shows. What is written
 * here is the platform's side: the order it sets (content types, then the application, then
 * content, published as it is built) and the calls the team makes on its tool servers.
 */

interface Item {
  key: string;
  name: string;
  pilot?: boolean;
  status?: 'merge';
}

const numbered = (key: string, name: string, count: number): Item[] =>
  Array.from({ length: count }, (_, i) => ({ key: `${key}-${i + 1}`, name: `${name} ${i + 1}` }));

/**
 * Fixture site: the playbook's example Blueprint (`fixtures/blueprint.example.yaml`), a mid-size
 * corporate site with a blog.
 */
export const OPTIMIZELY_SITE: Record<'components' | 'templates' | 'pages' | 'media', Item[]> = {
  components: [
    { key: 'hero', name: 'Hero', pilot: true },
    { key: 'promo-card', name: 'PromoCard', pilot: true },
    { key: 'rich-text', name: 'RichText', pilot: true },
    { key: 'header', name: 'Header' },
    { key: 'footer', name: 'Footer' },
    { key: 'card-grid', name: 'CardGrid' },
    { key: 'testimonial', name: 'Testimonial' },
    { key: 'cta-banner', name: 'CtaBanner' },
    { key: 'accordion', name: 'Accordion' },
    { key: 'tabs', name: 'Tabs' },
    { key: 'image-gallery', name: 'ImageGallery' },
    { key: 'video-embed', name: 'VideoEmbed' },
    { key: 'navigation', name: 'Navigation', status: 'merge' },
    { key: 'breadcrumb', name: 'Breadcrumb' },
    { key: 'stats-strip', name: 'StatsStrip' },
    { key: 'logo-wall', name: 'LogoWall' },
  ],
  templates: [
    { key: 'home', name: 'Home Page' },
    { key: 'landing', name: 'Landing Page' },
    { key: 'article', name: 'Article Page' },
    { key: 'listing', name: 'Listing Page' },
    { key: 'blog-post', name: 'Blog Post' },
  ],
  pages: [...numbered('page', 'Page', 40), ...numbered('blog', 'Blog post', 8)],
  media: numbered('media', 'Media item', 120),
};

const {
  components: COMPONENTS,
  templates: TEMPLATES,
  pages: PAGES,
  media: MEDIA,
} = OPTIMIZELY_SITE;
/** The header, footer and navigation: every page shows them, so they are built with the pilot. */
const SHARED = COMPONENTS.filter((c) => /header|footer|nav|menu/i.test(c.key));
const SLICE = COMPONENTS.filter((c) => c.pilot || SHARED.includes(c));
/** Experience types get a blueprint; a page type's properties are its layout. */
const PAGE_TYPES = new Set(['article', 'blog-post']);
/** What the project has: a source repository. Experimentation is not licensed. */
const FEATURES = ['source-repo'];
const PAGE_BATCH = 8;
const MEDIA_BATCH = 20;
/** Pages and media are many small calls: each takes less simulated time than a build step. */
const BATCH_STEP_SECONDS = 0.3;

/** The instance as intake would have recorded it, from the client's name. */
function instance(sim: Simulation) {
  const words = sim.opts.client.match(/[A-Za-z0-9]+/g) ?? ['Site'];
  const project = `${words.join('-').toLowerCase()}-website`;
  // An application's key takes letters, digits and underscores; paths use the key.
  const application = `${words.join('_')}_Website`;
  return {
    application,
    /** Content types are shared by every application on the instance: this project's carry it. */
    prefix: words
      .map((w) => w[0]!.toUpperCase() + w.slice(1))
      .join('')
      .slice(0, 20),
    project,
    production: `${project}.vercel.app`,
    editing: `${project}-editing.vercel.app`,
    content: `/content/${application}`,
    shared: `/shared/${application}`,
    media: `/media/${application}`,
  };
}

interface Planned {
  role: string;
  title: string;
  manual?: string;
  acceptance: string[];
}

/** The project's plan and team: the playbook's tasks, each done by its role, one at a time. */
function engagement(sim: Simulation) {
  const { plan, roles } = sim.playbook;
  const planned = new Map<string, Planned>();
  const lanes = new Map<string, ReturnType<typeof lane>>();
  const of = (taskId: string) => {
    const t = planned.get(taskId);
    if (!t) throw new Error(`${taskId} is not in the plan of ${sim.playbook.manifest.id}`);
    return t;
  };
  /** A role's tasks queue: an agent does one thing at a time. */
  const queue = (role: string) => {
    if (!lanes.has(role)) lanes.set(role, lane());
    return lanes.get(role)!;
  };
  const roleName = (role: string) => roles.find((r) => r.role === role)?.name ?? role;
  return {
    sim,
    ...instance(sim),
    roleName,
    /** "Active: …" for a phase brief, from the playbook's roster. */
    active: (phase: number) =>
      `Active: ${roles
        .filter(
          (r) =>
            r.tier === 'specialist' &&
            Array.isArray(r.activePhases) &&
            r.activePhases.includes(phase),
        )
        .map((r) => r.name)
        .join(', ')}.`,
    /**
     * Plans every task the playbook has in a phase: one per Blueprint item for a `forEach`
     * template, with the plan's dependencies among the tasks planned so far.
     */
    async plan(phase: number) {
      const made = plan.templates
        .filter(
          (t) =>
            t.phase === phase &&
            (!t.when || FEATURES.includes(t.when)) &&
            !(t.unless && FEATURES.includes(t.unless)),
        )
        .flatMap((t) =>
          (t.forEach
            ? (OPTIMIZELY_SITE[t.forEach as keyof typeof OPTIMIZELY_SITE] ?? [])
            : [null]
          ).map((item) => ({ t, item, taskId: t.id.replace('{key}', item?.key ?? '') })),
        );
      const ids = [...planned.keys(), ...made.map((m) => m.taskId)];
      const tasks = made.map(({ t, item, taskId }) => {
        const title = t.title.replace('{name}', item?.name ?? '');
        planned.set(taskId, {
          role: t.role,
          title,
          manual: t.manual,
          acceptance: t.acceptance.map((a) => a.replace(/^validator:/, '')),
        });
        const dependsOn = (t.dependsOn ?? []).flatMap((pattern) => {
          if (pattern.includes('{shared}'))
            return SHARED.map((s) => pattern.replace('{shared}', s.key));
          const bound = pattern.replaceAll('{key}', item?.key ?? '');
          return bound.endsWith('*')
            ? ids.filter((id) => id.startsWith(bound.slice(0, -1)))
            : [bound];
        });
        return task(
          taskId,
          t.role,
          title,
          (roles.find((r) => r.role === t.role)?.workstream ?? null) as Workstream | null,
          [...new Set(dependsOn)].filter((id) => id !== taskId && ids.includes(id)),
        );
      });
      await sim.planTasks(phase, tasks);
    },
    /** A planned task's turn in its role's queue. */
    task<T>(taskId: string, job: (agentId: string) => Promise<T>): Promise<T> {
      const { role } = of(taskId);
      return queue(role)(() => job(role));
    },
    /** The checks the plan names for a task, as the Lead's review runs them. */
    checks(taskId: string): Step | undefined {
      const { acceptance } = of(taskId);
      return acceptance.length
        ? ['acceptance', 'check', `Acceptance: ${acceptance.join(', ')}`]
        : undefined;
    },
    /** Runs a planned task by its role, then its checks. */
    run(taskId: string, label: string, steps: Step[]) {
      return this.task(taskId, (agentId) =>
        work(sim, agentId, taskId, label, steps, { validator: this.checks(taskId) }),
      );
    },
    /** One session of a role over a batch of its tasks; `each` makes one task's calls. */
    batch(
      taskIds: string[],
      label: string,
      each: (
        call: (server: string, op: string, summary: string, code?: number) => Promise<void>,
        index: number,
      ) => Promise<void>,
    ) {
      return this.task(taskIds[0]!, (agentId) =>
        workBatch(sim, agentId, taskIds, label, (taskId, index) =>
          each(
            (server, op, summary, code) =>
              sim.step(agentId, taskId, server, op, summary, {
                simSeconds: BATCH_STEP_SECONDS,
                ...(code ? { code, severity: 'warning' as const } : {}),
              }),
            index,
          ),
        ),
      );
    },
    /** A plan task with a `manual` checklist: the Director's, by hand. */
    byHand(taskId: string) {
      const t = of(taskId);
      return byHand(sim, taskId, t.title, t.manual ?? t.title);
    },
  };
}
type Engagement = ReturnType<typeof engagement>;

/** `PromoCard` is the content type `<prefix>PromoCard`; `Home Page` is `<prefix>HomePage`. */
const typeOf = (e: Engagement, item: Item) => `${e.prefix}${item.name.replace(/\s+/g, '')}`;

export async function optimizelyScenario(sim: Simulation): Promise<void> {
  const e = engagement(sim);
  // In the platform's words: the playbook's stat cards (Content types, Experiences) and tool
  // names (CMS REST API, Optimizely Graph).
  await kickOff(sim, { labelled: true });

  // Phase 0 — Intake and access verification
  await enter(sim, 0, [
    'Produces: verified credentials and instance facts.',
    `${e.active(0)} A read-only probe.`,
    "Exit: every credential verified against its endpoint, and the API key's content rights confirmed by you.",
  ]);
  await e.plan(0);
  // No read shows whether the key may write content, and the first content write comes after
  // Gate 1: the Director confirms it in the CMS while the probe runs.
  const rights = background(e.byHand('confirm-content-rights'));
  await e.run('verify-access', 'Verifying access', [
    ['optimizely-cms', 'application.list', '2 applications on the instance'],
    ['optimizely-cms', 'locale.list', 'Enabled locales: en, fr-CA'],
    [
      'optimizely-cms',
      'contenttype.list',
      `0 content types with the prefix ${e.prefix} (41 on the instance)`,
    ],
    ['optimizely-graph', 'graph.routes', '37 published pages in Graph across every application'],
    ['hosting', 'project.read', 'Vercel team reachable'],
  ]);
  await rights;
  await exit(
    sim,
    0,
    [
      '4 of 4 credentials verified: CMS REST API key, Optimizely Graph single key, GitHub, Vercel.',
      `Instance: 2 applications, none named ${e.application}; no content type carries the prefix ${e.prefix}. Content rights confirmed by you.`,
    ],
    [1],
  );

  // Phase 1 — Discovery
  await enter(sim, 1, [
    'Produces: component inventory, page inventory, asset manifest, risk list.',
    e.active(1),
    'Exit: every sitemap URL crawled or excluded.',
  ]);
  await e.plan(1);
  await Promise.all([
    e
      .run('inventory-repo', 'Analysing the repository', [
        ['github', 'tree.read', `Read 63 modules; ${COMPONENTS.length} candidate components`],
        ['model', 'analyse', 'Classified components: 11 content, 3 structural, 2 navigation'],
        ['artifacts', 'write', 'Component inventory v1'],
      ])
      .then(() =>
        sim.artifact('component-inventory', 'inventory', 'Component inventory', 1, 'repo-analyst'),
      ),
    e
      .run('crawl-site', 'Crawling the live site', [
        ['browser', 'crawl.start', `Crawling ${PAGES.length + 3} sitemap URLs`],
        [
          'browser',
          'crawl.status',
          `Crawled ${PAGES.length} of ${PAGES.length + 3} sitemap URLs; 3 excluded (PDF)`,
        ],
        ['model', 'analyse', 'Found header, footer and promo strip as repeated regions'],
        ['artifacts', 'write', 'Page inventory v1'],
      ])
      .then(() =>
        sim.artifact('page-inventory', 'inventory', 'Page inventory', 1, 'content-analyst'),
      ),
    e
      .run('platform-notes', 'Verifying platform facts', [
        ['research', 'web.search', 'CMS (SaaS): REST API v1 is current; Preview3 is retired'],
        [
          'research',
          'web.fetch',
          'JavaScript SDK and CLI 3.1: content types and display templates are defined in code',
        ],
        ['artifacts', 'write', 'Platform Notes v1 (9 citations)'],
      ])
      .then(() =>
        sim.artifact('platform-notes', 'platform_notes', 'Platform Notes', 1, 'research-agent'),
      ),
  ]);
  void sim
    .escalate({
      type: 'risk',
      title: 'Contact form needs a submission endpoint',
      context:
        "The source contact form posts to the old site's server. The form renders through the Optimizely SDK, but the client owns the endpoint its submissions go to.",
      impact: 'The form ships as a component; submissions need an endpoint before launch.',
      options: [{ id: 'ack', label: 'Acknowledge', recommended: true }],
      defaultOptionId: 'ack',
      deadlineSimSeconds: 600,
      sourceTaskId: 'inventory-repo',
    })
    .catch(() => {});
  await exit(
    sim,
    1,
    [
      `${COMPONENTS.length} components, ${PAGES.length} pages, ${MEDIA.length} media items inventoried.`,
      '1 integration risk logged.',
    ],
    [2],
  );

  // Phase 2 — Blueprint (Gate 1)
  await enter(sim, 2, [
    'Produces: the Implementation Blueprint.',
    e.active(2),
    'Exit: your approval at Gate 1.',
  ]);
  await e.plan(2);
  const sot = sourceOfTruth(sim, 'draft-blueprint', e.roleName('content-migrator'));
  const mapped = `${COMPONENTS.length} components map to ${COMPONENTS.length} content types with the prefix ${e.prefix}, each with a default display template, and ${PAGES.length} pages to ${TEMPLATES.length} page and experience types`;
  await e.run('draft-blueprint', 'Drafting the Blueprint', [
    ['blackboard', 'read', 'Loaded inventories and Platform Notes'],
    [
      'model',
      'map.components',
      `Mapped ${COMPONENTS.length} components to content types: section or element, display templates, list limits`,
    ],
    [
      'model',
      'map.pages',
      `Mapped ${PAGES.length} pages to ${TEMPLATES.length} page and experience types`,
    ],
    ['blackboard', 'write.blueprint', 'Blueprint v1 written'],
  ]);
  await sot;
  const version = await blueprintGate(sim, 'draft-blueprint', {
    context: `${mapped}. The header, footer and navigation are shared blocks every page shows.`,
    impact: 'Foundation, content types and the application start when you approve.',
  });
  await exit(
    sim,
    2,
    [
      `Blueprint v${version} approved.`,
      'The model contract is now locked: type keys, properties, display templates.',
    ],
    [3],
  );

  // Phase 3 — Foundation. The application is not made here: it needs its start page, of a type
  // that reaches the CMS in phase 4.
  await enter(sim, 3, [
    'Produces: design tokens and primitives, and the head on Vercel.',
    e.active(3),
    'Exit: the head answers on Vercel, with Vercel Authentication off so Visual Builder can frame it.',
  ]);
  await e.plan(3);
  await Promise.all([
    e.run('design-system', 'Extracting the design system', [
      ['sandbox', 'workspace.open', 'Working copy on launchworks/design-system'],
      ['browser', 'page.styles', 'Read colours, type scale and spacing from 6 source pages'],
      ['sandbox', 'fs.write', 'Wrote 9 files: tokens, type scale, spacing, primitives'],
      ['sandbox', 'exec.build', 'Build green: type-check and build passed'],
      ['sandbox', 'git.commit', 'Committed to launchworks/design-system'],
    ]),
    e.run('prepare-hosting', 'Preparing hosting', [
      [
        'hosting',
        'project.create',
        `Vercel project ${e.project} created; Vercel Authentication off`,
      ],
      [
        'hosting',
        'env.set',
        `Set 4 variables on ${e.project}: OPTIMIZELY_CMS_URL, OPTIMIZELY_GRAPH_GATEWAY, OPTIMIZELY_DEFAULT_LOCALE, OPTIMIZELY_GRAPH_SINGLE_KEY`,
      ],
      ['hosting', 'deploy.production', 'Deploying main to production'],
      ['hosting', 'deploy.status', `READY at ${e.production}`],
    ]),
  ]);
  await exit(
    sim,
    3,
    [
      `Design tokens and primitives extracted; the head answers on ${e.production}.`,
      "The application comes in phase 4, once its start page's type is in the CMS.",
    ],
    [4, 5],
  );

  // Phases 4 and 5 open together. The shell and the blueprints need the application, so their
  // work starts once the pilot slice has proven it, beside the rest of the components.
  await enter(sim, 4, [
    'Produces: content types and display templates in the CMS, the application on its hosts, the pilot slice.',
    e.active(4),
    'Exit: every Blueprint component pushed and enabled in Visual Builder. Pilot slice first.',
  ]);
  await sim.metric('components_registered', 0, COMPONENTS.length);
  await e.plan(4);
  await enter(sim, 5, [
    'Produces: the shared header and footer, and a blueprint per experience type.',
    e.active(5),
    'Exit: the header and footer render on every page; every experience type has a blueprint.',
  ]);
  await e.plan(5);
  const open = new Set([4, 5]);
  let proven!: () => void;
  const pilot = new Promise<void>((resolve) => (proven = resolve));
  await Promise.all([contentTypes(e, open, proven), siteShell(e, open, pilot)]);

  // Phase 6 — Content and media migration
  await enter(sim, 6, [
    'Produces: migrated pages and media. Each page is published when it is built, so the head renders it.',
    e.active(6),
    'Exit: content parity at or above 98%.',
  ]);
  await sim.metric('pages_migrated', 0, PAGES.length);
  await sim.metric('media_uploaded', 0, MEDIA.length);
  await e.plan(6);
  await Promise.all([
    uploadMedia(e),
    migratePages(e),
    e.run('recrawl-source', 'Re-crawling the source', [
      ['browser', 'crawl.start', `Re-crawling ${PAGES.length} source pages for parity`],
      ['browser', 'crawl.status', `Crawled ${PAGES.length} of ${PAGES.length} pages`],
      ['artifacts', 'write', 'Parity inventory v1'],
    ]),
  ]);
  await Promise.all([
    e
      .run('audit-parity', 'Auditing parity', [
        [
          'optimizely-graph',
          'graph.query',
          `Graph query answered: ${PAGES.length} published pages on ${e.production}`,
        ],
        ['artifacts', 'write', 'Content parity report: 98.6% (2 pages with embeds flagged)'],
      ])
      .then(() =>
        sim.artifact('parity-report', 'report', 'Content parity report', 1, 'parity-auditor'),
      ),
    e.run('visual-sample', 'Comparing screenshots', [
      ['browser', 'screenshot', 'Captured 6 pages at 3 breakpoints, source and head'],
      ['validators', 'visual.diff', '6 of 6 pages within tolerance'],
    ]),
  ]);
  await sim.metric('parity', 98.6);
  await exit(
    sim,
    6,
    [
      `${PAGES.length} of ${PAGES.length} pages published, ${MEDIA.length} of ${MEDIA.length} media items uploaded with alt text.`,
      'Parity 98.6%; 2 exceptions listed in the parity report.',
    ],
    [7],
  );

  // Phase 7 — Experience enablement. Routing lives in the head on this platform; SEO values
  // live on the pages.
  await enter(sim, 7, [
    'Produces: redirects, sitemap, robots and error pages in the head; SEO properties on every page.',
    e.active(7),
    'Exit: redirects resolve on the editing host.',
  ]);
  await e.plan(7);
  await Promise.all([
    e.run('routing-and-seo', 'Adding routing to the head', [
      ['blackboard', 'read', 'Read the Blueprint: 14 source URLs move'],
      [
        'sandbox',
        'fs.write',
        'Added 14 redirects, sitemap.xml, robots.txt, not-found and error pages',
      ],
      ['sandbox', 'exec.build', 'Build green: type-check and build passed'],
      [
        'sandbox',
        'git.integrate',
        'Integrated launchworks/routing-and-seo into launchworks/integration, build green, pushed',
      ],
      ['hosting', 'deploy.status', `READY, live as the editing host at ${e.editing}`],
    ]),
    e.run('seo-properties', 'Filling SEO properties', [
      ['browser', 'snapshot', `Read title and meta description of ${PAGES.length} source pages`],
      [
        'optimizely-cms',
        'content.update',
        `Set SEO title and description on ${PAGES.length} pages (drafts)`,
      ],
    ]),
  ]);
  await exit(
    sim,
    7,
    [
      'Redirects, sitemap, robots and error pages live on the editing host.',
      `SEO properties set on ${PAGES.length} pages, as drafts the final publish releases.`,
    ],
    [8],
  );

  // Phase 8 — Deployment and publishing. Three separate steps: success in one proves nothing
  // about the others.
  await enter(sim, 8, [
    'Produces: the reviewed commit on the editing and delivery hosts, the content model in the repository, every page published.',
    e.active(8),
    'Exit: every route resolves through Optimizely Graph; Visual Builder smoke test, by hand.',
  ]);
  await e.plan(8);
  await e.run('finalize-head', 'Finalizing the head', [
    [
      'sandbox',
      'git.integrate',
      'Integrated every accepted branch into launchworks/integration, build green, pushed',
    ],
    ['hosting', 'project.read', `${e.project}: variables match the application's hosts`],
  ]);
  await Promise.all([
    e.run('export-manifest', 'Exporting the content model', [
      [
        'optimizely-cms',
        'manifest.export',
        `Manifest: content types and display templates with the prefix ${e.prefix}`,
      ],
      ['sandbox', 'fs.write', 'Wrote cms/manifest.json'],
      [
        'sandbox',
        'exec.optimizely-cli',
        'push-dry-run: the repository builds the same content model (nothing sent)',
      ],
      ['sandbox', 'git.commit', 'Committed cms/manifest.json to launchworks/export-manifest'],
    ]),
    (async () => {
      await e.run('deploy-code', 'Deploying', [
        ['build-repo', 'branch.promote', 'main fast-forwarded to the reviewed commit'],
        ['hosting', 'deploy.production', 'Deploying main to production'],
        ['hosting', 'deploy.status', `READY at ${e.production}: the reviewed commit`],
      ]);
      await e.run('publish-site', 'Publishing', [
        [
          'optimizely-cms',
          'content.publish',
          `Published the final versions of ${PAGES.length} pages; Optimizely Graph indexes them within moments`,
        ],
        [
          'optimizely-graph',
          'graph.routes',
          `${PAGES.length} published pages in Graph on ${e.production}`,
        ],
      ]);
      await e.run('perf-a11y-audit', 'Auditing performance and accessibility', [
        ['validators', 'lighthouse.run', 'Performance 94, LCP 2.1 s on 5 representative pages'],
        ['validators', 'axe.run', '0 critical, 3 minor accessibility findings'],
      ]);
    })(),
  ]);
  // Visual Builder has no driver yet: a person edits in it at the smoke test and at acceptance.
  await e.byHand('smoke-test');
  await exit(
    sim,
    8,
    [
      'The reviewed commit runs on both hosts; the content model replays from the repository.',
      `${PAGES.length} routes resolve through Optimizely Graph; Visual Builder smoke test done by hand.`,
    ],
    [9],
  );

  // Phase 9 — Handover and acceptance (Gate 2): the Director accepts in the live systems.
  await enter(sim, 9, [
    'Produces: the handover pack, with your acceptance checklist.',
    e.active(9),
    'Exit: your acceptance at Gate 2, in the live systems.',
  ]);
  await e.plan(9);
  await e.run('handover-pack', 'Writing the handover pack', [
    ['decision-log', 'read', 'Read the Decision Log'],
    [
      'artifacts',
      'write',
      `Runbook, component catalog (${COMPONENTS.length} content types), known gaps (2), acceptance checklist`,
    ],
  ]);
  await acceptAndClose(
    sim,
    9,
    'The handover pack lists each Definition of Done row with what to check in Visual Builder and on the delivery host, and the evidence the build already has.',
  );
}

/**
 * Phase 4: content types first, page types included; then the application, which can't exist
 * without its start page; then the pilot slice, proven end to end before the rest is built.
 */
async function contentTypes(e: Engagement, open: Set<number>, proven: () => void) {
  const { sim } = e;
  let pushed = 0;
  /** One component: built on its branch, then integrated and its content type pushed. */
  const build = async (c: Item) => {
    await port(e, c);
    await e.run(`integrate-${c.key}`, `Integrating ${c.name}`, [
      [
        'sandbox',
        'git.integrate',
        `Integrated launchworks/port-${c.key} into launchworks/integration, build green, pushed`,
      ],
      [
        'sandbox',
        'exec.optimizely-cli',
        `push: ${typeOf(e, c)} and its display templates are in the CMS`,
      ],
      ['hosting', 'deploy.status', `READY, live as the editing host at ${e.editing}`],
    ]);
    pushed++;
    await sim.metric('components_registered', pushed, COMPONENTS.length);
  };
  /** A page template: a page or experience type in code, pushed once the shell's types are in. */
  const pageType = async (t: Item) => {
    const kind = PAGE_TYPES.has(t.key) ? 'page' : 'experience';
    await e.run(`define-type-${t.key}`, `Defining ${t.name}`, [
      [
        'sandbox',
        'fs.write',
        `${t.name.replace(/\s+/g, '')}.model.ts: ${kind} type ${typeOf(e, t)}, with the header and footer it shows`,
      ],
      ['sandbox', 'exec.build', 'Build green: type-check and build passed'],
      [
        'sandbox',
        'exec.optimizely-cli',
        `push-dry-run: content model valid, ${typeOf(e, t)} (nothing sent)`,
      ],
      ['sandbox', 'git.commit', `Committed to launchworks/define-type-${t.key}`],
    ]);
    await e.run(`push-type-${t.key}`, `Integrating ${t.name}`, [
      [
        'sandbox',
        'git.integrate',
        `Integrated launchworks/define-type-${t.key} into launchworks/integration, build green, pushed`,
      ],
      ['sandbox', 'exec.optimizely-cli', `push: ${typeOf(e, t)} is in the CMS`],
      ['hosting', 'deploy.status', `READY, live as the editing host at ${e.editing}`],
    ]);
  };

  await Promise.all([
    e.run('integrate-head', 'Configuring the head', [
      ['sandbox', 'workspace.open', 'Working copy on launchworks/integrate-head'],
      [
        'sandbox',
        'fs.write',
        'Configured the SDK, the catch-all route and the /preview route; removed src/instrumentation.ts',
      ],
      ['sandbox', 'exec.build', 'Build green: type-check and build passed'],
      [
        'sandbox',
        'git.integrate',
        'Integrated 2 branches into launchworks/integration, build green, pushed',
      ],
      ['hosting', 'deploy.preview', 'Deploying launchworks/integration to preview'],
      ['hosting', 'deploy.status', `READY, live as the editing host at ${e.editing}`],
    ]),
    ...SLICE.map(build),
    ...TEMPLATES.map(pageType),
  ]);

  const home = TEMPLATES[0]!;
  const types = SLICE.length + TEMPLATES.length;
  // The first content write: an API key without content rights stops here.
  await e.run('provision-application', 'Creating the application', [
    ['optimizely-cms', 'contenttype.list', `${types} content types with the prefix ${e.prefix}`],
    [
      'optimizely-cms',
      'application.create',
      `Created application ${e.application} with its start page (${typeOf(e, home)}, draft)`,
    ],
    [
      'optimizely-cms',
      'hostname.add',
      `${e.production} is now the primary host of ${e.application}`,
    ],
    ['optimizely-cms', 'hostname.add', `${e.editing} is now the preview host of ${e.application}`],
    [
      'optimizely-cms',
      'preview.configure',
      "Live preview opens /preview on the application's host, with preview tokens",
    ],
    [
      'optimizely-cms',
      'application.read',
      `Application ${e.application}: ${e.production}, ${e.editing}`,
    ],
    ['hosting', 'env.set', `Set 1 variable on ${e.project}: OPTIMIZELY_APPLICATION_HOST`],
  ]);
  const sections = COMPONENTS.filter((c) => c.pilot);
  await Promise.all([
    e.run('validate-foundation', 'Validating the application', [
      [
        'optimizely-cms',
        'application.read',
        `Application ${e.application}: ${e.production}, ${e.editing}`,
      ],
      ['optimizely-cms', 'content.read', `${typeOf(e, home)} "Home" at ${e.content}: draft`],
    ]),
    e.run('compose-pilot', 'Composing the pilot experience', [
      ['browser', 'snapshot', `Read the source home page: ${sections.length} sections of copy`],
      [
        'optimizely-cms',
        'composition.write',
        `Composed ${e.content}: ${sections.length} sections (draft)`,
      ],
      [
        'optimizely-cms',
        'content.publish',
        `Published ${e.content} (version 1); Optimizely Graph indexes it within moments`,
      ],
      ['optimizely-graph', 'graph.item', 'Home is in Graph: Published at /en/'],
    ]),
  ]);
  await e.run('prove-pilot-slice', 'Proving the pilot slice', [
    ['optimizely-cms', 'content.read', `${typeOf(e, home)} "Home" at ${e.content}: published`],
    [
      'optimizely-graph',
      'graph.query',
      `Graph query answered: the home page and its ${sections.length} sections`,
    ],
    ['artifacts', 'write', 'Pilot report: types pushed, sections enabled, preview route answers'],
  ]);
  await sim.say(
    'text',
    'Pilot slice ready',
    `${sections.map((c) => c.name).join(', ')} and the shared header, footer and navigation work end to end: content types in the CMS, an experience composed from them, published, served by Optimizely Graph and rendered by the head. Scaling to the remaining ${COMPONENTS.length - SLICE.length} components.`,
  );
  proven();

  await Promise.all(COMPONENTS.filter((c) => !SLICE.includes(c)).map(build));
  await e.run('validate-components', 'Validating content types', [
    [
      'optimizely-cms',
      'contenttype.list',
      `${COMPONENTS.length + TEMPLATES.length} content types with the prefix ${e.prefix}`,
    ],
    [
      'optimizely-cms',
      'displaytemplate.list',
      `Every section-enabled type has a default display template with the prefix ${e.prefix}`,
    ],
  ]);
  open.delete(4);
  await exit(
    sim,
    4,
    [
      `${COMPONENTS.length} of ${COMPONENTS.length} content types pushed and enabled in Visual Builder.`,
      `Application ${e.application} on ${e.production}, with live preview on ${e.editing}.`,
    ],
    [...open, 6],
  );
}

/**
 * One component on its branch: the content type and display templates in a model file, the React
 * component beside it. Hero is rejected twice, then needs the Director.
 */
function port(e: Engagement, c: Item) {
  const { sim } = e;
  const id = `port-${c.key}`;
  const type = typeOf(e, c);
  return e.task(id, async (agentId) => {
    const result = await work(
      sim,
      agentId,
      id,
      `Building ${c.name}`,
      [
        [
          'sandbox',
          'fs.write',
          `${c.name}.model.ts and ${c.name}.tsx: content type ${type}, default display template ${type}Default`,
        ],
        ['sandbox', 'exec.build', 'Build green: type-check and build passed'],
        [
          'sandbox',
          'exec.optimizely-cli',
          `push-dry-run: content model valid, ${type} and ${type}Default (nothing sent)`,
        ],
        ['sandbox', 'git.commit', `Committed to launchworks/${id}`],
      ],
      { rejectTimes: c.key === 'hero' ? 3 : 0, validator: e.checks(id) },
    );
    if (result !== 'escalate') return;
    await hold(
      sim,
      agentId,
      id,
      {
        reason: 'Rejected twice; escalated',
        now: `Blocked: ${c.name} variants decision`,
        resumed: 'Decision applied',
      },
      {
        type: 'decision',
        title: `${c.name} variants`,
        context: `The source ${c.name} has five layouts driven by props. One content type with a display template per layout keeps Visual Builder simple; five content types give editors five components to choose from.`,
        impact: `${c.name}'s content type and 9 pages that use it wait. Other components continue.`,
        options: [
          {
            id: 'one',
            label: 'One content type, a display template per layout',
            recommended: true,
          },
          { id: 'five', label: 'Five separate content types' },
        ],
        defaultOptionId: 'one',
        deadlineSimSeconds: 120,
        sourceTaskId: id,
      },
    );
    await sim.step(agentId, id, 'sandbox', 'fs.write', `${c.name}.model.ts reworked per decision`);
    await sim.move(id, 'validating');
    await sim.move(id, 'done');
  });
}

/** Phase 5: the shared header and footer, filled once and published, and the blueprints. */
async function siteShell(e: Engagement, open: Set<number>, pilot: Promise<void>) {
  const { sim } = e;
  await pilot;
  const home = TEMPLATES[0]!;
  await e.run('migrate-shared-chrome', 'Creating the shared header and footer', [
    [
      'optimizely-cms',
      'content.create',
      `Created ${e.prefix}Navigation "Main Navigation" at ${e.shared}/Main Navigation (draft)`,
    ],
    [
      'optimizely-cms',
      'content.create',
      `Created ${e.prefix}Header "Site Header" at ${e.shared}/Site Header (draft)`,
    ],
    [
      'optimizely-cms',
      'content.create',
      `Created ${e.prefix}Footer "Site Footer" at ${e.shared}/Site Footer (draft)`,
    ],
    ['optimizely-cms', 'content.update', `Set header, footer on ${e.content} (draft)`],
    [
      'optimizely-cms',
      'content.publish',
      `Published the navigation, the header, the footer, then ${e.content}; Optimizely Graph indexes them within moments`,
    ],
  ]);

  const experiences = TEMPLATES.filter((t) => !PAGE_TYPES.has(t.key));
  for (const t of TEMPLATES) {
    const id = `blueprint-${t.key}`;
    const type = typeOf(e, t);
    if (PAGE_TYPES.has(t.key)) {
      await e.run(id, `Checking ${t.name}`, [
        [
          'optimizely-cms',
          'contenttype.read',
          `Content type ${type}: a page type, its properties are its layout; no blueprint to make`,
        ],
      ]);
      continue;
    }
    await e.task(id, async (agentId) => {
      await sim.move(id, 'ready');
      await sim.move(id, 'running');
      await sim.agent(agentId, 'active', `Creating ${t.name} blueprint`, id);
      await sim.step(agentId, id, 'optimizely-cms', 'contenttype.read', `Content type ${type}`);
      if (t === home) {
        // Blueprints have a right of their own, separate from content rights.
        await sim.step(
          agentId,
          id,
          'optimizely-cms',
          'blueprint.create',
          'The API key may not create blueprints on this instance',
          { code: 403 },
        );
        await hold(
          sim,
          agentId,
          id,
          {
            reason: 'Access: blueprint.create 403',
            now: 'Blocked: the CMS refuses blueprints with 403',
            resumed: 'Credential re-verified',
          },
          {
            type: 'blocker',
            title: 'Blueprint creation 403',
            context:
              'The CMS refuses blueprint.create with 403: the API key may not create blueprints. That is a right of its own, separate from the content rights you confirmed in phase 0; pages and shared blocks publish fine.',
            impact: `${experiences.length} blueprints wait. Components and content types continue.`,
            options: [
              {
                id: 'reverify',
                label: 'I gave the key the blueprint right; re-verify and continue',
                recommended: true,
              },
              { id: 'skip', label: 'Skip for now; editors save blueprints in Visual Builder' },
            ],
            defaultOptionId: null,
            sourceTaskId: id,
            evidence: [{ kind: 'log', label: 'Refused call', ref: `task:${id}` }],
          },
        );
      }
      await sim.step(
        agentId,
        id,
        'optimizely-cms',
        'blueprint.create',
        `Created blueprint "${t.name}" for ${type}: 3 sections`,
      );
      await sim.move(id, 'validating');
      await sim.move(id, 'done');
      await sim.agent(agentId, 'idle', null, null);
    });
  }
  await e.run('validate-templates', 'Validating page types and blueprints', [
    [
      'optimizely-cms',
      'contenttype.list',
      `${TEMPLATES.length} page and experience types with the prefix ${e.prefix}`,
    ],
    [
      'optimizely-cms',
      'content.read',
      `${e.prefix}Header "Site Header" at ${e.shared}/Site Header: published`,
    ],
  ]);
  open.delete(5);
  await exit(
    sim,
    5,
    [
      'Header and footer published; they render on every page.',
      `${experiences.length} blueprints for the experience types; ${PAGE_TYPES.size} page types need none.`,
    ],
    [...open, 6],
  );
}

/** Phase 6: every image to the application's own media, with its alt text, in sessions of 20. */
async function uploadMedia(e: Engagement) {
  const { sim } = e;
  let uploaded = 0;
  for (let i = 0; i < MEDIA.length; i += MEDIA_BATCH) {
    const items = MEDIA.slice(i, i + MEDIA_BATCH);
    await e.batch(
      items.map((m) => `upload-media-${m.key}`),
      `Uploading media ${i + 1}–${i + items.length}`,
      async (call, n) => {
        const file = `${items[n]!.key}.webp`;
        if (i === 2 * MEDIA_BATCH && n === 0) {
          // The image type takes no AVIF: the agent fetches the image again in a format it does.
          await call(
            'optimizely-cms',
            'media.upload',
            "Optimizely's image type doesn't take AVIF: download it as WebP, PNG or JPEG",
            422,
          );
          await call('browser', 'fetch.asset', `Fetched ${file} from the source as WebP`);
        }
        await call('optimizely-cms', 'media.upload', `Uploaded ${file} to ${e.media}/${file}`);
      },
    );
    uploaded += items.length;
    await sim.metric('media_uploaded', uploaded, MEDIA.length);
  }
}

/**
 * Phase 6: each page built as a draft, then published, so the head renders it and it can be
 * compared with the source. Sessions of 8.
 */
async function migratePages(e: Engagement) {
  const { sim } = e;
  const [home, landing, , , blogPost] = TEMPLATES;
  let migrated = 0;
  for (let i = 0; i < PAGES.length; i += PAGE_BATCH) {
    const pages = PAGES.slice(i, i + PAGE_BATCH);
    await e.batch(
      pages.map((p) => `migrate-pages-${p.key}`),
      `Migrating pages ${i + 1}–${i + pages.length}`,
      async (call, n) => {
        const page = pages[n]!;
        const first = i === 0 && n === 0;
        // The home page is the application's start page and exists already.
        const path = first ? e.content : `${e.content}/${page.key}`;
        const type = typeOf(e, first ? home! : page.key.startsWith('blog') ? blogPost! : landing!);
        const cms = (op: string, summary: string) => call('optimizely-cms', op, summary);
        if (first) await cms('content.update', `Set title, description on ${path} (draft)`);
        else await cms('content.create', `Created ${type} "${page.name}" at ${path} (draft)`);
        await cms('composition.write', `Composed ${path}: ${3 + (n % 4)} sections (draft)`);
        await cms(
          'content.publish',
          `Published ${path} (version ${first ? 2 : 1}); Optimizely Graph indexes it within moments`,
        );
      },
    );
    migrated += pages.length;
    await sim.metric('pages_migrated', migrated, PAGES.length);
    if (i === PAGE_BATCH) await sim.toolHealth('optimizely-cms', 'degraded');
    if (i === 2 * PAGE_BATCH) await sim.toolHealth('optimizely-cms', 'ok');
  }
}
