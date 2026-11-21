import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPTIMIZELY_DEFAULTS, SITECORE_DEFAULTS } from '@lw/connectors';
import { loadFixtures } from '@lw/orchestrator';
import { compilePlan } from '@lw/plan';
import { createPlatforms, optimizelyBindings } from '@lw/platforms';
import { loadPlaybook } from '@lw/playbook-sdk';
import { inScope } from '@lw/tool-gateway';
import { OptimizelyCmsToolServer, OptimizelyGraphToolServer } from '@lw/tool-optimizely';
import { describe, expect, it } from 'vitest';
import { CHECKS } from '../src';
import { EXAMPLE_ORIGIN, exampleInventory, gateOne } from './gate-one';

const dir = (id: string) => fileURLToPath(new URL(`../../../playbooks/${id}`, import.meta.url));
const PLAYBOOKS = ['optimizely-saas-migration', 'optimizely-homepage-demo'];
const OPTIMIZELY = createPlatforms({
  sitecore: SITECORE_DEFAULTS,
  optimizely: OPTIMIZELY_DEFAULTS,
}).get('optimizely')!;
// Two projects on one instance: content types, templates and Graph are shared between them.
const acme = optimizelyBindings({ application: 'Acme Site', typePrefix: 'Acme' });

describe('Optimizely playbooks and the servers they call', () => {
  const catalogs: Record<string, Record<string, unknown>> = {
    'optimizely-cms': new OptimizelyCmsToolServer({ facts: async () => null }).catalog,
    'optimizely-graph': new OptimizelyGraphToolServer({ facts: async () => null }).catalog,
  };

  it.each(PLAYBOOKS)('%s grants only operations that exist', async (id) => {
    const pb = await loadPlaybook(dir(id));
    const unknown = pb.roles.flatMap((r) =>
      Object.entries(r.tools)
        .filter(([server]) => server in catalogs)
        .flatMap(([server, grant]) =>
          grant.ops
            .filter((op) => !(op in catalogs[server]!))
            .map((op) => `${r.role}: ${server}.${op}`),
        ),
    );
    expect(unknown).toEqual([]);
  });

  it.each(PLAYBOOKS)("%s writes only inside the project's own application", async (id) => {
    const pb = await loadPlaybook(dir(id));
    const paths = (role: string) =>
      Object.values(pb.roles.find((r) => r.role === role)!.tools).flatMap(
        (g) => g.scope?.paths ?? [],
      );
    const can = (role: string, path: string) => inScope(path, paths(role), acme);

    expect(can('content-migrator', '/content/Acme_Site')).toBe(true);
    expect(can('content-migrator', '/content/Acme_Site/about')).toBe(true);
    expect(can('content-migrator', '/shared/Acme_Site/Site Header')).toBe(true);
    expect(can('content-migrator', '/content/Globex_Site/about')).toBe(false);
    expect(can('content-migrator', '/shared/Globex_Site/Site Header')).toBe(false);
    expect(can('media-migrator', '/media/Acme_Site/Home/hero.webp')).toBe(true);
    expect(can('media-migrator', '/media/Globex_Site/Home/hero.webp')).toBe(false);
    // Nobody is granted the whole tree to write.
    for (const role of pb.roles)
      for (const grant of Object.values(role.tools))
        for (const p of grant.scope?.paths ?? [])
          expect(/^\/(content|shared|media)\/\*\*/.test(p), `${role.role}: ${p}`).toBe(false);
  });
});

describe('Optimizely website playbook: the order the platform sets', () => {
  const DIR = dir('optimizely-saas-migration');

  it('pushes the page types before the application, and proves the pilot on it', async () => {
    const pb = await loadPlaybook(DIR);
    const { blueprint } = await loadFixtures(DIR);
    const plan = compilePlan(pb, blueprint, { skipMerged: true });
    const task = (id: string) => plan.tasks.find((t) => t.taskId === id)!;
    const order = plan.tasks.map((t) => t.taskId);
    const before = (a: string, b: string) => order.indexOf(a) < order.indexOf(b);

    // An application can't exist without its start page, of a page type already in the CMS.
    expect(task('approve-provision-application').dependsOn.sort()).toEqual(
      blueprint.collections.templates!.map((t) => `push-type-${t.key}`).sort(),
    );
    // A page type refers to the header's and footer's types: it waits on those, not on every
    // component (the example marks the header, the footer and the navigation shared).
    expect(task('push-type-home').dependsOn.sort()).toEqual([
      'define-type-home',
      'integrate-footer',
      'integrate-head',
      'integrate-header',
      'integrate-navigation',
    ]);
    // Everything that reads the application, its host or Graph comes after it.
    for (const id of [
      'validate-foundation',
      'compose-pilot',
      'prove-pilot-slice',
      'migrate-shared-chrome',
      'migrate-pages-page-1',
      'publish-site',
    ])
      expect(before('provision-application', id), id).toBe(true);
    const needApplication = new Set([
      'structural.application',
      'hostname.registered',
      'head.preview-route',
      'graph.published',
      'head.header-footer',
      'head.pages-render',
      'pilot.composed',
      'pilot.renders',
      'parity.render',
      'parity.visual',
      'parity.chrome',
      'seo.titles',
      'routes.resolve',
    ]);
    for (const t of plan.tasks)
      if (t.acceptance.some((a) => needApplication.has(a.replace('validator:', ''))))
        expect(
          t.taskId === 'provision-application' || before('provision-application', t.taskId),
          t.taskId,
        ).toBe(true);
    // types.pushed wants every component's and page type's content type in the CMS.
    for (const t of pb.plan.templates.filter((t) =>
      t.acceptance.includes('validator:types.pushed'),
    ))
      expect(['prove-pilot-slice', 'validate-components'], t.id).toContain(t.id);

    // The pilot: its components and the shared ones, composed, published and read back before
    // the rest is built.
    const checkpoint = task('pilot-checkpoint');
    expect(checkpoint.itemKeys.sort()).toEqual([
      'footer',
      'header',
      'hero',
      'navigation',
      'promo-card',
      'rich-text',
    ]);
    expect(checkpoint.dependsOn).toEqual(
      expect.arrayContaining(['compose-pilot', 'prove-pilot-slice']),
    );
    expect(task('prove-pilot-slice').itemKeys.sort()).toEqual(checkpoint.itemKeys.sort());
    expect(task('port-card-grid').dependsOn).toContain('pilot-checkpoint');
    expect(order).not.toContain('register-editing-hostname');
  });

  it('publishes where the head is judged, as releases the Director approves', async () => {
    const pb = await loadPlaybook(DIR);
    const template = (id: string) => pb.plan.templates.find((t) => t.id === id)!;
    // The head shows published content only: these tasks publish what they wrote.
    for (const id of ['compose-pilot', 'migrate-shared-chrome', 'migrate-pages-{key}'])
      expect(template(id).release, id).toBeDefined();
    expect(
      pb.roles.find((r) => r.role === 'content-migrator')!.tools['optimizely-cms']!.ops,
    ).toContain('content.publish');
    // A client's instance: no release is approved by the playbook.
    for (const t of pb.plan.templates) expect(t.release?.standing, t.id).toBeUndefined();
    // The API key's content rights are confirmed before Gate 1; Visual Builder has no driver.
    expect(template('confirm-content-rights')).toMatchObject({
      phase: 0,
      unless: 'content-rights-proven',
      manual: expect.stringContaining('Set Access Rights'),
    });
    // A key whose earlier content proves its rights is not asked: the step leaves the plan.
    const { blueprint: example } = await loadFixtures(DIR);
    const ids = (features: string[]) =>
      compilePlan(pb, example, { skipMerged: true, features }).tasks.map((t) => t.taskId);
    expect(ids([])).toContain('confirm-content-rights');
    expect(ids(['content-rights-proven'])).not.toContain('confirm-content-rights');
    for (const id of ['smoke-test', 'prove-experimentation'])
      expect(template(id).manual, id).toBeDefined();
    // No check that reads another platform's contract or endpoints: the Blueprint's model
    // contract is checked by this platform's own check of that id (see below), which its pack
    // registers and which replaces the shared one.
    const named = pb.plan.templates.flatMap((t) => t.acceptance);
    expect(template('draft-blueprint').acceptance).toEqual([
      'validator:blueprint.coverage',
      'validator:discovery.blueprint',
    ]);
    expect(Object.keys(OPTIMIZELY.checks ?? {})).toEqual(
      expect.arrayContaining(['blueprint.coverage', 'discovery.blueprint']),
    );
    expect(named).not.toContain('validator:editing-host.responds');
    // The pilot composes the start page only, so it is judged on that page. The per-page checks
    // look at every page a task covers: they belong to the tasks that have pages of their own.
    expect(template('compose-pilot').acceptance).toEqual([
      'validator:pilot.composed',
      'validator:pilot.renders',
      'validator:graph.published',
    ]);
    for (const t of pb.plan.templates)
      if (
        t.acceptance.some((x) =>
          ['validator:structural.experiences', 'validator:head.pages-render'].includes(x),
        )
      )
        expect(t.forEach, t.id).toBe('pages');
    // What the SitecoreAI playbooks check by the same ids, on the corresponding steps.
    expect(template('crawl-site').acceptance).toEqual(['validator:discovery.inventory']);
    expect(template('migrate-shared-chrome').acceptance).toEqual([
      'validator:head.header-footer',
      'validator:parity.chrome',
    ]);
    // SEO properties are drafts until the phase 8 release, which is judged on the titles again.
    expect(template('seo-properties').acceptance).toEqual(['validator:seo.titles']);
    expect(template('publish-site').acceptance).toContain('validator:seo.titles');
  });

  it('names in its prompts only tools the role is granted, and only validator runs that exist', async () => {
    const pb = await loadPlaybook(DIR);
    const servers = new Set(pb.roles.flatMap((r) => Object.keys(r.tools)));
    const missing: string[] = [];
    for (const role of pb.roles) {
      let prompt: string;
      try {
        prompt = await readFile(join(DIR, 'prompts', `${role.role}.md`), 'utf8');
      } catch {
        continue;
      }
      for (const [, server, op] of prompt.matchAll(/`([a-z][a-z-]*)\.([a-z][a-z.-]*[a-z])`/g)) {
        if (servers.has(server!) && !role.tools[server!]?.ops.includes(op!))
          missing.push(`${role.role}: ${server}.${op}`);
      }
      // These two roles work from their acceptance checks, which run the platform's checks on
      // the task's own items; the validators server's whole-project runs are for other roles.
      if (['parity-auditor', 'structural-validator'].includes(role.role))
        expect(prompt, role.role).not.toMatch(/validators\.(parity|structural)\.run/);
    }
    expect(missing).toEqual([]);
    // A role granted an operation no server offers doesn't run on a live project.
    expect(pb.roles.find((r) => r.role === 'parity-auditor')!.tools.validators).toBeUndefined();
  });
});

describe('the Blueprint check an Optimizely project runs', () => {
  /** A Blueprint in this platform's model contract: one section, the shared header, one page. */
  const blueprint = (pilot: boolean) => ({
    version: 1,
    collections: {
      components: [
        {
          key: 'hero',
          name: 'Hero',
          ...(pilot ? { pilot: true } : {}),
          attrs: {
            contentType: 'AcmeHero',
            behaviour: 'section',
            properties: [{ name: 'heading', type: 'string' }],
            displayTemplates: [{ key: 'AcmeHeroDefault', default: true }],
          },
        },
        {
          key: 'site-header',
          name: 'Site Header',
          attrs: {
            contentType: 'AcmeSiteHeader',
            behaviour: 'shell',
            shared: true,
            properties: [{ name: 'logo', type: 'contentReference', allowedTypes: ['_image'] }],
          },
        },
      ],
      templates: [
        {
          key: 'landing',
          name: 'Landing',
          attrs: { kind: 'experience', contentType: 'AcmeLanding' },
        },
      ],
      pages: [{ key: 'home', name: 'Home', attrs: { path: '/', template: 'landing' } }],
      media: [],
    },
  });
  const inventory = { origin: EXAMPLE_ORIGIN, pages: [{ path: '/' }] };
  const coverage = async (playbookId: string, content: unknown) =>
    (await gateOne(playbookId, { blueprint: content, inventory })).rows.find(
      (r) => r.id === 'blueprint.coverage',
    );

  it("is the platform's own: it reads this platform's contract, not the shared check's", async () => {
    expect(await coverage('optimizely-saas-migration', blueprint(true))).toMatchObject({
      status: 'pass',
    });
    // The shared check, which reads another platform's contract, fails the same Blueprint.
    const shared = await CHECKS['blueprint.coverage']!({
      projectId: 'p1',
      library: {
        read: async (_p: string, id: string) =>
          id === 'blueprint' ? { content: JSON.stringify(blueprint(true)) } : null,
      },
    } as never);
    expect(shared).toMatchObject({ status: 'fail' });
    expect(shared.detail).toContain('hero has no fields');
  });

  it('wants a pilot slice on the website playbook, whose plan proves one, and not on the demo', async () => {
    expect(await coverage('optimizely-saas-migration', blueprint(false))).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('no pilot components'),
    });
    expect(await coverage('optimizely-homepage-demo', blueprint(false))).toMatchObject({
      status: 'pass',
    });
  });
});

/**
 * The prompt, the example and the checks describe one contract: the example Blueprint, as it is
 * on disk, passes every check the Blueprint step names. A check made stricter than the example,
 * or an example that drops what the prompt asks for, fails here and not on a live project.
 */
describe('Optimizely website playbook: its example Blueprint at Gate 1', () => {
  const ID = 'optimizely-saas-migration';
  const example = async () => (await loadFixtures(dir(ID))).blueprint;

  it('passes every check its Blueprint step names', async () => {
    const blueprint = await example();
    const { named, rows } = await gateOne(ID, {
      blueprint,
      inventory: exampleInventory(blueprint),
    });
    expect(named).toEqual(['blueprint.coverage', 'discovery.blueprint']);
    expect(rows.map(({ id, status, detail }) => ({ id, status, detail }))).toEqual([
      {
        id: 'blueprint.coverage',
        status: 'pass',
        detail:
          '48 pages, 5 page types and 16 components, each with a model contract: keys with the prefix Acme, typed properties, a composition behaviour and display templates.',
      },
      {
        id: 'discovery.blueprint',
        status: 'pass',
        detail:
          '20 source pages compared with the Blueprint: 1 form accounted for, 1 redirect decided, the 404 page left to the head, 2 source components mapped, media hosts named.',
      },
    ]);
  });

  it("rests on a page inventory the crawl step's own check accepts", async () => {
    // The inventory these tests give the Blueprint checks is written as the Content Analyst's
    // prompt asks, for the same source: discovery.inventory passes it.
    const blueprint = await example();
    const { named, rows } = await gateOne(
      ID,
      { blueprint: null, inventory: exampleInventory(blueprint) },
      undefined,
      'crawl-site',
    );
    expect(named).toEqual(['discovery.inventory']);
    expect(rows.map(({ id, status, detail }) => ({ id, status, detail }))).toEqual([
      {
        id: 'discovery.inventory',
        status: 'pass',
        detail:
          '47 pages, each with its <title> and meta description; 20 source pages read, their forms, redirects, layout data and media hosts recorded; the whole site.',
      },
    ]);
  });

  it('fails when the example leaves out what the prompt asks for', async () => {
    const verdicts = async (
      change: (bp: Awaited<ReturnType<typeof example>>) => void,
      recorded: Record<string, unknown> = {},
    ) => {
      const blueprint = structuredClone(await example());
      const inventory = exampleInventory(blueprint, recorded);
      change(blueprint);
      const { rows } = await gateOne(ID, { blueprint, inventory });
      return Object.fromEntries(rows.map((r) => [r.id, `${r.status}: ${r.detail}`]));
    };
    const component = (bp: Awaited<ReturnType<typeof example>>, key: string) =>
      bp.collections.components!.find((c) => c.key === key)!;
    // The model contract.
    expect(
      (await verdicts((bp) => delete component(bp, 'hero').attrs.properties))['blueprint.coverage'],
    ).toBe('fail: hero has no properties.');
    expect(
      (await verdicts((bp) => delete component(bp, 'card-grid').attrs.displayTemplates))[
        'blueprint.coverage'
      ],
    ).toContain('fail: card-grid has no display template');
    expect(
      (await verdicts((bp) => delete component(bp, 'navigation').attrs.shared))[
        'blueprint.coverage'
      ],
    ).toContain('fail: navigation is a shared block (behaviour "shell") not marked shared: true');
    expect(
      (await verdicts((bp) => delete bp.collections.templates![0]!.attrs.kind))[
        'blueprint.coverage'
      ],
    ).toContain('fail: template home has no kind');
    expect(
      (await verdicts((bp) => delete bp.collections.pages![1]!.attrs.template))[
        'blueprint.coverage'
      ],
    ).toBe('fail: page page-2 is on no page type (attrs.template).');
    expect(
      (await verdicts((bp) => (component(bp, 'hero').pilot = false)))['blueprint.coverage'],
    ).toContain('pass: ');
    expect(
      (
        await verdicts((bp) => {
          for (const c of bp.collections.components!) c.pilot = false;
        })
      )['blueprint.coverage'],
    ).toContain('fail: no pilot components');
    // What discovery found on the source.
    expect(
      (await verdicts((bp) => delete component(bp, 'footer').attrs.forms))['discovery.blueprint'],
    ).toContain(
      "fail: forms on the source the Blueprint doesn't account for: form#newsletter on /",
    );
    expect(
      (await verdicts((bp) => delete bp.collections.pages![9]!.attrs.redirect))[
        'discovery.blueprint'
      ],
    ).toContain('fail: source URLs that redirect elsewhere with no decision: /services (page-10)');
    expect((await verdicts((bp) => bp.collections.pages!.pop()))['discovery.blueprint']).toContain(
      "fail: the Blueprint doesn't say what happens to the 404 page",
    );
    expect(
      (await verdicts((bp) => delete component(bp, 'hero').attrs.sourceComponents))[
        'discovery.blueprint'
      ],
    ).toContain('fail: source components no Blueprint component maps: HeroBanner (/)');
    expect(
      (await verdicts((bp) => delete bp.collections.media![0]!.attrs.url))['discovery.blueprint'],
    ).toContain('pass: ');
    expect(
      (
        await verdicts(
          (bp) => {
            for (const m of bp.collections.media!) delete m.attrs.url;
          },
          { mediaHosts: [] },
        )
      )['discovery.blueprint'],
    ).toContain(
      'fail: media on 1 host neither the Blueprint nor an inventory names: cdn.example.com',
    );
  });

  it('takes the key every other check derives when the example names none', async () => {
    // attrs.contentType is the key the architect chose; without it the key is the prefix and
    // the item's name, as the checks that read the CMS derive it. Both are a contract.
    const blueprint = structuredClone(await example());
    for (const c of [...blueprint.collections.components!, ...blueprint.collections.templates!])
      delete c.attrs.contentType;
    const { rows } = await gateOne(ID, { blueprint, inventory: exampleInventory(blueprint) });
    expect(rows.find((r) => r.id === 'blueprint.coverage')).toMatchObject({ status: 'pass' });
  });
});

describe('Optimizely content-model checks from the task’s own steps', () => {
  let n = 0;
  const step = (toolServer: string, operation: string, summary: string, resultCode = 200) =>
    ({
      type: 'step.recorded',
      data: { stepId: `s${++n}`, toolServer, operation, summary, resultCode },
    }) as never;
  const run = (id: string, steps: unknown[]) => CHECKS[id]!({ steps } as never);
  const dry = (types = 3, templates = 2) =>
    step(
      'sandbox',
      'exec.optimizely-cli',
      `Content model valid: ${types} content types, ${templates} display templates (dry run, nothing sent)`,
    );

  it('types.defined wants a clean dry run with nothing written after it', async () => {
    expect(await run('types.defined', [])).toMatchObject({ status: 'fail' });
    expect(
      await run('types.defined', [step('sandbox', 'fs.write', 'Wrote Hero.model.ts'), dry()]),
    ).toMatchObject({ status: 'pass' });
    expect(
      await run('types.defined', [dry(), step('sandbox', 'fs.write', 'Wrote Hero.model.ts')]),
    ).toMatchObject({ status: 'fail' });
    const refused = step(
      'sandbox',
      'exec.optimizely-cli',
      "These keys don't start with the project's prefix Acme: Hero",
      422,
    );
    expect(await run('types.defined', [refused])).toMatchObject({ status: 'fail' });
  });

  it('manifest.replays wants the repository to build what the CMS holds', async () => {
    const exported = (types = 3, templates = 2) =>
      step(
        'optimizely-cms',
        'manifest.export',
        `Manifest: ${types} content types and ${templates} display templates with the prefix Acme`,
      );
    expect(await run('manifest.replays', [exported(), dry()])).toMatchObject({ status: 'pass' });
    const drifted = await run('manifest.replays', [exported(4, 2), dry(3, 2)]);
    expect(drifted).toMatchObject({ status: 'fail' });
    expect(drifted.detail).toContain('drifted');
    expect(await run('manifest.replays', [dry()])).toMatchObject({ status: 'fail' });
    expect(await run('manifest.replays', [exported()])).toMatchObject({ status: 'fail' });
  });
});
