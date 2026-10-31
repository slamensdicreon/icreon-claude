import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { reviewTask, type ReviewInput, type ReviewReading } from '../src/review';

const answering = (parsed: ReviewReading, seen: { system: string; body: string }[] = []) =>
  ({
    messages: {
      parse: async (req: { system: string; messages: { content: string }[] }) => {
        seen.push({ system: req.system, body: req.messages[0]!.content });
        return {
          parsed_output: parsed,
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 20 },
        };
      },
    },
  }) as unknown as Anthropic;

const input: ReviewInput = {
  lead: {
    name: 'Marcus Reyes',
    mandate: 'Leads engineering.',
    model: 'claude-sonnet-5-5',
    effort: 'low',
  },
  specialist: 'Component Engineer',
  charter: null,
  task: { title: 'Port CTA Band to Content SDK', acceptance: ['validator:build.green'] },
  summary: 'Ported the band.',
  steps: ['10:00:00 [write] sandbox.fs.write → 200: CtaBand.tsx'],
  artifacts: [],
  checks: [{ id: 'build.green', status: 'pass', detail: 'Green on 2b166be.' }],
  previous: ['reject: Explain the duplicate registration.', 'reject: Quote the diff.'],
};

describe('reviewTask', () => {
  it('returns the verdict with its grounds and citation, and counts the tokens', async () => {
    const seen: { system: string; body: string }[] = [];
    const v = await reviewTask(
      input,
      answering(
        {
          verdict: 'reject',
          reason: 'The summary does not quote the diff.',
          grounds: 'report',
          cites: '',
        },
        seen,
      ),
    );
    expect(v).toEqual({
      verdict: 'reject',
      reason: 'The summary does not quote the diff.',
      grounds: 'report',
      cites: '',
      tokens: 120,
    });
    // The prompt names the grounds and the third-review rule.
    expect(seen[0]!.system).toMatch(/failed-check .* missing-work .* outside-task .* report/s);
    expect(seen[0]!.system).toMatch(/third review/);
    expect(seen[0]!.body).toMatch(/Your earlier verdicts on this task/);
  });
});
