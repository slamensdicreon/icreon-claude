import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { readDirective, type DirectiveReading } from '../src/directives';

const answering = (parsed: DirectiveReading, seen: string[] = []) =>
  ({
    messages: {
      parse: async (req: { messages: { content: string }[] }) => {
        seen.push(req.messages[0]!.content);
        return { parsed_output: parsed, stop_reason: 'end_turn' };
      },
    },
  }) as unknown as Anthropic;

const tasks = [
  { taskId: 'integrate-head', title: 'Configure the head as the editing host', state: 'blocked' },
];

describe('readDirective', () => {
  it('names tasks to re-run from the plan, with the Director’s instructions', async () => {
    const seen: string[] = [];
    const r = await readDirective(
      { text: 'We need David to configure the head again', items: [], tasks },
      answering(
        {
          kind: 'rerun',
          interpretation: 'David should configure the head again',
          drop: [],
          rerun: ['integrate-head', 'made-up'],
          notes: 'Integrate all accepted branches, not fresh',
          answers: [],
        },
        seen,
      ),
    );
    expect(seen[0]).toContain('- integrate-head: Configure the head as the editing host (blocked)');
    expect(r).toMatchObject({ kind: 'rerun', rerun: ['integrate-head'] });
  });

  it('keeps a re-run naming no task in the plan as a note', async () => {
    const r = await readDirective(
      { text: 'Redo the thing', items: [], tasks },
      answering({
        kind: 'rerun',
        interpretation: 'redo it',
        drop: [],
        rerun: ['x'],
        notes: '',
        answers: [],
      }),
    );
    expect(r.kind).toBe('note');
  });

  it('answers only cards that wait, each with one of its own options', async () => {
    const seen: string[] = [];
    const cards = [
      {
        escalationId: 'esc-1',
        type: 'decision',
        title: 'Port Footer: needs a decision',
        options: [
          { id: 'retry', label: 'Retry with the Lead feedback', recommended: true },
          { id: 'accept', label: 'Accept the current output', recommended: false },
        ],
        defaultOptionId: 'retry',
      },
      {
        escalationId: 'esc-2',
        type: 'decision',
        title: 'Migrate Shopify Plus: needs a decision',
        options: [{ id: 'retry', label: 'Retry with the Lead feedback', recommended: true }],
        defaultOptionId: 'retry',
      },
    ];
    const r = await readDirective(
      { text: 'Clear all the cards with your recommendation', items: [], tasks, cards },
      answering(
        {
          kind: 'answer',
          interpretation: 'answer every card with your recommendation',
          drop: [],
          rerun: [],
          notes: '',
          answers: [
            { escalationId: 'esc-1', optionId: 'retry' },
            { escalationId: 'esc-1', optionId: 'accept' },
            { escalationId: 'esc-2', optionId: 'made-up' },
            { escalationId: 'gate-1', optionId: 'approve' },
          ],
        },
        seen,
      ),
    );
    expect(seen[0]).toContain('- esc-1 (decision): Port Footer: needs a decision');
    expect(seen[0]).toContain('- retry: Retry with the Lead feedback [recommended] [default]');
    expect(r).toMatchObject({
      kind: 'answer',
      answers: [{ escalationId: 'esc-1', optionId: 'retry' }],
    });
  });

  it('keeps an answer naming no waiting card as a note', async () => {
    const r = await readDirective(
      { text: 'Accept them all', items: [], tasks, cards: [] },
      answering({
        kind: 'answer',
        interpretation: 'accept them all',
        drop: [],
        rerun: [],
        notes: '',
        answers: [{ escalationId: 'nope', optionId: 'accept' }],
      }),
    );
    expect(r.kind).toBe('note');
  });
});
