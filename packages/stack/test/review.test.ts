import { fileURLToPath } from 'node:url';
import type { ReviewInput, ReviewVerdict } from '@lw/agent-runtime';
import type { LwEvent } from '@lw/contracts';
import { createProjectState } from '@lw/domain';
import { InMemoryEventStore, type Projections } from '@lw/events';
import type { Activities } from '@lw/orchestrator';
import type { PlannedTask } from '@lw/plan';
import { loadPlaybook } from '@lw/playbook-sdk';
import { MemoryBlobStore } from '@lw/tool-gateway';
import { ArtifactLibrary } from '@lw/tool-workspace';
import { describe, expect, it } from 'vitest';
import { CHECKS, routeFailures, settleVerdict, withReview } from '../src';

const PLAYBOOK = fileURLToPath(new URL('../../../playbooks/sitecoreai-migration', import.meta.url));

const task = (over: Partial<PlannedTask>): PlannedTask =>
  ({
    taskId: 'draft-blueprint',
    templateId: 'test-template',
    phase: 2,
    role: 'solution-architect',
    workstream: 'discovery',
    title: 'Draft the Implementation Blueprint',
    kind: 'work',
    itemKeys: [],
    collection: null,
    dependsOn: [],
    acceptance: ['validator:blueprint.coverage'],
    gate: null,
    batchSize: 1,
    metric: null,
    estimateHours: null,
    groupTitle: null,
    contract: null,
    ...over,
  }) as PlannedTask;

const component = (key: string, attrs: Record<string, unknown> = {}) => ({
  key,
  name: key,
  pilot: key === 'hero',
  attrs: {
    rendering: 'Hero',
    fields: [{ name: 'heading', type: 'Single-Line Text' }],
    queryBudget: { maxItems: 4 },
    ...attrs,
  },
});

async function setup(
  review: ((i: ReviewInput) => Promise<ReviewVerdict & { tokens: number }>) | null,
) {
  const store = new InMemoryEventStore();
  const library = new ArtifactLibrary(store, new MemoryBlobStore());
  const state = createProjectState('p1');
  const projections = { catchUp: async () => {}, get: () => state } as unknown as Projections;
  const base = { validate: async () => ({ pass: true, reason: null }) } as unknown as Activities;
  const acts = withReview(base, {
    store,
    projections,
    library,
    playbook: await loadPlaybook(PLAYBOOK),
    isLive: async () => true,
    review,
    effect: (_server, op) => (op === 'publish' ? 'release' : null),
  });
  const write = (artifactId: string, content: unknown) =>
    library.write('p1', {
      artifactId,
      kind: artifactId === 'blueprint' ? 'blueprint' : 'inventory',
      title: artifactId,
      format: 'json',
      content: JSON.stringify(content),
      producer: 'solution-architect',
    });
  const validate = (t: PlannedTask, summary = 'Wrote the Blueprint.') =>
    acts.validate({
      projectId: 'p1',
      task: t,
      attempt: 1,
      feedback: null,
      instructions: null,
      result: { tokens: 0, usd: 0, summary },
    });
  const reviews = async () =>
    (await store.read('p1')).filter(
      (e): e is Extract<LwEvent, { type: 'review.recorded' }> => e.type === 'review.recorded',
    );
  return { store, write, validate, reviews };
}

describe('acceptance on live projects', () => {
  it("rejects a Blueprint without a model contract, naming what's missing, before any Lead review", async () => {
    let asked = 0;
    const { write, validate, reviews } = await setup(async () => {
      asked++;
      return { verdict: 'accept', reason: 'ok', tokens: 10 };
    });
    await write('page-inventory', { pages: [{ path: '/' }, { path: '/about' }] });
    await write('blueprint', {
      version: 1,
      collections: {
        components: [
          component('hero'),
          { key: 'cards', name: 'Cards', attrs: { children: { template: 'Card' } } },
        ],
        templates: [{ key: 'content', name: 'Content' }],
        pages: [{ key: 'home', name: 'Home', attrs: { path: '/', template: 'content' } }],
        media: [],
      },
    });
    const r = await validate(task({}));
    expect(r.pass).toBe(false);
    expect(r.reason).toMatch(/page \/about is neither mapped nor dropped/);
    expect(r.reason).toMatch(/cards has no fields/);
    expect(r.reason).toMatch(/cards's child items have no limit/);
    expect(asked).toBe(0);
    expect((await reviews())[0]!.data).toMatchObject({
      reviewerId: 'discovery-lead',
      verdict: 'reject',
    });
  });

  it("judges a task on its template's current checks too, so checks added later apply to running projects", async () => {
    const { write, validate } = await setup(async () => ({
      verdict: 'accept',
      reason: 'ok',
      tokens: 10,
    }));
    await write('page-inventory', { pages: [{ path: '/' }] });
    // Compiled before the template had checks: the playbook's blueprint.coverage still runs.
    const r = await validate(task({ templateId: 'draft-blueprint', acceptance: [] }));
    expect(r).toEqual({
      pass: false,
      reason: 'blueprint.coverage: No Blueprint has been written.',
      checks: [{ id: 'blueprint.coverage', status: 'fail' }],
    });
  });

  it('marks checks that do not exist as pending, never passed, and lets the Lead judge the audit trail', async () => {
    const seen: ReviewInput[] = [];
    const { store, validate, reviews } = await setup(async (i) => {
      seen.push(i);
      return {
        verdict: 'reject',
        reason: 'The steps show no read-back after the publish.',
        tokens: 1234,
      };
    });
    await store.append('p1', [
      {
        type: 'step.recorded',
        actor: { kind: 'agent', id: 'deployment-engineer' },
        subject: { kind: 'step', id: 's1' },
        severity: 'routine',
        data: {
          stepId: 's1',
          agentId: 'deployment-engineer',
          taskId: 'publish-edge',
          toolServer: 'sitecore-authoring',
          operation: 'publish',
          resultCode: 200,
          durationMs: 5,
          summary: 'Published 12 items',
        },
      },
    ]);
    const r = await validate(
      task({
        taskId: 'publish-edge',
        role: 'deployment-engineer',
        title: 'Publish to Experience Edge and verify every route',
        acceptance: ['validator:edge.published', 'validator:routes.resolve'],
      }),
      'Published and verified.',
    );
    expect(r).toMatchObject({
      pass: false,
      reason: 'The steps show no read-back after the publish.',
    });
    expect(seen[0]!.lead.name).toBe('Engineering Lead');
    expect(seen[0]!.steps).toEqual([
      expect.stringMatching(/ \[release\] sitecore-authoring\.publish → 200: Published 12 items$/),
    ]);
    expect(seen[0]!.checks.map((c) => c.status)).toEqual(['pending', 'pending']);
    expect(seen[0]!.charter?.outcomes.length).toBeGreaterThan(0);
    const rec = (await reviews())[0]!;
    expect(rec.data).toMatchObject({
      reviewerId: 'engineering-lead',
      verdict: 'reject',
      tokens: 1234,
    });
    expect(rec.data.note).toMatch(/Pending, not passed: edge.published, routes.resolve/);
  });

  it('records how the checks stood on every review, and the grounds of a rejection', async () => {
    const { validate, reviews } = await setup(async () => ({
      verdict: 'reject',
      reason: 'The steps show no read-back after the publish.',
      grounds: 'missing-work',
      cites: '10:00:00 sitecore-authoring.publish',
      tokens: 10,
    }));
    const r = await validate(
      task({
        taskId: 'publish-edge',
        role: 'deployment-engineer',
        acceptance: ['validator:edge.published'],
      }),
    );
    expect(r.checks).toEqual([{ id: 'edge.published', status: 'pending' }]);
    const rec = (await reviews())[0]!;
    expect(rec.data.checks).toEqual([{ id: 'edge.published', status: 'pending' }]);
    expect(rec.data.grounds).toBe('missing-work');
  });

  it('turns a rejection on grounds of report detail into an acceptance with the note', async () => {
    const { validate, reviews } = await setup(async () => ({
      verdict: 'reject',
      reason: 'The summary does not quote the diff.',
      grounds: 'report',
      cites: '',
      tokens: 10,
    }));
    const r = await validate(
      task({ taskId: 'port-cta-band', role: 'component-engineer', acceptance: [] }),
    );
    expect(r.pass).toBe(true);
    const rec = (await reviews())[0]!;
    expect(rec.data.verdict).toBe('accept');
    expect(rec.data.note).toMatch(/steps show the work was done.*does not quote the diff/);
  });

  it('on the third review of passing work, a rejection stands only on hard grounds with a citation', async () => {
    const rejected = (prior: number, verdict: ReviewVerdict) =>
      settleVerdict({ ...verdict, tokens: 1 }, { failed: 0, priorRejections: prior });
    const soft: ReviewVerdict = {
      verdict: 'reject',
      reason: 'Still thin.',
      grounds: 'none',
      cites: '',
    };
    const hard: ReviewVerdict = {
      verdict: 'reject',
      reason: 'The variant was never registered.',
      grounds: 'missing-work',
      cites: '10:02 sitecore-authoring.item.read',
    };
    // First and second rejections stand whatever their grounds.
    expect(rejected(0, soft).verdict).toBe('reject');
    expect(rejected(1, soft).verdict).toBe('reject');
    // The third does not, unless it is hard and cited.
    expect(rejected(2, soft)).toMatchObject({ verdict: 'accept' });
    expect(rejected(2, soft).reason).toMatch(/Accepted on the checks after 3 reviews.*Still thin/);
    expect(rejected(2, { ...hard, cites: '' }).verdict).toBe('accept');
    expect(rejected(2, hard).verdict).toBe('reject');
    // A stub reviewer with no grounds at all is treated as soft.
    expect(rejected(2, { verdict: 'reject', reason: 'No.' }).verdict).toBe('accept');
    // A failed check always stands, on any review.
    expect(
      settleVerdict(
        { ...soft, grounds: 'failed-check', tokens: 1 },
        { failed: 1, priorRejections: 5 },
      ).verdict,
    ).toBe('reject');
  });

  it('accepts on checks alone when no Lead review is connected, and says so', async () => {
    const { validate, reviews } = await setup(null);
    const r = await validate(task({ acceptance: [] }));
    expect(r.pass).toBe(true);
    expect((await reviews())[0]!.data.note).toMatch(/no Lead review is connected/);
  });

  it('reads the audit trail: a green build must come after the last change, and be committed', async () => {
    const { store, validate } = await setup(null);
    const step = (operation: string, summary: string, code = 200) => ({
      type: 'step.recorded' as const,
      actor: { kind: 'agent' as const, id: 'component-engineer' },
      subject: { kind: 'step' as const, id: operation },
      severity: 'routine' as const,
      data: {
        stepId: crypto.randomUUID(),
        agentId: 'component-engineer',
        taskId: 'port-hero',
        toolServer: 'sandbox',
        operation,
        resultCode: code,
        durationMs: 1,
        summary,
      },
    });
    const t = task({
      taskId: 'port-hero',
      role: 'component-engineer',
      title: 'Port Hero',
      acceptance: ['validator:build.green'],
    });
    await store.append('p1', [
      step('exec.build', 'Build green: type-check and build passed'),
      step('fs.write', 'Wrote 1 file'),
    ]);
    expect((await validate(t)).reason).toMatch(/Files changed after the last green build/);
    await store.append('p1', [step('exec.build', 'Build green: type-check and build passed')]);
    expect((await validate(t)).reason).toMatch(/not committed/);
    await store.append('p1', [step('git.commit', 'Committed 1 file to launchworks/port-hero')]);
    expect((await validate(t)).pass).toBe(true);
  });

  it('accepts committing first and then building green on that commit', async () => {
    const { store, validate } = await setup(null);
    const step = (operation: string, summary: string, code = 200) => ({
      type: 'step.recorded' as const,
      actor: { kind: 'agent' as const, id: 'component-engineer' },
      subject: { kind: 'step' as const, id: operation },
      severity: 'routine' as const,
      data: {
        stepId: crypto.randomUUID(),
        agentId: 'component-engineer',
        taskId: 'port-hero',
        toolServer: 'sandbox',
        operation,
        resultCode: code,
        durationMs: 1,
        summary,
      },
    });
    const t = task({
      taskId: 'port-hero',
      role: 'component-engineer',
      title: 'Port Hero',
      acceptance: ['validator:build.green'],
    });
    await store.append('p1', [
      step('fs.write', 'Wrote 3 files'),
      step('git.commit', 'Committed 3 files to launchworks/port-hero (1bea14f)'),
      step(
        'exec.build',
        'Build green: type-check and build passed (nothing uncommitted, at 1bea14f)',
      ),
      step('git.commit', 'Nothing to commit.', 422),
    ]);
    expect(await validate(t)).toMatchObject({ pass: true });
    // A build with work left uncommitted still needs a commit after it.
    await store.append('p1', [
      step('exec.content-sdk-cli', 'sitecore-tools component generate-map: done'),
      step('exec.build', 'Build green: type-check and build passed (uncommitted changes)'),
    ]);
    expect((await validate(t)).reason).toMatch(/not committed/);
  });
});

describe('head.editing-scripts', () => {
  const run = (layout: string | null, scripts = '<EditingScripts />') =>
    CHECKS['head.editing-scripts']!({
      projectId: 'p1',
      state: {
        ...createProjectState('p1'),
        buildRepo: { appPath: 'examples/basic-nextjs' },
      } as never,
      library: null as never,
      fetch,
      steps: [],
      read: async (_server, _op, args) => {
        const paths = args.paths as string[];
        expect(paths[0]).toBe('examples/basic-nextjs/src/Layout.tsx');
        if (layout === null) return { code: 200, body: { files: [{ path: paths[0] }] } };
        return {
          code: 200,
          body: {
            files: [
              { path: paths[0], content: layout },
              { path: paths[1], content: scripts },
            ],
          },
        };
      },
    });

  it("passes when the app's Layout loads Sitecore's editing scripts", async () => {
    expect((await run('<><Scripts /><main /></>')).status).toBe('pass');
    expect((await run('<><EditingScripts /></>', '')).status).toBe('pass');
  });

  it('fails when the Layout dropped them, saying what Page builder shows', async () => {
    const r = await run('<><main /></>');
    expect(r.status).toBe('fail');
    expect(r.detail).toContain("doesn't render <Scripts />");
    expect(r.detail).toContain('raw JSON');
    expect((await run('<><Scripts /></>', '<CdpPageView />')).detail).toContain(
      'no longer renders <EditingScripts />',
    );
  });

  it('is pending when the Layout cannot be read', async () => {
    expect((await run(null)).status).toBe('pending');
  });
});

describe('head.sections', () => {
  const dir = 'examples/basic-nextjs/src/components';
  const run = (files: Record<string, string>, taskId?: string, refs: string[] = []) =>
    CHECKS['head.sections']!({
      projectId: 'p1',
      state: {
        ...createProjectState('p1'),
        buildRepo: { appPath: 'examples/basic-nextjs' },
      } as never,
      library: null as never,
      fetch,
      steps: [],
      taskId,
      read: async (_server, op, args) => {
        refs.push(String(args.ref ?? ''));
        if (op === 'tree.read')
          return {
            code: 200,
            body: { entries: Object.keys(files).map((f) => `${dir}/${f} 100`) },
          };
        return {
          code: 200,
          body: {
            files: (args.paths as string[]).map((p) => ({
              path: p,
              content: files[p.slice(dir.length + 1)],
            })),
          },
        };
      },
    });

  it('fails components that render outside Section or ignore the tone parameter', async () => {
    const r = await run({
      'CardGrid.tsx':
        "import { Section } from 'components/ui/Section';\n<Section tone={params.tone}>",
      'RichText.tsx': '<div className="w-full">',
      'Stats.tsx': "import { Section } from './ui/Section';\n<Section>",
      'HeroBanner.tsx': '<section>',
      'ui/Section.tsx': 'export const Section',
    });
    expect(r.status).toBe('fail');
    expect(r.detail).toContain("RichText.tsx doesn't render inside ui/Section");
    expect(r.detail).toContain("Stats.tsx doesn't pass a tone");
    expect(r.detail).not.toContain('CardGrid');
    expect(r.detail).not.toContain('HeroBanner');
  });

  it("judges each folder's rendering, not the helpers beside it", async () => {
    const r = await run({
      'hero-banner/HeroBanner.tsx': '<section>',
      'hero-banner/HeroVideo.tsx': "'use client'; <iframe>",
      'stat-counters/StatCounters.tsx':
        "import { Section } from 'components/ui/Section';\n<Section tone={params.tone}>",
      'stat-counters/CounterNumber.tsx': "'use client'; <span>",
      'promo/PromoCard.tsx': '<div>',
    });
    expect(r.status).toBe('fail');
    expect(r.detail).toContain("promo/PromoCard.tsx doesn't render inside ui/Section");
    expect(r.detail).not.toContain('HeroVideo');
    expect(r.detail).not.toContain('CounterNumber');
  });

  it('judges a port on its own branch', async () => {
    const refs: string[] = [];
    const r = await run(
      { 'CardGrid.tsx': "import { Section } from 'components/ui/Section'; tone" },
      'port-card-grid',
      refs,
    );
    expect(r.status).toBe('pass');
    expect(refs[0]).toBe('launchworks/port-card-grid');
  });
});

describe('routing failed checks to the components that own them', () => {
  const lead = {
    role: 'content-lead',
    name: 'Content Lead',
    model: { id: 'claude-sonnet-5-5', effort: 'low' as const },
  } as never;
  const migrator = {
    role: 'content-migrator',
    name: 'Content Migrator',
    tools: { 'sitecore-authoring': { ops: ['item.update'] } },
  } as never;
  const page = { taskId: 'migrate-pages-home', title: 'Migrate Home', role: 'content-migrator' };
  const taskView = (taskId: string, role: string, itemKeys: string[]) =>
    ({ taskId, role, itemKeys, title: taskId }) as never;

  async function route(
    failures: { check: string; owner: 'task' | 'component'; component: string; fix: string }[],
  ) {
    const store = new InMemoryEventStore();
    const library = new ArtifactLibrary(store, new MemoryBlobStore());
    await library.write('p1', {
      artifactId: 'blueprint',
      kind: 'blueprint',
      title: 'Blueprint',
      format: 'json',
      content: JSON.stringify({
        collections: {
          components: [
            { key: 'hero', name: 'Hero Banner' },
            { key: 'cards', name: 'Service Cards' },
            { key: 'old', name: 'Old', status: 'drop' },
          ],
        },
      }),
      producer: 'solution-architect',
    });
    const state = createProjectState('p1');
    state.tasks = {
      'port-hero': taskView('port-hero', 'component-engineer', ['hero']),
      'register-hero': taskView('register-hero', 'rendering-registrar', ['hero']),
      'integrate-hero': taskView('integrate-hero', 'head-integrator', ['hero']),
      'port-cards': taskView('port-cards', 'component-engineer', ['cards']),
      'migrate-pages-home': taskView('migrate-pages-home', 'content-migrator', ['home']),
    };
    const seen: string[][] = [];
    const routed = await routeFailures({
      deps: {
        library,
        attribute: async (input) => {
          seen.push(input.components.map((c) => c.key));
          return {
            failures: failures.map((f) => ({
              ...f,
              component: f.owner === 'component' ? f.component : null,
            })),
            tokens: 50,
            usd: 0.01,
          };
        },
      },
      projectId: 'p1',
      state,
      task: page,
      role: migrator,
      lead,
      fails: [
        { id: 'parity.visual', status: 'fail', detail: 'Hero: grey band shows black.' },
        { id: 'parity.render', status: 'fail', detail: '/ shows 80% of the text.' },
      ],
      codeRoles: new Set(['component-engineer', 'head-integrator']),
    });
    return { routed, seen };
  }

  it('sends a component failure to every code task of that component, and the page re-checks', async () => {
    const { routed, seen } = await route([
      { check: 'parity.visual', owner: 'component', component: 'hero', fix: 'Make the band grey.' },
    ]);
    // Dropped components are not offered.
    expect(seen[0]).toEqual(['hero', 'cards']);
    expect(routed!.waitOn.sendBack!.map((x) => x.taskId)).toEqual(['port-hero', 'integrate-hero']);
    expect(routed!.waitOn.sendBack![0]!.fixes).toMatch(
      /Migrate Home fails on Hero Banner: Make the band grey/,
    );
    // parity.render was left out by the model: it is the page's own, in its words.
    expect(routed!.waitOn.review).toEqual({ fixes: 'parity.render: / shows 80% of the text.' });
    expect(routed!.reason).toMatch(
      /Hero Banner needs fixing in code.*Yours to fix when it runs again/,
    );
    expect(routed!.tokens).toBe(50);
  });

  it('re-checks without the agent when everything failed was a component’s', async () => {
    const { routed } = await route([
      { check: 'parity.visual', owner: 'component', component: 'hero', fix: 'Grey band.' },
      { check: 'parity.render', owner: 'component', component: 'cards', fix: 'Show the cards.' },
    ]);
    expect(routed!.waitOn.sendBack!.map((x) => x.taskId)).toEqual([
      'port-hero',
      'integrate-hero',
      'port-cards',
    ]);
    expect(routed!.waitOn.review).toEqual({ fixes: null });
    expect(routed!.waitOn.what).toBe('fixes to Hero Banner and Service Cards');
  });

  it('leaves everything with the task when nothing is a component’s', async () => {
    const { routed } = await route([
      { check: 'parity.visual', owner: 'task', component: '', fix: 'Use the source hero image.' },
      { check: 'parity.render', owner: 'task', component: '', fix: 'Add the missing copy.' },
    ]);
    expect(routed).toBeNull();
  });
});
