import { fileURLToPath } from 'node:url';
import type { RetroInput } from '@lw/agent-runtime';
import { EventBody, type LwEvent } from '@lw/contracts';
import { applyEvent, createProjectState } from '@lw/domain';
import { InMemoryEventStore, MemoryKnowledgeStore, type Projections } from '@lw/events';
import type { PlannedTask } from '@lw/plan';
import { loadPlaybook } from '@lw/playbook-sdk';
import { describe, expect, it } from 'vitest';
import { lessonsFor, runRetrospective, seedPlatformKnowledge } from '../src';

const PLAYBOOK = fileURLToPath(new URL('../../../playbooks/sitecoreai-migration', import.meta.url));
const PITFALLS = fileURLToPath(new URL('../../../platforms/sitecoreai/knowledge', import.meta.url));

async function project(events: { type: string; data: unknown }[]) {
  const store = new InMemoryEventStore();
  await store.append(
    'p1',
    events.map((e) => ({
      ...e,
      actor: { kind: 'system', id: 'sys' },
      subject: { kind: 'project', id: 'p1' },
      severity: 'routine',
    })) as never,
  );
  const s = createProjectState('p1');
  for (const e of await store.read('p1')) applyEvent(s, e as LwEvent);
  // Live, on SitecoreAI, as the wizard records it.
  Object.assign(s, {
    mode: 'live',
    intake: { platform: 'sitecoreai', target: {} },
    playbook: { id: 'sitecoreai-migration', version: '0.8.0' },
  });
  const projections = {
    catchUp: async () => {
      for (const e of (await store.read('p1')).slice(s.seq)) applyEvent(s, e as LwEvent);
    },
    get: () => s,
  } as unknown as Projections;
  return { store, s, projections };
}

const task = (over: Partial<PlannedTask>): PlannedTask =>
  ({
    taskId: 'page-about',
    templateId: 'migrate-page',
    phase: 5,
    role: 'content-migrator',
    title: 'Migrate About Us',
    kind: 'work',
    itemKeys: ['about'],
    collection: 'pages',
    dependsOn: [],
    acceptance: [],
    ...over,
  }) as PlannedTask;

describe('lessons in briefs', () => {
  it("gives a task the active entries that fit it, records which, and leaves out its prompt's document", async () => {
    const { store, projections } = await project([]);
    const knowledge = new MemoryKnowledgeStore();
    expect(
      await seedPlatformKnowledge(knowledge, [{ id: 'sitecoreai', knowledgeDir: PITFALLS }]),
    ).toBeGreaterThan(40);
    const lesson = await knowledge.create({
      kind: 'lesson',
      status: 'active',
      scope: { kind: 'playbook', id: 'sitecoreai-migration' },
      title: 'Page layouts lose components when placed by path',
      text: 'Compose layouts with rendering IDs from the facts.',
      roles: ['content-migrator'],
      author: 'director',
    });
    const playbook = await loadPlaybook(PLAYBOOK);
    const brief = await lessonsFor({ knowledge, projections, store, playbook }, 'p1', task({}));
    expect(brief).toContain(`[${lesson!.ref}] Page layouts lose components`);
    // The Content Migrator's prompt carries the pitfalls file: its rows aren't repeated.
    expect(brief).not.toContain('Likely cause');
    const used = (await store.read('p1')).filter((e) => e.type === 'knowledge.used');
    expect(used).toHaveLength(1);
    expect(used[0]).toMatchObject({ data: { taskId: 'page-about', refs: [lesson!.ref] } });
    expect((await knowledge.get(lesson!.id))!.used).toBe(1);
  });
});

describe('retrospective', () => {
  it('proposes entries with their evidence, once, and nothing active', async () => {
    const { store, projections } = await project([
      {
        type: 'task.planned',
        data: {
          taskId: 'hero',
          phase: 4,
          workstream: null,
          role: 'rendering-registrar',
          title: 'Register Hero',
          kind: 'work',
        },
      },
      {
        type: 'task.state',
        data: { taskId: 'hero', from: 'ready', to: 'running', attempt: 1 },
      },
      {
        type: 'task.state',
        data: {
          taskId: 'hero',
          from: 'running',
          to: 'waiting',
          attempt: 1,
          reason: 'Another registrar holds Available Renderings',
        },
      },
    ]);
    const knowledge = new MemoryKnowledgeStore();
    const playbook = await loadPlaybook(PLAYBOOK);
    const asked: RetroInput[] = [];
    const deps = {
      projections,
      store,
      knowledge,
      playbookOf: () => playbook,
      retrospect: async (input: RetroInput) => {
        asked.push(input);
        return {
          summary: 'Registrars collided on a shared list.',
          tokens: 100,
          proposals: [
            {
              kind: 'lesson' as const,
              title: 'Registrars overwrite Available Renderings',
              text: 'Add to ID lists with add: true.',
              scope: 'platform' as const,
              roles: ['rendering-registrar'],
              operations: ['sitecore-authoring.item.update'],
              tags: ['renderings'],
              evidence: [input.items[0]!.ref],
              cost: '1 wait',
            },
          ],
        };
      },
    };
    const r = await runRetrospective(deps, 'p1', 4);
    expect(asked[0]).toMatchObject({
      project: '',
      platform: 'sitecoreai',
      phase: { number: 4, tasks: 1 },
      model: playbook.roles.find((x) => x.role === 'chief-of-staff')!.model.id,
    });
    expect(r.proposed).toHaveLength(1);
    expect(r.proposed[0]).toMatchObject({
      status: 'proposed',
      kind: 'lesson',
      scope: { kind: 'platform', id: 'sitecoreai' },
      source: { projectId: 'p1', phase: 4 },
      evidence: [{ projectId: 'p1', label: 'Waited: Register Hero' }],
    });
    expect(r.proposed[0]!.text).toMatch(/Phase 4 cost: 1 wait/);
    // Again: nothing new.
    expect((await runRetrospective(deps, 'p1', 4)).proposed).toEqual([]);
    // A phase where nothing went wrong doesn't ask the model.
    expect((await runRetrospective(deps, 'p1', 2)).proposed).toEqual([]);
    expect(asked).toHaveLength(2);
  });
});
