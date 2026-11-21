import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixtures } from '@lw/orchestrator';
import { compilePlan } from '@lw/plan';
import { loadPlaybook, loadRolePrompts } from '@lw/playbook-sdk';
import { describe, expect, it } from 'vitest';
import { CHECKS } from '../src';
import { demoSource, exampleInventory, gateOne } from './gate-one';

const dir = (id: string) => fileURLToPath(new URL(`../../../playbooks/${id}`, import.meta.url));
const DEMO = dir('optimizely-homepage-demo');
const PLATFORM_KNOWLEDGE = fileURLToPath(
  new URL('../../../platforms/optimizely/knowledge', import.meta.url),
);

describe('optimizely-homepage-demo playbook', () => {
  it('loads, with the Blueprint gate and the Visual Builder gate', async () => {
    const pb = await loadPlaybook(DEMO);
    expect(pb.manifest).toMatchObject({ platform: 'optimizely', version: '0.1.5' });
    expect(pb.manifest.phases).toHaveLength(10);
    expect(pb.manifest.phases.filter((p) => p.gate === 'director').map((p) => p.number)).toEqual([
      2, 9,
    ]);
    expect(pb.manifest.charter.outcomes.map((o) => o.id)).toEqual([
      'compose-and-edit',
      'shared-chrome',
      'homepage-parity',
      'deployed',
      'real-audit',
    ]);
    // The slice is the pilot: no pilot block, no canaries on one page's worth of items.
    expect(pb.plan.pilot).toBeUndefined();
    for (const t of pb.plan.templates.filter((t) => t.forEach)) expect(t.canary).toBe(0);
    expect(pb.plan.templates.find((t) => t.id === 'draft-blueprint')?.acceptance).toContain(
      'validator:blueprint.demo-slice',
    );
    // Beside it, what the SitecoreAI demo checks by the same ids on the corresponding steps:
    // the model contract and discovery's decisions, the shared blocks' content, the page title.
    const acceptance = (id: string) => pb.plan.templates.find((t) => t.id === id)?.acceptance;
    expect(acceptance('crawl-site')).toEqual(['validator:discovery.inventory']);
    expect(acceptance('draft-blueprint')).toEqual([
      'validator:blueprint.coverage',
      'validator:discovery.blueprint',
      'validator:blueprint.demo-slice',
    ]);
    expect(acceptance('migrate-shared-chrome')).toEqual([
      'validator:head.header-footer',
      'validator:parity.chrome',
    ]);
    expect(acceptance('seo-properties')).toEqual(['validator:seo.titles']);
    expect(acceptance('publish-site')).toContain('validator:seo.titles');
    // Always our demo instance and the demo's own application: every release is approved once,
    // in the playbook. The Director's cards are the two gates and the two steps by hand.
    for (const t of pb.plan.templates.filter((t) => t.release))
      expect(t.release?.standing, t.id).toBe(true);
    // The API key's content rights are confirmed before Gate 1, unless the key's earlier
    // content proves them (the platform reads that as the project starts).
    expect(pb.plan.templates.find((t) => t.id === 'confirm-content-rights')).toMatchObject({
      phase: 0,
      unless: 'content-rights-proven',
      manual: expect.stringContaining('Set Access Rights'),
    });
    expect(pb.plan.templates.find((t) => t.id === 'visual-builder-check')).toMatchObject({
      phase: 9,
      dependsOn: ['demo-summary'],
      manual: expect.stringContaining('add a section'),
    });
  });

  it('plans exactly the slice of the example Blueprint, in the order the platform sets', async () => {
    const pb = await loadPlaybook(DEMO);
    const { blueprint } = await loadFixtures(DEMO);
    const plan = compilePlan(pb, blueprint, { skipMerged: true });
    const keys = (prefix: string) =>
      plan.tasks
        .filter((t) => t.taskId.startsWith(prefix))
        .map((t) => t.taskId.slice(prefix.length));
    expect(keys('port-')).toEqual([
      'site-header',
      'main-navigation',
      'site-footer',
      'announcement-banner',
      'hero-with-tabs',
      'promo-card-carousel',
      'quick-links',
      'featured-banner',
      'feature-card-grid',
      'horizontal-card',
      'social-follow',
    ]);
    expect(keys('define-type-')).toEqual(['experience']);
    expect(keys('migrate-pages-')).toEqual(['home']);
    expect(keys('upload-media-')).toEqual([
      'logo-header',
      'hero-background',
      'promo-card-1',
      'feature-card-1',
      'social-icon-1',
    ]);
    expect(plan.tasks.map((t) => t.taskId)).not.toContain('pilot-checkpoint');
    expect(plan.tasks.at(-1)?.taskId).toBe('visual-builder-check');
    const task = (id: string) => plan.tasks.find((t) => t.taskId === id)!;
    // The experience type references the shared blocks' types: it waits on those alone.
    expect(task('push-type-experience').dependsOn.sort()).toEqual([
      'define-type-experience',
      'integrate-head',
      'integrate-main-navigation',
      'integrate-site-footer',
      'integrate-site-header',
    ]);
    // An application can't exist without its start page, of the type just pushed.
    expect(task('approve-provision-application').dependsOn).toEqual(['push-type-experience']);
    expect(task('approve-migrate-shared-chrome').dependsOn).toEqual(['provision-application']);
    expect(task('approve-migrate-pages-home').dependsOn).toEqual(['migrate-shared-chrome']);
  });

  it('passes its own Blueprint check', async () => {
    const { blueprint } = await loadFixtures(DEMO);
    const result = await CHECKS['blueprint.demo-slice']!({
      projectId: 'p1',
      state: { playbook: { id: 'optimizely-homepage-demo', version: '0.1.5' } },
      library: {
        read: async (_p: string, id: string) =>
          id === 'blueprint' ? { content: JSON.stringify(blueprint) } : null,
      },
    } as never);
    expect(result).toMatchObject({
      status: 'pass',
      detail: 'The demo builds 1 page, 1 template, 11 components and 5 media.',
    });
  });

  // The prompt, the example and the checks describe one contract: the example, as it is on
  // disk, passes every check the Blueprint step names, on a page inventory of the homepage with
  // the rest of the site in its audit.
  it('passes every check its Blueprint step names, with its example Blueprint', async () => {
    const { blueprint } = await loadFixtures(DEMO);
    const inventory = (bp: typeof blueprint) =>
      exampleInventory(bp, {
        crawl: {
          pagesFound: 62,
          pagesInventoried: 1,
          partial: true,
          sampling: 'homepage demo: the homepage',
        },
        siteAudit: { pagesFound: 62, templates: [{ name: 'content', pages: 40 }] },
        forms: [],
        layoutData: null,
        mediaHosts: ['https://cdn.example.com/home/'],
      });
    const { named, rows } = await gateOne(
      'optimizely-homepage-demo',
      { blueprint, inventory: inventory(blueprint) },
      demoSource,
    );
    expect(named).toEqual(['blueprint.coverage', 'discovery.blueprint', 'blueprint.demo-slice']);
    // The inventory is one the crawl step's own check accepts.
    const crawl = await gateOne(
      'optimizely-homepage-demo',
      { blueprint: null, inventory: inventory(blueprint) },
      demoSource,
      'crawl-site',
    );
    expect(crawl.rows.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'discovery.inventory', status: 'pass' },
    ]);
    expect(rows.map(({ id, status, detail }) => ({ id, status, detail }))).toEqual([
      {
        id: 'blueprint.coverage',
        status: 'pass',
        detail:
          '1 page, 1 page type and 11 components, each with a model contract: keys with the prefix Acme, typed properties, a composition behaviour and display templates. Covers 1 of 62 pages found; the site audit counts the rest.',
      },
      {
        id: 'discovery.blueprint',
        status: 'pass',
        detail:
          '1 source pages compared with the Blueprint: 0 forms accounted for, 0 redirects decided, the 404 page left to the head, 0 source components mapped, media hosts named.',
      },
      {
        id: 'blueprint.demo-slice',
        status: 'pass',
        detail: 'The demo builds 1 page, 1 template, 11 components and 5 media.',
      },
    ]);

    // And fails when the example leaves out what the prompt asks for.
    const verdicts = async (change: (bp: typeof blueprint) => void) => {
      const changed = structuredClone(blueprint);
      change(changed);
      const run = await gateOne(
        'optimizely-homepage-demo',
        { blueprint: changed, inventory: inventory(blueprint) },
        demoSource,
      );
      return Object.fromEntries(run.rows.map((r) => [r.id, `${r.status}: ${r.detail}`]));
    };
    const component = (bp: typeof blueprint, key: string) =>
      bp.collections.components!.find((c) => c.key === key)!;
    expect(
      (await verdicts((bp) => delete component(bp, 'featured-banner').attrs.properties))[
        'blueprint.coverage'
      ],
    ).toBe('fail: featured-banner has no properties.');
    expect(
      (
        await verdicts((bp) => {
          const templates = component(bp, 'featured-banner').attrs.displayTemplates;
          delete (templates as { default?: boolean }[])[0]!.default;
        })
      )['blueprint.coverage'],
    ).toBe(
      'fail: featured-banner has 0 default display templates: exactly one is marked default: true.',
    );
    expect(
      (
        await verdicts((bp) => {
          (component(bp, 'main-navigation').attrs.children as { max?: number }).max = undefined;
        })
      )['blueprint.coverage'],
    ).toBe("fail: main-navigation's child items have no limit (children.max).");
    const kept = await verdicts((bp) => {
      bp.collections.pages![1]!.status = 'keep';
    });
    expect(kept['discovery.blueprint']).toContain(
      'fail: not-found (/404) is the 404 page, kept as a page',
    );
    // The whole Blueprint is the slice: no pilot is asked for where the plan proves none.
    const unmarked = await verdicts((bp) => {
      for (const c of bp.collections.components!) c.pilot = false;
    });
    expect(unmarked['blueprint.coverage']).toContain('pass: ');
  });

  it('grants every tool a role prompt tells the agent to use, and finds its knowledge', async () => {
    const pb = await loadPlaybook(DEMO);
    const prompts = await loadRolePrompts(DEMO, pb, [PLATFORM_KNOWLEDGE]);
    expect(prompts['handover-writer']).toContain('`demo-summary`');
    expect(prompts['handover-writer']).toContain('Definition of Done (homepage demo)');
    const servers = new Set(pb.roles.flatMap((r) => Object.keys(r.tools)));
    const missing: string[] = [];
    for (const role of pb.roles) {
      let prompt: string;
      try {
        prompt = await readFile(join(DEMO, 'prompts', `${role.role}.md`), 'utf8');
      } catch {
        continue;
      }
      for (const [, server, op] of prompt.matchAll(/`([a-z][a-z-]*)\.([a-z][a-z.-]*[a-z])`/g)) {
        if (servers.has(server!) && !role.tools[server!]?.ops.includes(op!))
          missing.push(`${role.role}: ${server}.${op}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('names no other platform', async () => {
    const found: string[] = [];
    for (const folder of ['.', 'roles', 'prompts', 'knowledge', 'fixtures'])
      for (const f of await readdir(join(DEMO, folder), { withFileTypes: true })) {
        if (!f.isFile()) continue;
        const text = await readFile(join(DEMO, folder, f.name), 'utf8');
        const m = /sitecore|page builder|experience edge|partial design|datasource/i.exec(text);
        if (m) found.push(`${folder}/${f.name}: ${m[0]}`);
      }
    expect(found).toEqual([]);
  });
});
