import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixtures } from '@lw/orchestrator';
import { blueprintSnapshot, compilePlan, type Blueprint } from '@lw/plan';
import { loadPlaybook } from '@lw/playbook-sdk';
import { describe, expect, it } from 'vitest';
import { CHECKS } from '../src';

const dir = (id: string) => fileURLToPath(new URL(`../../../playbooks/${id}`, import.meta.url));
const DEMO = dir('sitecoreai-homepage-demo');
const WEBSITE = dir('sitecoreai-migration');

describe('sitecoreai-homepage-demo playbook', () => {
  it('loads, with the Blueprint gate and the drag-and-drop gate', async () => {
    const pb = await loadPlaybook(DEMO);
    expect(pb.manifest.platform).toBe('sitecoreai');
    expect(pb.manifest.phases).toHaveLength(10);
    expect(pb.manifest.phases.filter((p) => p.gate === 'director').map((p) => p.number)).toEqual([
      2, 9,
    ]);
    expect(pb.manifest.charter.outcomes.map((o) => o.id)).toEqual([
      'drag-and-drop',
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
    // Always our demo tenant: deploy and publish are approved once, in the playbook.
    for (const id of ['deploy-code', 'publish-edge'])
      expect(pb.plan.templates.find((t) => t.id === id)?.release?.standing).toBe(true);
    expect(pb.plan.templates.find((t) => t.id === 'drag-and-drop-check')).toMatchObject({
      phase: 9,
      dependsOn: ['demo-summary'],
      manual: expect.stringContaining('drag a component'),
    });
  });

  it('plans exactly the slice of the example Blueprint', async () => {
    const pb = await loadPlaybook(DEMO);
    const { blueprint } = await loadFixtures(DEMO);
    const plan = compilePlan(pb, blueprint, { skipMerged: true });
    const keys = (prefix: string) =>
      plan.tasks
        .filter((t) => t.taskId.startsWith(prefix))
        .map((t) => t.taskId.slice(prefix.length));
    expect(keys('port-')).toEqual([
      'header',
      'navigation',
      'footer',
      'hero',
      'card-grid',
      'stats-strip',
      'rich-text',
    ]);
    // From 0.2.4 the demo builds the homepage alone: the 404 page is recorded as dropped.
    expect(keys('template-')).toEqual(['home']);
    expect(keys('migrate-pages-')).toEqual(['home']);
    expect(keys('upload-media-')).toEqual(['logo', 'hero-home', 'card-1']);
    // No pilot checkpoint, no serialization or perf audit; the drag-and-drop check closes it.
    expect(plan.tasks.map((t) => t.taskId)).not.toContain('pilot-checkpoint');
    expect(plan.tasks.at(-1)?.taskId).toBe('drag-and-drop-check');
    // The editing host switches once every slice component is in its code.
    const approve = plan.tasks.find((t) => t.taskId === 'approve-switch-editing-host')!;
    expect(approve.dependsOn).toEqual(expect.arrayContaining(['integrate-navigation']));
  });

  it('passes its own Blueprint check; a 0.1.0 project’s held items still read as audited', async () => {
    const { blueprint } = await loadFixtures(DEMO);
    expect(await sliceCheck(blueprint)).toMatchObject({
      status: 'pass',
      detail: 'The demo builds 1 page, 1 template, 7 components and 3 media.',
    });
    // Projects started on 0.1.0 wrote whole-site Blueprints with the rest held.
    const old = {
      ...blueprint,
      collections: {
        ...blueprint.collections,
        pages: [
          ...blueprint.collections.pages!,
          {
            key: 'about',
            name: 'About',
            status: 'drop' as const,
            pilot: false,
            attrs: { held: true, path: '/about' },
          },
        ],
      },
    };
    const snap = blueprintSnapshot({
      seq: 1,
      current: { version: 1, blueprint: old },
      approved: null,
      tasks: [],
      decisions: [],
      collections: [{ name: 'pages', doneLabel: 'migrated' }],
    });
    expect(Object.fromEntries(snap.collections[0]!.rows.map((r) => [r.key, r.status]))).toEqual({
      home: 'planned',
      // The 404 page is recorded as dropped from 0.2.4; the 0.1.0 page beside it reads as held.
      'not-found': 'dropped',
      about: 'held',
    });
  });

  it('grants every tool a role prompt tells the agent to use', async () => {
    const pb = await loadPlaybook(DEMO);
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

  // The demo is a copy of the website playbook's team until the SDK has `extends`. A fix to a
  // website role, prompt or knowledge file must reach the demo too, so the copy may differ only in
  // the files below, each on purpose. Copy the fix across, or add the file here with the reason.
  it("keeps the website playbook's roles, prompts and knowledge, except where it says why", async () => {
    const DIFFERS: Record<string, string> = {
      'prompts/solution-architect.md': 'a Blueprint for the homepage only, the 404 page dropped',
      'prompts/content-analyst.md':
        'inventory the homepage in full, audit the whole site in numbers',
      'prompts/repo-analyst.md': 'inventory the homepage, header, footer and navigation only',
      'prompts/experience-enabler.md':
        'SEO fields and dictionary only; no redirects, sitemap, robots or error pages',
      'roles/experience-enabler.yaml':
        'its mandate names no redirects, sitemap, robots or error pages',
      'prompts/head-integrator.md': 'no 404 page to serve at unknown URLs',
      'prompts/handover-writer.md': 'the demo summary and drag-and-drop checklist',
      'roles/handover-writer.yaml': 'writes the demo summary, not the handover pack',
      'knowledge/definition-of-done.md': "the demo's own Definition of Done",
    };
    const drifted: string[] = [];
    for (const folder of ['roles', 'prompts', 'knowledge']) {
      const [ours, theirs] = await Promise.all(
        [DEMO, WEBSITE].map(async (d) => (await readdir(join(d, folder))).sort()),
      );
      expect(ours, folder).toEqual(theirs);
      for (const f of ours!) {
        const path = `${folder}/${f}`;
        const [a, b] = await Promise.all(
          [DEMO, WEBSITE].map((d) => readFile(join(d, path), 'utf8')),
        );
        if ((a === b) === path in DIFFERS)
          drifted.push(a === b ? `${path} no longer differs` : `${path} differs`);
      }
    }
    expect(drifted).toEqual([]);
  });
});

const sliceCheck = (blueprint: unknown, version?: string) =>
  CHECKS['blueprint.demo-slice']!({
    projectId: 'p1',
    state: { playbook: version ? { id: 'sitecoreai-homepage-demo', version } : null },
    library: {
      read: async (_p: string, id: string) =>
        id === 'blueprint' ? { content: JSON.stringify(blueprint) } : null,
    },
  } as never);

describe('blueprint.demo-slice', () => {
  type Item = Blueprint['collections'][string][number];
  const page = (key: string, attrs: Record<string, unknown>, status: Item['status'] = 'keep') =>
    ({ key, name: key, status, pilot: false, attrs }) satisfies Item;
  const base = (): Blueprint => ({
    version: 1,
    collections: {
      pages: [
        page('home', { path: '/', template: 'home' }),
        page('not-found', { path: '/404', template: 'content', errorPage: 404 }),
        page('about', { held: true, path: '/about' }, 'drop'),
      ],
      templates: [
        { key: 'home', name: 'Home', status: 'keep', pilot: false, attrs: {} },
        { key: 'content', name: 'Content', status: 'keep', pilot: false, attrs: {} },
      ],
      components: [
        {
          key: 'header',
          name: 'Header',
          status: 'keep',
          pilot: true,
          attrs: { datasource: 'shared' },
        },
        {
          key: 'navigation',
          name: 'Navigation',
          status: 'keep',
          pilot: true,
          attrs: { datasource: 'shared' },
        },
        {
          key: 'hero',
          name: 'Hero',
          status: 'keep',
          pilot: true,
          attrs: { variants: [{ name: 'Default', pages: ['/'] }] },
        },
        {
          key: 'faq',
          name: 'Accordion',
          status: 'drop',
          pilot: false,
          attrs: { held: true, fields: [{ name: 'q' }], variants: [{ pages: ['/about'] }] },
        },
      ],
      media: [
        {
          key: 'hero-img',
          name: 'hero.jpg',
          status: 'keep',
          pilot: false,
          attrs: { pages: ['/'] },
        },
      ],
    },
  });
  const problems = async (bp: Blueprint) => {
    const r = await sliceCheck(bp);
    return r.status === 'pass' ? [] : r.detail;
  };

  it('passes the homepage, chrome and their media kept (and a 0.2.3 404 page), the rest held', async () => {
    const r = await sliceCheck(base());
    expect(r).toMatchObject({ status: 'pass' });
    expect(r.detail).toContain('2 pages, 2 templates, 3 components and 1 media');
  });

  it('fails a page kept outside the slice, and a homepage component held', async () => {
    const bp = base();
    bp.collections.pages![2] = { ...bp.collections.pages![2]!, status: 'keep' };
    bp.collections.components![2] = {
      ...bp.collections.components![2]!,
      status: 'drop',
      attrs: { held: true, fields: [{ name: 'heading' }], variants: [{ pages: ['/'] }] },
    };
    const d = await problems(bp);
    expect(d).toContain('page about (/about) is in the Blueprint; only the homepage is built');
    expect(d).toContain('hero is on a page the demo builds (or shared) but dropped');
  });

  it('wants the navigation as its own component, not merged into the header', async () => {
    const bp = base();
    bp.collections.components![1] = {
      ...bp.collections.components![1]!,
      status: 'merge',
      attrs: { mergedInto: 'header' },
    };
    expect(await problems(bp)).toContain(
      'the navigation (navigation) must be its own kept component',
    );
    bp.collections.components!.splice(1, 1);
    expect(await problems(bp)).toContain('no navigation component');
  });

  it('needs no 404 page (0.2.4), wants unused templates and media held, and a reason for every drop', async () => {
    const bp = base();
    bp.collections.pages!.splice(1, 1);
    bp.collections.media!.push({
      key: 'team',
      name: 'team.jpg',
      status: 'keep',
      pilot: false,
      attrs: { pages: ['/about'] },
    });
    bp.collections.templates!.push({
      key: 'landing',
      name: 'Landing',
      status: 'drop',
      pilot: false,
      attrs: {},
    });
    const d = await problems(bp);
    expect(d).not.toContain('404');
    expect(d).toContain("template content isn't used by the pages the demo builds");
    expect(d).toContain("media team isn't used on the pages the demo builds");
    expect(d).toContain('templates landing is dropped with neither attrs.held nor a reason');
  });

  it('fails a kept 404 page from 0.2.5, and still accepts one on older versions', async () => {
    const kept404 = 'the 404 page (not-found) is kept; the homepage demo builds no 404 page';
    for (const v of ['0.2.5', '0.3.0', '1.0.0'])
      expect((await sliceCheck(base(), v)).detail).toContain(kept404);
    for (const v of ['0.2.3', '0.2.4', '0.1.0'])
      expect(await sliceCheck(base(), v)).toMatchObject({ status: 'pass' });
    const dropped = base();
    dropped.collections.pages![1] = {
      ...dropped.collections.pages![1]!,
      status: 'drop',
      attrs: { path: '/404', errorPage: 404, reason: 'The homepage demo builds no 404 page' },
    };
    dropped.collections.templates!.splice(1, 1);
    expect(await sliceCheck(dropped, '0.2.5')).toMatchObject({ status: 'pass' });
  });

  it('wants a merged component to merge into one the demo builds', async () => {
    const bp = base();
    bp.collections.components!.push({
      key: 'jobs',
      name: 'Job Categories',
      status: 'merge',
      pilot: false,
      attrs: { mergedInto: 'faq', variants: [{ pages: ['/careers'] }] },
    });
    expect(await problems(bp)).toContain(
      "jobs is merged into faq, which the demo doesn't build: leave jobs out",
    );
  });
});
