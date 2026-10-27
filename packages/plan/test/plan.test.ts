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

  it('builds the pilot slice: non-pilot work waits on a checkpoint after the pilot items', () => {
    const plan = compilePlan(pb, blueprint());
    const byId = new Map(plan.tasks.map((t) => [t.taskId, t]));
    const checkpoint = byId.get(PILOT_CHECKPOINT)!;
    expect(checkpoint).toMatchObject({ kind: 'checkpoint', gate: null, phase: 4 });
    expect(checkpoint.dependsOn.sort()).toEqual(
      [
        'port-hero',
        'port-promo-card',
        'port-rich-text',
        'register-hero',
        'register-promo-card',
        'register-rich-text',
        'prove-pilot-slice',
      ].sort(),
    );
    expect(byId.get('port-tabs')!.dependsOn).toEqual(['design-system', PILOT_CHECKPOINT]);
    expect(byId.get('register-tabs')!.dependsOn).toEqual(['port-tabs']);
    expect(byId.get('port-hero')!.dependsOn).toEqual(['design-system']);
    // The end-to-end proof waits on the editing host and every pilot task, not on the rest.
    expect(byId.get('prove-pilot-slice')!.dependsOn.sort()).toEqual(
      ['integrate-head', ...[...PILOT].flatMap((k) => [`port-${k}`, `register-${k}`])].sort(),
    );
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

  it('includes a template with `when` only for projects with that feature', () => {
    const without = compilePlan(pb, blueprint());
    expect(without.tasks.map((t) => t.taskId)).not.toContain('prove-personalization');
    const withIt = compilePlan(pb, blueprint(), { features: ['personalization'] });
    expect(withIt.tasks.find((t) => t.taskId === 'prove-personalization')).toMatchObject({
      phase: 7,
      dependsOn: ['enable-experience'],
    });
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
    expect(ready).toEqual(['port-hero', 'port-promo-card', 'port-rich-text', 'integrate-head']);

    for (const k of PILOT) states[`port-${k}`] = states[`register-${k}`] = 'done';
    states['integrate-head'] = 'done';
    expect(readyTasks(plan, states, active).map((t) => t.taskId)).toEqual(['prove-pilot-slice']);
    states['prove-pilot-slice'] = 'done';
    expect(readyTasks(plan, states, active).map((t) => t.taskId)).toEqual([PILOT_CHECKPOINT]);
    states[PILOT_CHECKPOINT] = 'done';
    expect(readyTasks(plan, states, active).map((t) => t.taskId)).toEqual(
      ['header', 'footer', 'card-grid', 'tabs', 'quote-calculator'].map((k) => `port-${k}`),
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
    // Designs bind registered renderings, so they depend on every registration.
    expect(dependentsOf(plan, 'port-tabs')).toEqual([
      'register-tabs',
      'validate-components',
      'partial-designs',
      'template-home',
      'template-landing',
      'template-article',
      'template-blog',
      'validate-templates',
    ]);
  });
});
