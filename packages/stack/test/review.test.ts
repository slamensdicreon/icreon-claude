import { fileURLToPath } from 'node:url';
import type { ReviewInput } from '@lw/agent-runtime';
import type { LwEvent } from '@lw/contracts';
import { createProjectState } from '@lw/domain';
import { InMemoryEventStore, type Projections } from '@lw/events';
import type { Activities } from '@lw/orchestrator';
import type { PlannedTask } from '@lw/plan';
import { loadPlaybook } from '@lw/playbook-sdk';
import { MemoryBlobStore } from '@lw/tool-gateway';
import { ArtifactLibrary } from '@lw/tool-workspace';
import { describe, expect, it } from 'vitest';
import { withReview } from '../src';

const PLAYBOOK = fileURLToPath(new URL('../../../playbooks/sitecoreai-migration', import.meta.url));

const task = (over: Partial<PlannedTask>): PlannedTask =>
  ({
    taskId: 'draft-blueprint',
    templateId: 'draft-blueprint',
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
  review:
    | ((
        i: ReviewInput,
      ) => Promise<{ verdict: 'accept' | 'reject'; reason: string; tokens: number }>)
    | null,
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
    expect(r).toEqual({ pass: false, reason: 'The steps show no read-back after the publish.' });
    expect(seen[0]!.lead.name).toBe('Engineering Lead');
    expect(seen[0]!.steps).toEqual([
      expect.stringMatching(/sitecore-authoring\.publish → 200: Published 12 items$/),
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

  it('accepts on checks alone when no Lead review is connected, and says so', async () => {
    const { validate, reviews } = await setup(null);
    const r = await validate(task({ acceptance: [] }));
    expect(r.pass).toBe(true);
    expect((await reviews())[0]!.data.note).toMatch(/no Lead review is connected/);
  });
});
