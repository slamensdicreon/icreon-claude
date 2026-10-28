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
      answering({ kind: 'rerun', interpretation: 'redo it', drop: [], rerun: ['x'], notes: '' }),
    );
    expect(r.kind).toBe('note');
  });
});
