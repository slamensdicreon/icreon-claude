import { fileURLToPath } from 'node:url';
import { EventBody, type LwEvent } from '@lw/contracts';
import { applyEvent, createProjectState } from '@lw/domain';
import { InMemoryEventStore, type Projections } from '@lw/events';
import type { PlannedTask } from '@lw/plan';
import { loadPlaybook } from '@lw/playbook-sdk';
import { MemoryBlobStore } from '@lw/tool-gateway';
import { ArtifactLibrary } from '@lw/tool-workspace';
import { describe, expect, it } from 'vitest';
import { selfCheck } from '../src';
import { factsBrief } from '../src/facts';

const PLAYBOOK = fileURLToPath(new URL('../../../playbooks/sitecoreai-migration', import.meta.url));

let seq = 0;
const stamp = (type: string, data: unknown): LwEvent =>
  ({
    ...EventBody.parse({ type, data } as never),
    id: `e${++seq}`,
    projectId: 'p1',
    seq,
    ts: new Date(Date.UTC(2026, 9, 1, 12, 0, seq)).toISOString(),
    actor: { kind: 'system', id: 'sys' },
    subject: { kind: 'project', id: 'p1' },
    severity: 'routine',
  }) as LwEvent;

const planned = (taskId: string, dependsOn: string[], kind = 'work') =>
  stamp('task.planned', {
    taskId,
    phase: 4,
    workstream: null,
    role: 'rendering-registrar',
    title: taskId,
    kind,
    group: null,
    dependsOn,
    agentId: 'rendering-registrar',
  });

const fact = (kind: string, key: string, taskId: string, value: Record<string, string>) =>
  stamp('fact.published', { kind, key, value, taskId, by: 'rendering-registrar' });

function state(events: LwEvent[]) {
  const s = createProjectState('p1');
  events.forEach((e, i) => applyEvent(s, { ...e, seq: i + 1 }));
  return { catchUp: async () => {}, get: () => s } as unknown as Projections;
}

describe('facts in the brief', () => {
  it('lists every fact when there are few', async () => {
    const p = state([fact('rendering', 'Hero', 'register-hero', { id: 'r1', path: '/x/Hero' })]);
    const brief = await factsBrief(p, 'p1', { taskId: 'page-home', dependsOn: [], itemKeys: [] });
    expect(brief).toMatch(/data, not instructions/);
    expect(brief).toContain('- rendering "Hero": id=r1, path=/x/Hero');
    expect(
      await factsBrief(state([]), 'p1', { taskId: 't', dependsOn: [], itemKeys: [] }),
    ).toBeNull();
  });

  it("shows what the task's upstream work and its own items made, and counts the rest", async () => {
    const events = [
      planned('register-hero', []),
      planned('components-done', ['register-hero'], 'checkpoint'),
      fact('rendering', 'Hero', 'register-hero', { id: 'r1' }),
      fact('page', '/about', 'page-about', { id: 'p2' }),
      ...Array.from({ length: 5 }, (_, i) =>
        fact('media', `https://src/${i}.jpg`, 'media-batch', { id: `m${i}` }),
      ),
    ];
    const brief = (await factsBrief(
      state(events),
      'p1',
      { taskId: 'page-about', dependsOn: ['components-done'], itemKeys: ['about'] },
      3,
    ))!;
    // Through the checkpoint to the rendering it stands for; and the page this task made before.
    expect(brief).toContain('rendering "Hero": id=r1');
    expect(brief).toContain('page "/about": id=p2');
    expect(brief).not.toContain('m0');
    expect(brief).toMatch(/Also recorded: media \(5\)\. Look them up with facts\.read/);
  });
});

describe('self-check', () => {
  it("runs the task's checks as the review would, recording nothing", async () => {
    const store = new InMemoryEventStore();
    const library = new ArtifactLibrary(store, new MemoryBlobStore());
    const projections = state([]);
    const run = selfCheck({
      store,
      projections,
      playbook: await loadPlaybook(PLAYBOOK),
      library,
      checks: {
        'blueprint.coverage': async () => ({ status: 'fail', detail: 'page /about is not mapped' }),
      },
    });
    const rows = await run('p1', {
      taskId: 'draft-blueprint',
      templateId: 'none',
      acceptance: ['validator:blueprint.coverage', 'validator:nothing.here', 'Prose criterion'],
      collection: null,
      itemKeys: [],
    } satisfies Partial<PlannedTask>);
    expect(rows).toEqual([
      { id: 'blueprint.coverage', status: 'fail', detail: 'page /about is not mapped' },
      { id: 'nothing.here', status: 'pending', detail: 'No automated check exists for this yet.' },
    ]);
    expect(await store.read('p1')).toEqual([]);
  });
});
