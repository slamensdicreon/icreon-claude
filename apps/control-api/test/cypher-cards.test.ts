import type { ModelClient } from '@lw/agent-runtime';
import { MemoryIntegrationStore } from '@lw/events';
import { expect, it } from 'vitest';
import { PortfolioCypher, type CardForCypher } from '../src/cypher';

/** A scripted Claude: plays the tool calls in order, records the tool results it was sent back. */
function scripted(turns: ({ tool: string; input: Record<string, unknown> } | { text: string })[]) {
  const results: string[] = [];
  let i = 0;
  const model: ModelClient = {
    async create(params) {
      const last = params.messages.at(-1)!;
      if (Array.isArray(last.content))
        for (const b of last.content as any[])
          if (b.type === 'tool_result') results.push(b.content);
      const turn = turns[i++] ?? { text: 'Done.' };
      return {
        content:
          'text' in turn
            ? [{ type: 'text', text: turn.text }]
            : [{ type: 'tool_use', id: `tu-${i}`, name: turn.tool, input: turn.input }],
        stop_reason: 'text' in turn ? 'end_turn' : 'tool_use',
        model: 'scripted',
        usage: { input_tokens: 1, output_tokens: 1 },
      } as any;
    },
  };
  return { model, results };
}

const card = (over: Partial<CardForCypher>): CardForCypher => ({
  escalationId: 'esc-1',
  type: 'decision',
  title: 'A card',
  gist: 'What it is about.',
  options: [
    { id: 'retry', label: 'Retry with the Lead feedback', recommended: true },
    { id: 'accept', label: 'Accept the current output', recommended: false },
  ],
  defaultOptionId: 'retry',
  recommendation: { verdict: "I'd retry with the Lead feedback.", why: 'It waits.', pick: 'retry' },
  alike: 1,
  finalGate: false,
  ...over,
});

it('answers the cards the Director asked it to, as the Director, and refuses gates and unknown options', async () => {
  const waiting = [
    card({ escalationId: 'esc-1', title: 'Port Footer: needs a decision', alike: 3 }),
    card({ escalationId: 'esc-2', title: 'Migrate Shopify Plus: needs a decision' }),
    card({
      escalationId: 'gate-1',
      type: 'gate',
      title: 'Gate 1 review',
      options: [{ id: 'approve', label: 'Approve', recommended: false }],
    }),
  ];
  const answered: { escalationId: string; optionId: string; notes: string }[] = [];
  const { model, results } = scripted([
    { tool: 'list_cards', input: { projectId: 'icreon' } },
    {
      tool: 'answer_cards',
      input: {
        projectId: 'icreon',
        answers: [
          { escalationId: 'esc-1', optionId: 'retry', reason: 'Its recommendation.' },
          { escalationId: 'esc-2', optionId: 'nonsense', reason: 'x' },
          { escalationId: 'gate-1', optionId: 'approve', reason: 'x' },
          { escalationId: 'gone', optionId: 'retry', reason: 'x' },
        ],
      },
    },
    { text: 'Answered four cards with my recommendation.' },
    { text: '```json\n{"title": "Clearing icreon", "summary": "Answered cards on icreon."}\n```' },
  ]);
  const cypher = new PortfolioCypher({
    model,
    store: new MemoryIntegrationStore(),
    portfolio: async () => [{ id: 'icreon', name: 'icreon' } as never],
    playbooks: () => [],
    connections: async () => [],
    detail: async () => null,
    remixDraft: async () => {
      throw new Error('not here');
    },
    cards: async () =>
      waiting.filter((c) => !answered.some((a) => a.escalationId === c.escalationId)),
    answer: async (_project, escalationId, optionId, notes) => {
      answered.push({ escalationId, optionId, notes });
      return { answered: escalationId === 'esc-1' ? 3 : 1 };
    },
  });

  const convo = await cypher.ask('Clear all the cards in icreon with your recommendation.');
  // It read every card, with options and its pick.
  const listed = JSON.parse(results[0]!);
  expect(listed.waiting).toBe(5);
  expect(listed.cards[0].recommendation.pick).toBe('retry');
  // It answered only the valid card, as the Director, with its reason recorded.
  expect(answered).toEqual([
    {
      escalationId: 'esc-1',
      optionId: 'retry',
      notes: "Answered through Cypher at the Director's request: Its recommendation.",
    },
  ]);
  const outcome = JSON.parse(results[1]!);
  expect(outcome.settled).toBe(3);
  expect(outcome.skipped.map((x: { why: string }) => x.why)).toEqual([
    'No option "nonsense" on this card.',
    'A gate: the Director approves or sends it back.',
    'Not waiting any more (answered, or not this project).',
  ]);
  // The reply says what it did, with a way back to Needs you.
  const reply = convo.messages.at(-1)!;
  expect(reply.filed).toEqual([
    { kind: 'answered', ref: 'icreon', title: 'Answered 3 cards on icreon' },
  ]);
  expect(reply.projects).toEqual([{ id: 'icreon', name: 'icreon' }]);
});

it('offers the card tools only where answering is wired', async () => {
  const seen: string[][] = [];
  const model: ModelClient = {
    async create(params) {
      seen.push((params.tools ?? []).map((t: any) => t.name));
      return {
        content: [{ type: 'text', text: 'Hi.' }],
        stop_reason: 'end_turn',
        model: 'x',
        usage: { input_tokens: 1, output_tokens: 1 },
      } as any;
    },
  };
  const base = {
    model,
    store: new MemoryIntegrationStore(),
    portfolio: async () => [],
    playbooks: () => [],
    connections: async () => [],
    detail: async () => null,
    remixDraft: async () => {
      throw new Error('no');
    },
  };
  await new PortfolioCypher(base).ask('Hello');
  expect(seen.flat()).not.toContain('answer_cards');
  seen.length = 0;
  await new PortfolioCypher({
    ...base,
    cards: async () => [],
    answer: async () => ({ answered: 1 }),
  }).ask('Hello');
  expect(seen[0]).toEqual(expect.arrayContaining(['list_cards', 'answer_cards']));
});
