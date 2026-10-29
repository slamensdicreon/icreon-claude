import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { triageQuestion, type TriageInput, type TriageReading } from '../src/triage';

const answering = (parsed: TriageReading, seen: { system: string; body: string }[] = []) =>
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

const input: TriageInput = {
  lead: {
    name: 'Danielle Brooks',
    mandate: 'Leads content.',
    model: 'claude-sonnet-5-5',
    effort: 'low',
  },
  specialist: 'Media Migrator',
  category: 'Media sources',
  charter: { mission: 'Move the site', outcomes: [{ title: 'Parity', measure: '98%' }] },
  task: { title: 'Upload hero.png', acceptance: ['Uploaded or logged as a gap'] },
  blueprint: 'media/hero: hero.png, used on Home',
  card: {
    title: 'Access denied: Upload hero.png',
    context: 'The source answered 403 to the download.',
    impact: 'One image missing on Home.',
    options: [
      { id: 'skip', label: 'Skip it and log the gap', recommended: true },
      { id: 'retry', label: 'Retry later', recommended: false },
    ],
  },
  permissions: ['browser: fetch.asset', 'sitecore-authoring: media.upload'],
  previous: [],
  rules: [
    { id: 'R-1', when: 'the source refuses a media download', then: 'skip it and log the gap' },
  ],
};

describe('triageQuestion', () => {
  it('answers with one of the card’s options, citing only the rules it was given', async () => {
    const seen: { system: string; body: string }[] = [];
    const r = await triageQuestion(
      input,
      answering(
        {
          decision: 'answer',
          optionId: 'skip',
          reasoning: 'R-1 covers a refused download.',
          ruleIds: ['R-1', 'R-99'],
        },
        seen,
      ),
    );
    expect(r).toEqual({
      decision: 'answer',
      optionId: 'skip',
      reasoning: 'R-1 covers a refused download.',
      ruleIds: ['R-1'],
      tokens: 120,
      usd: expect.any(Number),
    });
    expect(seen[0]!.system).toMatch(/^You are a Lead/);
    expect(seen[0]!.system).toMatch(/You are Danielle Brooks\. Leads content\./);
    expect(seen[0]!.body).toContain(
      '- R-1: when the source refuses a media download, skip it and log the gap',
    );
    expect(seen[0]!.body).toContain(
      '- skip: Skip it and log the gap (recommended by the specialist)',
    );
    expect(seen[0]!.body).toContain('Blueprint entry:\nmedia/hero: hero.png, used on Home');
  });

  it('forwards when the Lead says so, or picks an option the card doesn’t have', async () => {
    expect(
      await triageQuestion(
        input,
        answering({
          decision: 'forward',
          optionId: '',
          reasoning: 'Drops a page: scope.',
          ruleIds: [],
        }),
      ),
    ).toEqual({
      decision: 'forward',
      reasoning: 'Drops a page: scope.',
      tokens: 120,
      usd: expect.any(Number),
    });
    const r = await triageQuestion(
      input,
      answering({ decision: 'answer', optionId: 'delete-page', reasoning: 'x', ruleIds: [] }),
    );
    expect(r).toMatchObject({ decision: 'forward' });
    expect(r.reasoning).toMatch(/isn't one of the card's options/);
  });
});
