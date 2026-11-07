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
    expect(keys('template-')).toEqual(['home', 'content']);
    expect(keys('migrate-pages-')).toEqual(['home', 'not-found']);
    expect(keys('upload-media-')).toEqual(['logo', 'hero-home', 'card-1']);
    // No pilot checkpoint, no serialization or perf audit; the drag-and-drop check closes it.
    expect(plan.tasks.map((t) => t.taskId)).not.toContain('pilot-checkpoint');
    expect(plan.tasks.at(-1)?.taskId).toBe('drag-and-drop-check');
    // The editing host switches once every slice component is in its code.
    const approve = plan.tasks.find((t) => t.taskId === 'approve-switch-editing-host')!;
    expect(approve.dependsOn).toEqual(expect.arrayContaining(['integrate-navigation']));
  });

  it('passes its own slice check, and shows held items as audited, not built', async () => {
    const { blueprint } = await loadFixtures(DEMO);
    expect((await sliceCheck(blueprint)).status).toBe('pass');
    const snap = blueprintSnapshot({
      seq: 1,
      current: { version: 1, blueprint },
      approved: null,
      tasks: [],
      decisions: [],
      collections: [{ name: 'pages', doneLabel: 'migrated' }],
    });
    expect(Object.fromEntries(snap.collections[0]!.rows.map((r) => [r.key, r.status]))).toEqual({
      home: 'planned',
      'not-found': 'planned',
      about: 'held',
      services: 'held',
      faq: 'held',
      work: 'held',
      'news-1': 'held',
      'old-campaign': 'dropped',
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
      'prompts/solution-architect.md': 'the demo slice: keep the homepage, hold the rest',
      'prompts/content-analyst.md': 'the parity re-crawl reads only the kept pages',
      'prompts/experience-enabler.md': 'only the kept pages; no redirects, sitemap or robots',
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

const sliceCheck = (blueprint: unknown) =>
  CHECKS['blueprint.demo-slice']!({
    projectId: 'p1',
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

  it('passes the homepage, 404, chrome and their media kept, the rest held', async () => {
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
    expect(d).toContain('page about (/about) is kept');
    expect(d).toContain('hero is on the homepage or 404 (or shared) but dropped');
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

  it('wants the 404 page, unused templates and media held, and a reason for every drop', async () => {
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
    expect(d).toContain('no 404 page');
    expect(d).toContain("template content isn't used by the homepage or 404");
    expect(d).toContain("media team isn't used on the homepage");
    expect(d).toContain('templates landing is dropped with neither attrs.held nor a reason');
  });

  it('keeps the model contract of held components', async () => {
    const bp = base();
    bp.collections.components![3] = { ...bp.collections.components![3]!, attrs: { held: true } };
    expect(await problems(bp)).toContain('faq is held but has no fields');
  });
});
