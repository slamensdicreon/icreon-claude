import type { Triage, TriageInput } from '@lw/agent-runtime';
import type { KnowledgeEntry, RuleView } from '@lw/contracts';
import type { ProjectState } from '@lw/domain';
import { InMemoryEventStore, MemoryIntegrationStore } from '@lw/events';
import type { Playbook } from '@lw/playbook-sdk';
import { openBlobStore } from '@lw/tool-gateway';
import { expect, it } from 'vitest';
import { leadTriageInput } from '../src/lead-triage';
import { replayableCards, replayCard, summarizeReplay, triageReplayer } from '../src/triage-replay';

const playbook = {
  manifest: {
    id: 'sitecoreai-migration',
    charter: null,
    defaults: { autonomy: { retry: 'lead', ownership: 'lead', access: 'ask' } },
  },
  roles: [
    {
      role: 'content-migrator',
      name: 'Content Migrator',
      reportsTo: 'content-lead',
      mandate: 'Migrate pages.',
      model: { id: 'model' },
      acceptance: [],
      tools: {},
    },
    {
      role: 'content-lead',
      name: 'Content Lead',
      persona: 'Ada',
      reportsTo: null,
      mandate: 'Own content.',
      model: { id: 'model' },
      acceptance: [],
      tools: {},
    },
  ],
  plan: { templates: [] },
} as unknown as Playbook;

const options = [
  { id: 'opt-1', label: 'Retry: look for it again', recommended: true, key: null },
  { id: 'opt-2', label: 'Retry, and work around what is missing', recommended: false, key: null },
];

const card = (id: string, raisedAt: string, over: Record<string, unknown> = {}) => ({
  escalationId: id,
  type: 'decision',
  title: `Migrate About: what it needs is missing (${id})`,
  context: 'It waits on Port Hero to Content SDK.',
  impact: 'The page waits.',
  options,
  status: 'resolved',
  raisedAt,
  sourceTaskId: 'migrate-about',
  category: 'retry',
  gate: null,
  triage: null,
  resolution: { optionId: 'opt-1', notes: null, by: 'director', supersededBy: null },
  ...over,
});

function project(): ProjectState {
  return {
    projectId: 'p1',
    name: 'Ervin Cable',
    playbook: { id: 'sitecoreai-migration', version: '0.10.0' },
    intake: { platform: 'sitecoreai' },
    settings: {},
    tasks: {
      'migrate-about': {
        taskId: 'migrate-about',
        title: 'Migrate About',
        role: 'content-migrator',
        group: 'migrate-pages',
        itemKeys: ['about'],
      },
      'port-hero': { taskId: 'port-hero', title: 'Port Hero to Content SDK', itemKeys: ['hero'] },
    },
    decisions: [
      {
        decisionId: 'd1',
        ts: '2026-11-04T10:00:00.000Z',
        question: 'Port Hero to Content SDK: name clash',
        answer: 'Rename it',
        rationale: '',
        decidedBy: 'director',
        scopeKey: 'x',
        escalationId: null,
        ref: 'D-1',
      },
      {
        decisionId: 'd2',
        ts: '2026-11-04T12:00:00.000Z',
        question: 'Migrate About: what it needs is missing (b)',
        answer: 'Retry: look for it again',
        rationale: 'The answer to card b itself.',
        decidedBy: 'director',
        scopeKey: 'y',
        escalationId: 'b',
        ref: 'D-2',
      },
    ],
    escalations: {
      a: card('a', '2026-11-04T09:00:00.000Z', {
        triage: {
          leadId: 'content-lead',
          mode: 'shadow',
          optionId: 'opt-2',
          reasoning: '',
          ruleIds: [],
        },
      }),
      b: card('b', '2026-11-04T11:00:00.000Z'),
      c: card('c', '2026-11-04T11:30:00.000Z', {
        resolution: {
          optionId: 'opt-2',
          notes: 'work around it',
          by: 'director',
          supersededBy: null,
        },
      }),
      // Not replayed: a deadline default, a gate, a release, no option, no task.
      d: card('d', '2026-11-04T11:40:00.000Z', { status: 'expired', resolution: null }),
      e: card('e', '2026-11-04T11:41:00.000Z', { gate: { phase: 1 } }),
      f: card('f', '2026-11-04T11:42:00.000Z', { category: 'release' }),
      g: card('g', '2026-11-04T11:43:00.000Z', {
        resolution: { optionId: null, notes: 'x', by: 'director', supersededBy: null },
      }),
      h: card('h', '2026-11-04T11:44:00.000Z', { sourceTaskId: null }),
      i: card('i', '2026-11-04T11:45:00.000Z', {
        resolution: { optionId: 'opt-1', notes: null, by: 'default', supersededBy: null },
      }),
    },
  } as unknown as ProjectState;
}

const rule = (ref: string, createdAt: string, projectId: string): RuleView =>
  ({
    id: ref,
    ref,
    when: `when ${ref}`,
    then: `then ${ref}`,
    createdAt,
    sources: [{ projectId, escalationId: 'x', title: 't', answer: 'a' }],
  }) as unknown as RuleView;
const lesson = (ref: string, createdAt: string, over: Partial<KnowledgeEntry> = {}) =>
  ({
    ref,
    title: ref,
    text: ref,
    createdAt,
    author: 'cypher',
    source: { doc: null, projectId: 'p1', phase: 3 },
    ...over,
  }) as KnowledgeEntry;

const rules = {
  matching: async () => [
    rule('R-1', '2026-11-04T08:00:00.000Z', 'p1'), // before the card: known
    rule('R-2', '2026-11-04T13:00:00.000Z', 'p1'), // learned from this project later: hidden
    rule('R-3', '2026-11-04T13:00:00.000Z', 'p0'), // learned on another project: known today
  ],
} as never;
const knowledge = {
  retrieve: async () => [
    lesson('K-1', '2026-11-04T08:00:00.000Z'),
    lesson('K-2', '2026-11-04T13:00:00.000Z'),
    lesson('K-3', '2026-11-04T13:00:00.000Z', { source: { doc: null, projectId: 'p0', phase: 1 } }),
    lesson('K-4', '2026-11-04T13:00:00.000Z', { author: 'seed', source: null }),
    lesson('K-5', '2026-11-04T13:00:00.000Z', { author: 'director', source: null }),
  ],
} as never;
const library = { read: async () => null } as never;

it('replays only cards the Director answered with an option, on a task, a Lead may settle', () => {
  expect(replayableCards(project()).map((y) => y.escalationId)).toEqual(['a', 'b', 'c']);
});

it('shows the Lead only what was known when the card was raised', async () => {
  const s = project();
  const y = s.escalations.b!;
  const req = {
    projectId: 'p1',
    taskId: 'migrate-about',
    role: 'content-migrator',
    category: 'retry' as const,
    card: { title: y.title, context: y.context, impact: y.impact, options },
    previous: [],
  };
  const then = (await leadTriageInput({ playbook, library, rules, knowledge }, s, req, {
    at: y.raisedAt,
  }))!;
  expect(then.lead).toEqual({ role: 'content-lead', name: 'Ada' });
  expect(then.input.rules.map((r) => r.id)).toEqual(['R-1', 'R-3']);
  expect(then.input.lessons!.map((l) => l.split(':')[0])).toEqual(['K-1', 'K-3', 'K-4']);
  // D-2 is this card's own answer, recorded after it was raised.
  expect(then.input.decisions!.join('\n')).toContain('D-1');
  expect(then.input.decisions!.join('\n')).not.toContain('D-2');

  // Live triage sees everything.
  const now = (await leadTriageInput({ playbook, library, rules, knowledge }, s, req))!;
  expect(now.input.rules).toHaveLength(3);
  expect(now.input.lessons).toHaveLength(5);
});

it('scores the Lead against the answer taken, and against its own shadow answer then', async () => {
  const s = project();
  const asked: TriageInput[] = [];
  const answers: Record<string, Triage> = {
    a: { decision: 'answer', optionId: 'opt-1', reasoning: 'r', ruleIds: [], tokens: 1, usd: 0.01 },
    b: { decision: 'answer', optionId: 'opt-2', reasoning: 'r', ruleIds: [], tokens: 1, usd: 0.01 },
    c: { decision: 'forward', reasoning: 'yours', tokens: 1, usd: 0.01 },
  };
  const triage = async (input: TriageInput) => {
    asked.push(input);
    const id = /\((\w)\)$/.exec(input.card.title)![1]!;
    return answers[id]!;
  };
  const deps = { playbook, library, rules, knowledge, triage };
  const [a, b, c] = await Promise.all(
    ['a', 'b', 'c'].map((id) => replayCard(deps, s, s.escalations[id]!)),
  );
  expect(a).toMatchObject({
    verdict: 'agree',
    taken: { optionId: 'opt-1' },
    lead: { optionId: 'opt-1', label: 'Retry: look for it again' },
    shadow: { optionId: 'opt-2', agreed: false },
  });
  expect(b!.verdict).toBe('differ');
  expect(c).toMatchObject({ verdict: 'forwarded', taken: { notes: 'work around it' } });

  const failing = await replayCard(
    { ...deps, triage: async () => Promise.reject(new Error('overloaded')) },
    s,
    s.escalations.a!,
  );
  expect(failing).toMatchObject({ verdict: 'failed', lead: { reasoning: 'overloaded' } });

  const sum = summarizeReplay([a!, b!, c!, failing], playbook.manifest.defaults.autonomy);
  expect(sum.byCategory).toEqual([
    {
      category: 'retry',
      label: expect.any(String),
      level: 'lead',
      replayed: 4,
      agree: 1,
      differ: 1,
      forwarded: 1,
      failed: 1,
      accuracy: 0.5,
    },
  ]);
  expect(sum.usd).toBe(0.03);
});

it('replays in batches, keeps the results and picks up where it left off', async () => {
  const s = project();
  let calls = 0;
  const replayer = triageReplayer({
    projections: { catchUp: async () => {}, get: () => s } as never,
    store: new InMemoryEventStore(),
    blobs: openBlobStore('memory', '/tmp'),
    playbookFor: () => playbook,
    rules,
    knowledge,
    triage: async () => {
      calls += 1;
      return {
        decision: 'answer',
        optionId: 'opt-1',
        reasoning: 'r',
        ruleIds: [],
        tokens: 1,
        usd: 0,
      };
    },
    results: new MemoryIntegrationStore(),
  });
  const first = (await replayer.run('p1', { limit: 2 }))!;
  expect(first.replayed.map((c) => c.escalationId)).toEqual(['a', 'b']);
  expect(first.remaining).toBe(1);
  const second = (await replayer.run('p1', { limit: 2 }))!;
  expect(second.replayed.map((c) => c.escalationId)).toEqual(['c']);
  expect(second.remaining).toBe(0);
  expect(calls).toBe(3);
  const read = await replayer.results('p1');
  expect(read.cases).toHaveLength(3);
  expect(read.summary.byCategory[0]).toMatchObject({ replayed: 3, agree: 2, differ: 1 });
  // Fresh starts over.
  expect((await replayer.run('p1', { limit: 5, fresh: true }))!.replayed).toHaveLength(3);
});
