import type { Workstream } from '@lw/contracts';
import type { Simulation } from './simulation';

/** Fixture site: a mid-size corporate Next.js app. */
const COMPONENTS = [
  'Hero',
  'PromoCard',
  'Header',
  'Footer',
  'RichText',
  'CardGrid',
  'Testimonial',
  'CtaBanner',
  'Accordion',
  'Tabs',
  'ImageGallery',
  'VideoEmbed',
  'Navigation',
  'Breadcrumb',
  'StatsStrip',
  'LogoWall',
];
const TEMPLATES = ['Home Page', 'Landing Page', 'Article Page', 'Listing Page'];
const PAGE_COUNT = 48;
const MEDIA_COUNT = 120;
const PILOT = ['Hero', 'PromoCard', 'RichText'];

type Step = [server: string, op: string, summary: string];

/**
 * Runs one task end to end: agent active → steps → validating → done (or rejected and retried).
 * `rejectTimes` makes the Lead reject the output that many times before it passes.
 */
async function work(
  sim: Simulation,
  agentId: string,
  taskId: string,
  label: string,
  steps: Step[],
  opts: { rejectTimes?: number; validator?: Step } = {},
) {
  await sim.move(taskId, 'ready');
  await sim.move(taskId, 'running');
  let rejections = 0;
  for (;;) {
    for (let i = 0; i < steps.length; i++) {
      const [server, op, summary] = steps[i]!;
      await sim.agent(agentId, 'active', `${label}, step ${i + 1} of ${steps.length}`, taskId);
      await sim.step(agentId, taskId, server, op, summary);
    }
    await sim.move(taskId, 'validating');
    if (opts.validator) {
      const [server, op, summary] = opts.validator;
      const pass = rejections >= (opts.rejectTimes ?? 0);
      await sim.step(agentId, taskId, server, op, pass ? summary : `${summary}: failed`, {
        code: pass ? 200 : 422,
        severity: pass ? 'notable' : 'failure',
      });
    }
    if (rejections < (opts.rejectTimes ?? 0)) {
      rejections++;
      await sim.move(taskId, 'rejected', 'Lead review: acceptance criteria not met');
      if (rejections > 2) return 'escalate' as const;
      await sim.move(taskId, 'running', `Retry ${rejections} with Lead feedback`);
      continue;
    }
    await sim.move(taskId, 'done');
    await sim.agent(agentId, 'idle', null, null);
    return 'done' as const;
  }
}

async function activate(sim: Simulation, phase: number) {
  for (const r of sim.playbook.roles) {
    if (r.tier !== 'specialist' || !Array.isArray(r.activePhases)) continue;
    if (r.activePhases.includes(phase)) await sim.agent(r.role, 'idle');
  }
}

async function deactivate(sim: Simulation, phase: number, next: number[]) {
  for (const r of sim.playbook.roles) {
    if (r.tier !== 'specialist' || !Array.isArray(r.activePhases)) continue;
    const activeNow = r.activePhases.includes(phase);
    const activeLater = next.some((n) => (r.activePhases as number[]).includes(n));
    if (activeNow && !activeLater) await sim.agent(r.role, 'inactive');
  }
}

async function enter(sim: Simulation, phase: number, brief: string[]) {
  const p = sim.playbook.manifest.phases[phase]!;
  await sim.phase('entered', phase);
  await activate(sim, phase);
  await sim.say('phase_brief_entry', `Phase ${phase} brief: ${p.name}`, brief.join('\n'));
}

async function exit(sim: Simulation, phase: number, results: string[], next: number[]) {
  const p = sim.playbook.manifest.phases[phase]!;
  await sim.phase('exited', phase);
  await deactivate(sim, phase, next);
  await sim.say('phase_brief_exit', `Phase ${phase} complete: ${p.name}`, results.join('\n'));
}

const t = (
  id: string,
  role: string,
  title: string,
  workstream: Workstream | null,
  dependsOn: string[] = [],
) => ({
  taskId: id,
  role,
  title,
  workstream,
  dependsOn,
});

export async function sitecoreScenario(sim: Simulation): Promise<void> {
  // Small budgets so the burn bar moves during a demo; real projects use the playbook defaults.
  await sim.createProject({ tokens: 2_500_000, usd: 20, hours: 6 });
  for (const lead of [
    'chief-of-staff',
    'discovery-lead',
    'engineering-lead',
    'content-lead',
    'quality-lead',
  ]) {
    await sim.agent(lead, 'idle');
  }
  await sim.say(
    'text',
    'Intake brief',
    `Project created for ${sim.opts.client}. The team will verify access, analyse the repository and the live site, then bring you the Implementation Blueprint for approval at Gate 1.`,
  );

  // Phase 0 — Intake and access verification
  await enter(sim, 0, [
    'Produces: verified credentials and tenant facts.',
    'Active: Tenant Provisioner (read-only probe).',
    'Exit: every credential verified against its endpoint.',
  ]);
  await sim.planTasks(0, [
    t(
      'p0-verify',
      'deployment-engineer',
      'Verify credentials and record tenant facts',
      'engineering',
    ),
  ]);
  await work(sim, 'deployment-engineer', 'p0-verify', 'Verifying access', [
    ['github', 'repo.clone', 'Cloned main @ 4f1c2a9 (212 MB)'],
    ['sitecore-authoring', 'token.exchange', 'Automation client token minted (xmcloud.cm:admin)'],
    [
      'sitecore-deploy',
      'environment.read',
      'Environment "dev" found; Click Click Launch module present',
    ],
    ['sitecore-authoring', 'edge.probe', 'Experience Edge context ID responds'],
    ['hosting', 'project.read', 'Vercel team reachable'],
  ]);
  await exit(
    sim,
    0,
    [
      '5 of 5 credentials verified.',
      'Tenant: dev environment, Click Click Launch present, no existing site collection.',
    ],
    [1],
  );

  // Phase 1 — Discovery
  await enter(sim, 1, [
    'Produces: component inventory, page inventory, asset manifest, risk list.',
    'Active: Repo Analyst, Content Analyst, Research Agent.',
    'Exit: every sitemap URL crawled or excluded.',
  ]);
  await sim.planTasks(1, [
    t('p1-repo', 'repo-analyst', 'Inventory components, routes and assets', 'discovery'),
    t(
      'p1-crawl',
      'content-analyst',
      'Crawl the live site and build the page inventory',
      'discovery',
    ),
    t('p1-notes', 'research-agent', 'Verify platform facts and write Platform Notes', 'discovery'),
  ]);
  await Promise.all([
    work(sim, 'repo-analyst', 'p1-repo', 'Analysing the repository', [
      ['sandbox', 'exec.readonly', `Parsed 63 modules; ${COMPONENTS.length} candidate components`],
      ['model', 'analyse', 'Classified components: 11 content, 3 structural, 2 navigation'],
      ['artifacts', 'write', 'Component inventory v1'],
    ]).then(() =>
      sim.artifact('component-inventory', 'inventory', 'Component inventory', 1, 'repo-analyst'),
    ),
    work(sim, 'content-analyst', 'p1-crawl', 'Crawling the live site', [
      [
        'browser',
        'crawl',
        `Crawled ${PAGE_COUNT} of ${PAGE_COUNT + 3} sitemap URLs; 3 excluded (PDF)`,
      ],
      ['model', 'analyse', 'Found header, footer and promo strip as repeated regions'],
      ['artifacts', 'write', 'Page inventory v1'],
    ]).then(() =>
      sim.artifact('page-inventory', 'inventory', 'Page inventory', 1, 'content-analyst'),
    ),
    work(sim, 'research-agent', 'p1-notes', 'Verifying platform facts', [
      ['research', 'web.search', 'Content SDK for Next.js: current major is 2.x'],
      ['research', 'web.fetch', 'Content SDK 2.0: middleware.ts renamed to proxy.ts'],
      ['artifacts', 'write', 'Platform Notes v1 (9 citations)'],
    ]).then(() =>
      sim.artifact('platform-notes', 'platform_notes', 'Platform Notes', 1, 'research-agent'),
    ),
  ]);
  void sim
    .escalate({
      type: 'risk',
      title: 'Quote calculator calls a private API',
      context:
        'QuoteCalculator fetches /api/quote from the browser. SitecoreAI will host the page, but the API stays outside the platform.',
      impact: 'The component ships as-is; the API must stay reachable from the delivery host.',
      options: [{ id: 'ack', label: 'Acknowledge', recommended: true }],
      defaultOptionId: 'ack',
      deadlineSimSeconds: 600,
      sourceTaskId: 'p1-repo',
    })
    .catch(() => {});
  await exit(
    sim,
    1,
    [
      `${COMPONENTS.length} components, ${PAGE_COUNT} pages, ${MEDIA_COUNT} media items inventoried.`,
      '1 integration risk logged.',
    ],
    [2],
  );

  // Phase 2 — Blueprint (Gate 1)
  await enter(sim, 2, [
    'Produces: the Implementation Blueprint.',
    'Active: Solution Architect, Research Agent.',
    'Exit: your approval at Gate 1.',
  ]);
  await sim.planTasks(2, [
    t('p2-blueprint', 'solution-architect', 'Draft the Implementation Blueprint', 'discovery', [
      'p1-repo',
      'p1-crawl',
    ]),
  ]);
  const sot = sim.escalate({
    type: 'decision',
    title: 'Source of truth for page content',
    context:
      'The repo holds content for 12 pages that differs from the live site. The Blueprint needs one source per page.',
    impact: 'The Content Migrator waits on this in phase 6; nothing waits today.',
    options: [
      { id: 'live', label: 'Live site for every page', recommended: true },
      { id: 'repo', label: 'Repository content where it exists' },
    ],
    defaultOptionId: 'live',
    deadlineSimSeconds: 90,
    sourceTaskId: 'p2-blueprint',
  });
  await work(sim, 'solution-architect', 'p2-blueprint', 'Drafting the Blueprint', [
    ['blackboard', 'read', 'Loaded inventories and Platform Notes'],
    [
      'model',
      'map.components',
      `Mapped ${COMPONENTS.length} components to 15 renderings (Header + Navigation merged)`,
    ],
    ['model', 'map.pages', `Mapped ${PAGE_COUNT} pages to ${TEMPLATES.length} templates`],
    ['blackboard', 'write.blueprint', 'Blueprint v1 written'],
  ]);
  await sot;
  let version = 1;
  await sim.artifact(
    'blueprint',
    'blueprint',
    'Implementation Blueprint',
    version,
    'solution-architect',
  );
  for (;;) {
    const answer = await sim.escalate({
      type: 'gate',
      title: `Approve Implementation Blueprint v${version}`,
      context: `${COMPONENTS.length} components map to 15 renderings and ${PAGE_COUNT} pages to ${TEMPLATES.length} templates. Header and Navigation merge into one rendering.`,
      impact: 'Foundation, components and templates start when you approve.',
      options: [
        { id: 'approve', label: 'Approve', recommended: true },
        { id: 'send_back', label: 'Send back with notes' },
      ],
      defaultOptionId: null,
      sourceTaskId: 'p2-blueprint',
      evidence: [{ kind: 'artifact', label: `Blueprint v${version}`, ref: 'artifact:blueprint' }],
      gate: {
        phase: 2,
        artifactId: 'blueprint',
        artifactVersion: version,
        requiresConfirmation: false,
      },
    });
    if (answer === 'approve') break;
    version++;
    await sim.say('text', null, `Revising the Blueprint per your notes. v${version} follows.`);
    await sim.step(
      'solution-architect',
      'p2-blueprint',
      'blackboard',
      'write.blueprint',
      `Blueprint v${version} written`,
    );
    await sim.artifact(
      'blueprint',
      'blueprint',
      'Implementation Blueprint',
      version,
      'solution-architect',
    );
  }
  await exit(sim, 2, [`Blueprint v${version} approved.`, 'Conventions are now locked.'], [3]);

  // Phase 3 — Foundation
  await enter(sim, 3, [
    'Produces: site skeleton and hosting environment.',
    'Active: Tenant Provisioner, Deployment Engineer, Structural Validator.',
    'Exit: an empty page renders on the editing host.',
  ]);
  await sim.planTasks(3, [
    t(
      'p3-site',
      'deployment-engineer',
      'Create site collection, site, languages and module folders',
      'engineering',
    ),
    t(
      'p3-hosting',
      'deployment-engineer',
      'Create hosting project and preview environment',
      'engineering',
    ),
    t('p3-validate', 'structural-validator', 'Validate the site skeleton', 'quality', ['p3-site']),
  ]);
  await Promise.all([
    work(sim, 'deployment-engineer', 'p3-site', 'Creating the site', [
      ['sitecore-authoring', 'site.create', 'Created /sitecore/content/Acme/Corporate'],
      ['sitecore-authoring', 'language.add', 'Languages: en, fr-CA'],
      ['sitecore-cli', 'ser.push', 'Pushed 41 items (module Project.Acme)'],
      ['github', 'branch.commit', 'Committed serialized items to launchworks/foundation'],
    ]),
    work(sim, 'deployment-engineer', 'p3-hosting', 'Preparing hosting', [
      ['hosting', 'project.create', 'Vercel project acme-corporate created'],
      ['hosting', 'env.set', 'Set 6 environment variables (no secrets in repo)'],
      ['hosting', 'deploy.preview', 'Preview deployment ready'],
    ]),
  ]);
  await work(sim, 'structural-validator', 'p3-validate', 'Validating structure', [
    ['validators', 'structural.run', '0 critical, 2 info findings'],
  ]);
  await exit(
    sim,
    3,
    [
      'Site skeleton live; empty page renders on the preview editing host.',
      '0 critical conformance findings.',
    ],
    [4, 5],
  );

  // Phases 4 and 5 run in parallel.
  await Promise.all([componentsPhase(sim), templatesPhase(sim)]);

  // Phase 6 — Content and media
  await enter(sim, 6, [
    'Produces: migrated pages and media.',
    'Active: Content Migrator, Media Migrator, Parity Auditor, Visual QA, Content Analyst.',
    'Exit: content parity at or above 98%.',
  ]);
  await sim.metric('pages_migrated', 0, PAGE_COUNT);
  await sim.metric('media_uploaded', 0, MEDIA_COUNT);
  const batches = Array.from({ length: PAGE_COUNT / 8 }, (_, i) => `p6-pages-${i + 1}`);
  await sim.planTasks(6, [
    ...batches.map((id, i) =>
      t(id, 'content-migrator', `Migrate pages ${i * 8 + 1}–${i * 8 + 8}`, 'content'),
    ),
    t('p6-media', 'media-migrator', `Upload ${MEDIA_COUNT} media items`, 'content'),
    t('p6-parity', 'parity-auditor', 'Audit content parity', 'quality', batches),
  ]);
  const media = (async () => {
    await sim.move('p6-media', 'ready');
    await sim.move('p6-media', 'running');
    let uploaded = 0;
    for (let i = 0; i < 6; i++) {
      await sim.agent(
        'media-migrator',
        'active',
        `Uploading media, batch ${i + 1} of 6`,
        'p6-media',
      );
      if (i === 2) {
        await sim.step(
          'media-migrator',
          'p6-media',
          'sitecore-authoring',
          'media.upload',
          'SitecoreAI returned 403 for media upload',
          { code: 403 },
        );
        await sim.move('p6-media', 'blocked', 'Access: media upload 403');
        await sim.agent(
          'media-migrator',
          'blocked',
          'Blocked: media upload returns 403',
          'p6-media',
        );
        await sim.escalate({
          type: 'blocker',
          title: 'Media upload 403',
          context:
            'SitecoreAI rejects media uploads with 403. The automation client likely lacks write access to the Media Library.',
          impact: '80 media items and the pages that use them wait. Text migration continues.',
          options: [
            {
              id: 'reverify',
              label: 'I fixed the scope; re-verify and continue',
              recommended: true,
            },
            { id: 'skip', label: 'Skip media for now; flag pages for review' },
          ],
          defaultOptionId: null,
          sourceTaskId: 'p6-media',
          evidence: [{ kind: 'log', label: 'Failed upload', ref: 'task:p6-media' }],
        });
        await sim.move('p6-media', 'running', 'Credential re-verified');
      }
      await sim.step(
        'media-migrator',
        'p6-media',
        'sitecore-authoring',
        'media.upload',
        `Uploaded 20 items with alt text`,
      );
      uploaded += 20;
      await sim.metric('media_uploaded', uploaded, MEDIA_COUNT);
    }
    await sim.move('p6-media', 'validating');
    await sim.move('p6-media', 'done');
    await sim.agent('media-migrator', 'idle');
  })();
  let migrated = 0;
  for (const [i, id] of batches.entries()) {
    await work(sim, 'content-migrator', id, `Migrating pages ${i * 8 + 1}–${i * 8 + 8}`, [
      ['sitecore-authoring', 'item.create', 'Created 8 pages from templates'],
      ['sitecore-authoring', 'layout.compose', 'Composed 31 renderings with datasources'],
      ['sitecore-authoring', 'item.update', 'Rewrote 54 internal links to dynamic links'],
    ]);
    migrated += 8;
    await sim.metric('pages_migrated', migrated, PAGE_COUNT);
    if (i === 1) await sim.toolHealth('sitecore-authoring', 'degraded');
    if (i === 2) await sim.toolHealth('sitecore-authoring', 'ok');
  }
  await media;
  await work(sim, 'parity-auditor', 'p6-parity', 'Auditing parity', [
    ['validators', 'parity.run', 'Parity 98.6% (2 pages with embeds flagged)'],
  ]);
  await sim.metric('parity', 98.6);
  await exit(
    sim,
    6,
    [
      `${PAGE_COUNT} of ${PAGE_COUNT} pages, ${MEDIA_COUNT} of ${MEDIA_COUNT} media items.`,
      'Parity 98.6%; 2 exceptions listed in the parity report.',
    ],
    [7],
  );

  // Phase 7 — Experience enablement
  await enter(sim, 7, [
    'Produces: personalization-ready site, proof variant and A/B/n test.',
    'Active: Experience Enabler.',
    'Exit: proofs resolve on the preview host.',
  ]);
  await sim.planTasks(7, [
    t(
      'p7-enable',
      'experience-enabler',
      'Redirects, SEO, sitemap, error pages, proof variant and test',
      'content',
    ),
  ]);
  await work(sim, 'experience-enabler', 'p7-enable', 'Enabling experience features', [
    ['sitecore-authoring', 'item.create', 'Created 14 redirects, sitemap and robots settings'],
    ['sitecore-authoring', 'item.create', 'Created 404 and 500 pages and 37 dictionary entries'],
    ['browser', 'page-builder.drive', 'Created page variant "Mobile visitors" on Home'],
    ['browser', 'page-builder.drive', 'Created A/B/n test on Hero (2 variants)'],
  ]);
  await exit(sim, 7, ['Proof variant and A/B/n test resolve on the preview host.'], [8]);

  // Phase 8 — Deployment and publishing
  await enter(sim, 8, [
    'Produces: live editing and delivery hosts.',
    'Active: Deployment Engineer, Head Integrator, Editor Experience QA.',
    'Exit: smoke test green.',
  ]);
  await sim.planTasks(8, [
    t(
      'p8-deploy',
      'deployment-engineer',
      'Promote to production and publish to Edge',
      'engineering',
    ),
    t('p8-smoke', 'editor-experience-qa', 'Smoke test Page builder on production', 'quality', [
      'p8-deploy',
    ]),
  ]);
  await work(sim, 'deployment-engineer', 'p8-deploy', 'Deploying', [
    ['hosting', 'deploy.production', 'Production deployment ready'],
    ['sitecore-deploy', 'editing-host.register', 'Editing host registered to the site'],
    ['sitecore-authoring', 'publish', `Published ${PAGE_COUNT} pages to Experience Edge`],
  ]);
  await work(sim, 'editor-experience-qa', 'p8-smoke', 'Smoke testing', [
    ['browser', 'page-builder.drive', 'Created, edited and published a test page'],
  ]);
  await exit(sim, 8, ['Delivery host live; content on Experience Edge; smoke test green.'], [9]);

  // Phase 9 — Handover and acceptance (Gate 2): the Director accepts in the live systems.
  await enter(sim, 9, [
    'Produces: the handover pack, with your acceptance checklist.',
    'Active: Handover Writer.',
    'Exit: your acceptance at Gate 2, in the live systems.',
  ]);
  await sim.planTasks(9, [
    t(
      'p9-handover',
      'handover-writer',
      'Write runbook, component catalog and known-gaps register',
      null,
    ),
  ]);
  await work(sim, 'handover-writer', 'p9-handover', 'Writing the handover pack', [
    ['decision-log', 'read', 'Read 7 decisions'],
    [
      'artifacts',
      'write',
      'Runbook, component catalog (15 renderings), known gaps (2), acceptance checklist',
    ],
  ]);
  await sim.artifact('handover-pack', 'handover_pack', 'Handover pack', 1, 'handover-writer');
  await sim.escalate({
    type: 'gate',
    title: 'Accept the implementation',
    context:
      'The handover pack lists each Definition of Done row with what to check in Page builder and on the delivery host, and the evidence the build already has.',
    impact: 'Accepting closes the engagement.',
    options: [
      { id: 'approve', label: 'Accept', recommended: true },
      { id: 'send_back', label: 'Send back with notes' },
    ],
    defaultOptionId: null,
    sourceTaskId: null,
    evidence: [{ kind: 'artifact', label: 'Handover pack', ref: 'artifact:handover-pack' }],
    gate: {
      phase: 9,
      artifactId: 'handover-pack',
      artifactVersion: 1,
      requiresConfirmation: true,
    },
  });
  await exit(sim, 9, ['Accepted. Handover pack delivered.'], []);
  await sim.emit(sim.projectStatus('completed'));
  await sim.say(
    'text',
    'Project complete',
    'This project is complete. Open the handover pack in Workbench.',
  );
}

async function componentsPhase(sim: Simulation) {
  await enter(sim, 4, [
    'Produces: ported, registered and enabled components.',
    'Active: Component Engineer, Rendering Registrar, Head Integrator, Structural Validator.',
    'Exit: every Blueprint component enabled in Page builder. Pilot slice first.',
  ]);
  await sim.metric('components_registered', 0, COMPONENTS.length);
  await sim.planTasks(
    4,
    COMPONENTS.flatMap((c) => [
      t(`p4-port-${c}`, 'component-engineer', `Port ${c} to Content SDK`, 'engineering'),
      t(`p4-reg-${c}`, 'rendering-registrar', `Register ${c}`, 'engineering', [`p4-port-${c}`]),
    ]),
  );
  let registered = 0;
  for (const c of COMPONENTS) {
    const flaky = c === 'Hero';
    const result = await work(
      sim,
      'component-engineer',
      `p4-port-${c}`,
      `Porting ${c}`,
      [
        ['sandbox', 'fs.write', `${c}.tsx: field components, Default + named variants`],
        ['sandbox', 'exec.content-sdk-cli', `Registered ${c} in the component map`],
        ['sandbox', 'exec.build', 'next build passed'],
      ],
      {
        rejectTimes: flaky ? 3 : 0,
        validator: ['validators', 'component.review', `${c} meets acceptance criteria`],
      },
    );
    if (result === 'escalate') {
      await sim.move(`p4-port-${c}`, 'blocked', 'Rejected twice; escalated');
      await sim.agent(
        'component-engineer',
        'blocked',
        `Blocked: ${c} granularity decision`,
        `p4-port-${c}`,
      );
      await sim.escalate({
        type: 'decision',
        title: `${c} component granularity`,
        context: `The source ${c} has five layouts driven by props. One rendering keeps Page builder simple; five give personalization more to swap.`,
        impact: `${c} registration and 9 pages that use it wait. Other components continue.`,
        options: [
          { id: 'one', label: 'One rendering with two variants', recommended: true },
          { id: 'five', label: 'Five separate renderings' },
        ],
        defaultOptionId: 'one',
        deadlineSimSeconds: 120,
        sourceTaskId: `p4-port-${c}`,
      });
      await sim.move(`p4-port-${c}`, 'running', 'Decision applied');
      await sim.step(
        'component-engineer',
        `p4-port-${c}`,
        'sandbox',
        'fs.write',
        `${c}.tsx reworked per decision`,
      );
      await sim.move(`p4-port-${c}`, 'validating');
      await sim.move(`p4-port-${c}`, 'done');
    }
    await work(
      sim,
      'rendering-registrar',
      `p4-reg-${c}`,
      `Registering ${c}`,
      [
        [
          'sitecore-authoring',
          'rendering.create',
          `Derived ${c} rendering from the Click Click Launch base`,
        ],
        ['sitecore-cli', 'ser.push', 'Pushed datasource and rendering-parameter templates'],
      ],
      { validator: ['validators', 'editor.component-enabled', `${c} enabled in Page builder`] },
    );
    registered++;
    await sim.metric('components_registered', registered, COMPONENTS.length);
    if (c === PILOT.at(-1)) {
      await sim.say(
        'text',
        'Pilot slice ready',
        `${PILOT.join(', ')} and one page work end to end on the preview editing host. Scaling to the remaining ${COMPONENTS.length - PILOT.length} components.`,
      );
    }
  }
  await sim.step(
    'rendering-registrar',
    `p4-reg-${COMPONENTS.at(-1)}`,
    'github',
    'pr.open',
    'Opened PR #12: components and renderings',
    { severity: 'notable' },
  );
  await exit(
    sim,
    4,
    [
      `${COMPONENTS.length} of ${COMPONENTS.length} components registered and enabled.`,
      'PR opened with serialized items.',
    ],
    [6],
  );
}

async function templatesPhase(sim: Simulation) {
  await enter(sim, 5, [
    'Produces: page templates, page designs and partial designs.',
    'Active: Layout Engineer, Structural Validator.',
    'Exit: header and footer render on every template.',
  ]);
  await sim.planTasks(5, [
    ...TEMPLATES.map((name) =>
      t(
        `p5-${slug(name)}`,
        'rendering-registrar',
        `Create ${name} template and page design`,
        'engineering',
      ),
    ),
    t(
      'p5-partials',
      'rendering-registrar',
      'Create header and footer partial designs',
      'engineering',
    ),
  ]);
  await work(sim, 'rendering-registrar', 'p5-partials', 'Creating partial designs', [
    ['sitecore-authoring', 'item.create', 'Header and Footer partial designs created'],
  ]);
  for (const name of TEMPLATES) {
    await work(sim, 'rendering-registrar', `p5-${slug(name)}`, `Creating ${name}`, [
      [
        'sitecore-authoring',
        'template.create',
        `${name} template with standard values and insert options`,
      ],
      ['sitecore-authoring', 'item.create', `${name} page design assigned`],
    ]);
  }
  await exit(
    sim,
    5,
    [`${TEMPLATES.length} templates with page designs; header and footer render on all.`],
    [6],
  );
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}
