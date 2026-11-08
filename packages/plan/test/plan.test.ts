import { fileURLToPath } from 'node:url';
import { loadPlaybook, type Playbook } from '@lw/playbook-sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  Blueprint,
  compilePlan,
  dependentsOf,
  diffBlueprints,
  diffPlans,
  impactOf,
  phaseComplete,
  PILOT_CHECKPOINT,
  PlanError,
  readyTasks,
  rollbackOrder,
  startablePhases,
  type Plan,
} from '../src';

const DIR = fileURLToPath(new URL('../../../playbooks/sitecoreai-migration', import.meta.url));

const COMPONENTS = [
  'hero',
  'promo-card',
  'rich-text',
  'header',
  'footer',
  'card-grid',
  'tabs',
  'quote-calculator',
];
const PILOT = new Set(['hero', 'promo-card', 'rich-text']);
/** The header and footer join the pilot (0.14.0): every page shows them, so they're built first. */
const SLICE = [...PILOT, 'header', 'footer'];

function blueprint(
  overrides: Partial<
    Record<string, { key: string; name: string; status?: string; pilot?: boolean }[]>
  > = {},
): Blueprint {
  const items = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      key: `${prefix}-${i + 1}`,
      name: `${prefix} ${i + 1}`,
    }));
  return Blueprint.parse({
    version: 1,
    collections: {
      components: COMPONENTS.map((k) => ({ key: k, name: k, pilot: PILOT.has(k) })),
      templates: ['home', 'landing', 'article', 'blog'].map((k) => ({ key: k, name: `${k} page` })),
      pages: [
        ...items('page', 20),
        ...Array.from({ length: 5 }, (_, i) => ({ key: `blog-${i + 1}`, name: `blog ${i + 1}` })),
      ],
      media: items('media', 30),
      ...overrides,
    },
  });
}

let pb: Playbook;
beforeAll(async () => {
  pb = await loadPlaybook(DIR);
});

function assertTopological(plan: Plan) {
  const seen = new Set<string>();
  for (const t of plan.tasks) {
    for (const d of t.dependsOn)
      expect(seen.has(d), `${t.taskId} before its dependency ${d}`).toBe(true);
    seen.add(t.taskId);
  }
}

describe('compilePlan', () => {
  it('compiles a skeleton before the Blueprint, with one placeholder per forEach template', () => {
    const plan = compilePlan(pb, null);
    const placeholders = plan.tasks.filter((t) => t.kind === 'placeholder').map((t) => t.taskId);
    expect(placeholders).toEqual([
      'port-all',
      'register-all',
      'integrate-all',
      'template-all',
      'migrate-pages-all',
      'upload-media-all',
    ]);
    expect(plan.tasks.find((t) => t.taskId === 'register-all')!.dependsOn).toEqual(['port-all']);
    expect(plan.tasks.find((t) => t.taskId === 'port-all')!.title).toBe(
      'Port all components to Content SDK',
    );
    expect(plan.blueprintVersion).toBeNull();
    assertTopological(plan);
  });

  it('expands per Blueprint item, skips dropped items, and orders by dependency', () => {
    const plan = compilePlan(
      pb,
      blueprint({
        components: COMPONENTS.map((k) => ({
          key: k,
          name: k,
          pilot: PILOT.has(k),
          status: k === 'quote-calculator' ? 'drop' : 'keep',
        })),
      }),
    );
    const ids = plan.tasks.map((t) => t.taskId);
    expect(ids.filter((id) => id.startsWith('port-'))).toHaveLength(7);
    expect(ids).not.toContain('port-quote-calculator');
    expect(plan.tasks.filter((t) => t.templateId === 'migrate-pages-{key}')).toHaveLength(25);
    expect(plan.tasks.find((t) => t.taskId === 'migrate-pages-page-1')).toMatchObject({
      title: 'Migrate page 1',
      batchSize: 8,
      itemKeys: ['page-1'],
      workstream: 'content',
    });
    const parity = plan.tasks.find((t) => t.taskId === 'audit-parity')!;
    expect(parity.dependsOn).toHaveLength(25 + 30 + 1);
    expect(plan.tasks.map((t) => t.phase)).toEqual(
      [...plan.tasks.map((t) => t.phase)].sort((a, b) => a - b),
    );
    assertTopological(plan);
  });

  it('gives merged items no tasks of their own when the project compiles that way, and keeps them otherwise', () => {
    const merged = blueprint({
      components: COMPONENTS.map((k) => ({
        key: k,
        name: k,
        pilot: PILOT.has(k),
        // Tabs ships as a variant of Card Grid; a merge without a target stays its own work.
        ...(k === 'tabs' ? { status: 'merge', attrs: { mergedInto: 'card-grid' } } : {}),
        ...(k === 'quote-calculator' ? { status: 'merge' } : {}),
      })),
    });
    const ids = (p: Plan) => p.tasks.map((t) => t.taskId);
    const skipping = compilePlan(pb, merged, { skipMerged: true });
    expect(ids(skipping).filter((id) => id.endsWith('-tabs'))).toEqual([]);
    expect(ids(skipping)).toContain('port-card-grid');
    expect(ids(skipping)).toContain('port-quote-calculator');
    assertTopological(skipping);
    // A project compiled before this existed keeps its merged items' tasks: its history has them.
    const keeping = compilePlan(pb, merged);
    expect(ids(keeping).filter((id) => id.endsWith('-tabs')).length).toBeGreaterThan(0);
  });

  it('builds the pilot slice: non-pilot work waits on a checkpoint after the pilot items', () => {
    const plan = compilePlan(pb, blueprint());
    const byId = new Map(plan.tasks.map((t) => [t.taskId, t]));
    const checkpoint = byId.get(PILOT_CHECKPOINT)!;
    expect(checkpoint).toMatchObject({ kind: 'checkpoint', gate: null, phase: 4 });
    expect(checkpoint.dependsOn.sort()).toEqual(
      [
        ...SLICE.flatMap((k) => [`port-${k}`, `register-${k}`, `integrate-${k}`]),
        'switch-editing-host',
        'prove-pilot-slice',
      ].sort(),
    );
    expect(byId.get('port-tabs')!.dependsOn).toEqual(['design-system', PILOT_CHECKPOINT]);
    expect(byId.get('register-tabs')!.dependsOn).toEqual(['port-tabs']);
    expect(byId.get('port-hero')!.dependsOn).toEqual(['design-system']);
    const pilotWork = SLICE.flatMap((k) => [`port-${k}`, `register-${k}`, `integrate-${k}`]);
    // The end-to-end proof waits on the site's own editing host, the header and footer designs and
    // every pilot task, not on the rest.
    expect(byId.get('prove-pilot-slice')!.dependsOn.sort()).toEqual(
      ['switch-editing-host', 'partial-designs', ...pilotWork].sort(),
    );
    // The proof checks the pilot components only: the rest aren't built yet.
    expect(byId.get('prove-pilot-slice')).toMatchObject({ collection: 'components' });
    expect([...byId.get('prove-pilot-slice')!.itemKeys].sort()).toEqual([...SLICE].sort());
    expect(byId.get('switch-editing-host')!.itemKeys).toEqual([]);
    // The site moves to its own host once the pilot components are on it, after the Director approves.
    expect(byId.get('switch-editing-host')!.dependsOn).toEqual(['approve-switch-editing-host']);
    expect(byId.get('approve-switch-editing-host')!.dependsOn.sort()).toEqual(
      ['integrate-head', ...pilotWork].sort(),
    );
    expect(byId.get('integrate-tabs')!.dependsOn).toEqual(['register-tabs', 'integrate-head']);
    // Wildcards never pick up the checkpoint itself.
    expect(byId.get('validate-components')!.dependsOn).not.toContain(PILOT_CHECKPOINT);
  });

  it('puts a Director approval in front of every release, carrying its rollback plan', () => {
    const plan = compilePlan(pb, blueprint());
    const byId = new Map(plan.tasks.map((t) => [t.taskId, t]));
    const approval = byId.get('approve-publish-edge')!;
    expect(approval).toMatchObject({ kind: 'checkpoint', gate: 'release', phase: 8 });
    expect(approval.dependsOn).toEqual(['deploy-code']);
    expect(approval.contract?.rollback).toMatch(/Republish the previous item versions/);
    expect(byId.get('publish-edge')!.dependsOn).toEqual(['approve-publish-edge']);
    expect(byId.get('approve-deploy-code')!.dependsOn).toEqual(['finalize-head']);
    const ids = plan.tasks.map((t) => t.taskId);
    expect(ids.indexOf('approve-prepare-hosting')).toBe(ids.indexOf('prepare-hosting') - 1);
  });

  it('marks the approval of a build-only release as standing, and keeps production releases asked', () => {
    const plan = compilePlan(pb, blueprint());
    const byId = new Map(plan.tasks.map((t) => [t.taskId, t]));
    expect(byId.get('approve-switch-editing-host')!.standing).toBe(true);
    expect(byId.get('approve-prepare-hosting')!.standing).toBe(true);
    expect('standing' in byId.get('approve-deploy-code')!).toBe(false);
    expect('standing' in byId.get('approve-publish-edge')!).toBe(false);
  });

  it("gives each component's integration its port to follow when the port is redone", () => {
    const plan = compilePlan(pb, blueprint());
    const byId = new Map(plan.tasks.map((t) => [t.taskId, t]));
    expect(byId.get('integrate-hero')!.redoWith).toEqual(['port-hero']);
    expect(byId.get('integrate-card-grid')!.redoWith).toEqual(['port-card-grid']);
    // Only templates that declare it carry the field.
    expect('redoWith' in byId.get('port-hero')!).toBe(false);
  });

  it('includes a template with `when` only for projects with that feature', () => {
    const without = compilePlan(pb, blueprint());
    expect(without.tasks.map((t) => t.taskId)).not.toContain('uat-personalization');
    const withIt = compilePlan(pb, blueprint(), { features: ['personalization'] });
    expect(withIt.tasks.find((t) => t.taskId === 'uat-personalization')).toMatchObject({
      phase: 9,
      dependsOn: ['handover-pack'],
    });
  });

  it('inventories the repository with one, and the live site without (`unless`)', () => {
    const ids = (features?: string[]) =>
      compilePlan(pb, blueprint(), { features }).tasks.map((t) => t.taskId);
    const deps = (features?: string[]) =>
      compilePlan(pb, blueprint(), { features }).tasks.find((t) => t.taskId === 'draft-blueprint')!
        .dependsOn;
    expect(ids(['source-repo'])).toContain('inventory-repo');
    expect(ids(['source-repo'])).not.toContain('inventory-live-ui');
    expect(deps(['source-repo'])).toEqual(['inventory-repo', 'crawl-site', 'platform-notes']);
    expect(ids()).toContain('inventory-live-ui');
    expect(ids()).not.toContain('inventory-repo');
    expect(deps()).toEqual(['inventory-live-ui', 'crawl-site', 'platform-notes']);
  });

  it('turns the checkpoint into a Director gate when the optional gate is on', () => {
    const plan = compilePlan(pb, blueprint(), { enabledGates: ['pilot-slice-review'] });
    expect(plan.tasks.find((t) => t.taskId === PILOT_CHECKPOINT)).toMatchObject({
      gate: 'pilot-slice-review',
      title: 'Pilot slice review',
    });
  });

  it('is deterministic', () => {
    expect(compilePlan(pb, blueprint())).toEqual(compilePlan(pb, blueprint()));
  });

  it('reports a missing collection and a dependency cycle', () => {
    const { media: _media, ...rest } = blueprint().collections;
    const noMedia = Blueprint.parse({ version: 1, collections: rest });
    expect(() => compilePlan(pb, noMedia)).toThrow(/Blueprint has no "media" collection/);

    const cyclic: Playbook = structuredClone(pb);
    cyclic.plan.templates.find((t) => t.id === 'create-site')!.dependsOn = ['validate-foundation'];
    try {
      compilePlan(cyclic, null);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PlanError);
      expect((e as PlanError).problems.join()).toMatch(
        /dependency cycle: .*create-site.*validate-foundation/,
      );
    }
  });
});

describe('re-planning', () => {
  it('describes the impact of dropping the blog in the words the Chief of Staff uses', () => {
    const before = blueprint();
    const after = blueprint({
      templates: ['home', 'landing', 'article', 'blog'].map((k) => ({
        key: k,
        name: `${k} page`,
        status: k === 'blog' ? 'drop' : 'keep',
      })),
      pages: before.collections.pages!.map((p) => ({
        ...p,
        status: p.key.startsWith('blog') ? 'drop' : 'keep',
      })),
    });
    const a = compilePlan(pb, before);
    const b = compilePlan(pb, { ...after, version: 2 });
    const diff = diffPlans(a, b);
    expect(diff.removed.map((t) => t.taskId).sort()).toEqual(
      [
        'migrate-pages-blog-1',
        'migrate-pages-blog-2',
        'migrate-pages-blog-3',
        'migrate-pages-blog-4',
        'migrate-pages-blog-5',
        'template-blog',
      ].sort(),
    );
    // Only dependency lists change elsewhere (audit-parity, validate-templates...): no re-runs.
    expect(diff.changed.every((c) => c.fields.join() === 'dependsOn')).toBe(true);

    const states = {
      'template-blog': 'done' as const,
      'migrate-pages-blog-1': 'done' as const,
      'audit-parity': 'done' as const,
    };
    const impact = impactOf(diff, states, diffBlueprints(before, after));
    expect(impact.rollback.sort()).toEqual(['migrate-pages-blog-1', 'template-blog']);
    expect(impact.cancel).toHaveLength(4);
    expect(impact.rerun).toEqual([]);
    expect(impact.summary).toBe(
      'Removes 5 pages and 1 template in scope; 2 completed tasks rolled back.',
    );
  });

  it('flags started tasks whose scope changed for re-run', () => {
    const a = compilePlan(pb, blueprint());
    const renamed = blueprint({
      components: COMPONENTS.map((k) => ({
        key: k,
        name: k === 'hero' ? 'Hero banner' : k,
        pilot: PILOT.has(k),
      })),
    });
    const b = compilePlan(pb, renamed);
    const impact = impactOf(
      diffPlans(a, b),
      { 'port-hero': 'done' },
      diffBlueprints(blueprint(), renamed),
    );
    expect(impact.rerun).toEqual(['port-hero']);
    expect(impact.summary).toBe('Changes 1 component in scope; 1 started task re-run.');
  });
});

describe('scheduling', () => {
  it('starts phases in dependency order, including 4 and 5 in parallel', () => {
    const plan = compilePlan(pb, blueprint());
    expect(startablePhases(plan, new Set(), new Set())).toEqual([0]);
    expect(startablePhases(plan, new Set([0, 1, 2, 3]), new Set([0, 1, 2, 3]))).toEqual([4, 5]);
    expect(startablePhases(plan, new Set([0, 1, 2, 3, 4]), new Set([0, 1, 2, 3, 4, 5]))).toEqual(
      [],
    );
    expect(startablePhases(plan, new Set([0, 1, 2, 3, 4, 5]), new Set([0, 1, 2, 3, 4, 5]))).toEqual(
      [6],
    );
  });

  it('dispatches pilot tasks first, then the rest after the checkpoint', () => {
    const plan = compilePlan(pb, blueprint());
    const active = new Set([4]);
    const states: Record<string, 'done'> = {};
    for (const t of plan.tasks.filter((t) => t.phase < 4)) states[t.taskId] = 'done';
    const ready = readyTasks(plan, states, active).map((t) => t.taskId);
    expect(ready).toEqual([...SLICE.map((k) => `port-${k}`), 'integrate-head']);

    for (const k of SLICE) states[`port-${k}`] = states[`register-${k}`] = 'done';
    states['integrate-head'] = 'done';
    expect(readyTasks(plan, states, active).map((t) => t.taskId)).toEqual(
      SLICE.map((k) => `integrate-${k}`),
    );
    for (const k of SLICE) states[`integrate-${k}`] = 'done';
    // The header and footer designs as soon as those two are on the editing host.
    expect(readyTasks(plan, states, active).map((t) => t.taskId)).toEqual([
      'approve-switch-editing-host',
      'partial-designs',
    ]);
    states['approve-switch-editing-host'] = states['partial-designs'] = 'done';
    // Their shared content right after, alongside the switch to the site's own host.
    expect(readyTasks(plan, states, active).map((t) => t.taskId)).toEqual([
      'switch-editing-host',
      'migrate-shared-chrome',
    ]);
    states['switch-editing-host'] = states['migrate-shared-chrome'] = 'done';
    expect(readyTasks(plan, states, active).map((t) => t.taskId)).toEqual(['prove-pilot-slice']);
    states['prove-pilot-slice'] = 'done';
    expect(readyTasks(plan, states, active).map((t) => t.taskId)).toEqual([PILOT_CHECKPOINT]);
    states[PILOT_CHECKPOINT] = 'done';
    expect(readyTasks(plan, states, active).map((t) => t.taskId)).toEqual(
      ['card-grid', 'tabs', 'quote-calculator'].map((k) => `port-${k}`),
    );
    expect(phaseComplete(plan, states, 4)).toBe(false);
  });

  it('rolls back dependents before what they depend on', () => {
    const plan = compilePlan(pb, blueprint());
    expect(rollbackOrder(plan, ['port-hero', 'register-hero', 'validate-components'])).toEqual([
      'validate-components',
      'register-hero',
      'port-hero',
    ]);
    // The header and footer designs bind only the shared components' renderings: a body
    // component's rework no longer rolls back the designs and every template.
    expect(dependentsOf(plan, 'port-tabs')).toEqual([
      'register-tabs',
      'integrate-tabs',
      'validate-components',
    ]);
    expect(dependentsOf(plan, 'port-footer')).toContain('partial-designs');
  });
});

describe('Blueprint scope', () => {
  it('keeps a proper scope, and sets aside one in another shape instead of rejecting the Blueprint', () => {
    const base = { version: 1, collections: { pages: [] } };
    const kept = Blueprint.parse({
      ...base,
      scope: { pagesFound: 2693, approach: 'Blog posts are imported in bulk after launch.' },
    });
    expect(kept.scope).toMatchObject({ pagesFound: 2693, sections: [] });
    // Microsoft's demo Solution Architect wrote a scope naming its two pages, with no approach.
    const odd = Blueprint.safeParse({ ...base, scope: { pages: ['/', '/404'], note: 'demo' } });
    expect(odd.success).toBe(true);
    expect(odd.success && odd.data.scope).toBeUndefined();
  });
});

describe('the shared header, footer and navigation first', () => {
  const item = (key: string, attrs: Record<string, unknown> = {}, pilot = false) => ({
    key,
    name: key,
    status: 'keep' as const,
    pilot,
    attrs,
  });
  const bp = (components: ReturnType<typeof item>[]) =>
    Blueprint.parse({
      version: 1,
      collections: {
        components,
        templates: [item('home')],
        pages: [item('home', { path: '/', template: 'home' })],
        media: [],
      },
    });

  it('builds the partial designs on the shared components alone, and their content right after', async () => {
    const pb = await loadPlaybook(
      fileURLToPath(new URL('../../../playbooks/sitecoreai-homepage-demo', import.meta.url)),
    );
    const plan = compilePlan(
      pb,
      bp([
        item('site-header', { datasource: 'shared' }),
        item('site-footer', { datasource: 'shared' }),
        item('hero', { datasource: 'page' }),
        item('cards', { datasource: 'page' }),
      ]),
    );
    const task = (id: string) => plan.tasks.find((t) => t.taskId === id)!;
    expect(task('partial-designs').phase).toBe(4);
    expect(task('partial-designs').dependsOn.sort()).toEqual([
      'integrate-site-footer',
      'integrate-site-header',
      'register-site-footer',
      'register-site-header',
    ]);
    expect(task('migrate-shared-chrome')).toMatchObject({
      phase: 4,
      dependsOn: ['partial-designs'],
    });
    expect(task('prove-slice').dependsOn).toContain('partial-designs');
    // Nothing marked shared: names that say header, footer or navigation stand for them.
    const unmarked = compilePlan(pb, bp([item('site-nav'), item('hero')]));
    expect(unmarked.tasks.find((t) => t.taskId === 'partial-designs')!.dependsOn.sort()).toEqual([
      'integrate-site-nav',
      'register-site-nav',
    ]);
  });

  it('puts the shared components in the website pilot, so they are built first', async () => {
    const pb = await loadPlaybook(
      fileURLToPath(new URL('../../../playbooks/sitecoreai-migration', import.meta.url)),
    );
    const plan = compilePlan(
      pb,
      bp([
        item('hero', { datasource: 'page' }, true),
        item('site-footer', { datasource: 'shared' }),
        item('cards', { datasource: 'page' }),
      ]),
    );
    const checkpoint = plan.tasks.find((t) => t.taskId === PILOT_CHECKPOINT)!;
    expect(checkpoint.itemKeys.sort()).toEqual(['hero', 'site-footer']);
    // The footer doesn't wait on the pilot; the non-pilot cards do.
    expect(plan.tasks.find((t) => t.taskId === 'port-site-footer')!.dependsOn).not.toContain(
      PILOT_CHECKPOINT,
    );
    expect(plan.tasks.find((t) => t.taskId === 'port-cards')!.dependsOn).toContain(
      PILOT_CHECKPOINT,
    );
  });
});
