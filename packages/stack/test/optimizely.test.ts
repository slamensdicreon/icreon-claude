import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPTIMIZELY_DEFAULTS, SITECORE_DEFAULTS } from '@lw/connectors';
import { createProjectState } from '@lw/domain';
import { InMemoryEventStore, type Projections } from '@lw/events';
import { loadFixtures } from '@lw/orchestrator';
import { compilePlan } from '@lw/plan';
import { createPlatforms, optimizelyBindings } from '@lw/platforms';
import { loadPlaybook } from '@lw/playbook-sdk';
import { inScope, MemoryBlobStore } from '@lw/tool-gateway';
import { OptimizelyCmsToolServer, OptimizelyGraphToolServer } from '@lw/tool-optimizely';
import { ArtifactLibrary } from '@lw/tool-workspace';
import { describe, expect, it } from 'vitest';
import { CHECKS, selfCheck } from '../src';

const dir = (id: string) => fileURLToPath(new URL(`../../../playbooks/${id}`, import.meta.url));
const PLAYBOOKS = ['optimizely-saas-migration', 'optimizely-homepage-demo'];
// No source site answers here: a check that reads one finds nothing to compare.
const OPTIMIZELY = createPlatforms({
  sitecore: SITECORE_DEFAULTS,
  optimizely: {
    ...OPTIMIZELY_DEFAULTS,
    fetch: (async () => new Response('', { status: 404 })) as typeof fetch,
  },
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
    // component (the example marks none shared, so their names stand for them).
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
  const checker = async (playbookId: string, content: unknown) => {
    const store = new InMemoryEventStore();
    const library = new ArtifactLibrary(store, new MemoryBlobStore());
    const state = {
      ...createProjectState('p1'),
      intake: { platform: 'optimizely', target: { application: 'Acme Site', typePrefix: 'Acme' } },
    };
    const write = (artifactId: string, body: unknown) =>
      library.write('p1', {
        artifactId,
        kind: artifactId === 'blueprint' ? 'blueprint' : 'inventory',
        title: artifactId,
        format: 'json',
        content: JSON.stringify(body),
        producer: 'solution-architect',
      });
    await write('blueprint', content);
    await write('page-inventory', { origin: 'https://www.acme.com', pages: [{ path: '/' }] });
    const run = selfCheck({
      store,
      projections: { catchUp: async () => {}, get: () => state } as unknown as Projections,
      playbook: await loadPlaybook(dir(playbookId)),
      library,
      platform: {
        checks: OPTIMIZELY.checks,
        read: async () => ({ code: 404, body: { error: 'Not connected' } }),
        credential: async () => null,
      },
    });
    return async () =>
      (
        await run('p1', {
          taskId: 'draft-blueprint',
          templateId: 'draft-blueprint',
          acceptance: [],
          collection: null,
          itemKeys: [],
        })
      ).find((r) => r.id === 'blueprint.coverage');
  };

  it("is the platform's own: it reads this platform's contract, not the shared check's", async () => {
    const check = await checker('optimizely-saas-migration', blueprint(true));
    expect(await check()).toMatchObject({ status: 'pass' });
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
    const website = await checker('optimizely-saas-migration', blueprint(false));
    expect(await website()).toMatchObject({
      status: 'fail',
      detail: expect.stringContaining('no pilot components'),
    });
    const demo = await checker('optimizely-homepage-demo', blueprint(false));
    expect(await demo()).toMatchObject({ status: 'pass' });
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
