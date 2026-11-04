import type Anthropic from '@anthropic-ai/sdk';
import { expect, it } from 'vitest';
import { compareScreens, type ScreenVerdict } from '../src/visual';

it('tells the judge which differences the Director has already accepted', async () => {
  const systems: string[] = [];
  const client = {
    messages: {
      parse: async (req: { system: string }) => {
        systems.push(req.system);
        const parsed: ScreenVerdict = { verdict: 'match', differences: [], minor: [] };
        return {
          parsed_output: parsed,
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    },
  } as unknown as Anthropic;
  const page = { path: '/', source: [], candidate: [], model: 'm', effort: 'low' as const };
  await compareScreens(page, client);
  await compareScreens(
    { ...page, accepted: ['R-3: when buttons have dark text on yellow, keep them (contrast)'] },
    client,
  );
  expect(systems[0]).not.toContain('already decided');
  expect(systems[1]).toContain(
    "The Director has already decided these differences, so don't report them",
  );
  expect(systems[1]).toContain('- R-3: when buttons have dark text on yellow');
});

it('grounds the judge in measured sections and last round, and sorts major from minor', async () => {
  const sent: { system: string; content: { type: string; text?: string }[] }[] = [];
  const client = {
    messages: {
      parse: async (req: {
        system: string;
        messages: { content: { type: string; text?: string }[] }[];
      }) => {
        sent.push({ system: req.system, content: req.messages[0]!.content });
        const parsed: ScreenVerdict = {
          verdict: 'differs',
          differences: [],
          minor: ['Intro: the source heading is 40px, the new one 48px'],
        };
        return {
          parsed_output: parsed,
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    },
  } as unknown as Anthropic;
  const r = await compareScreens(
    {
      path: '/safety',
      source: [],
      candidate: [],
      model: 'm',
      effort: 'low',
      measured:
        'Measured sections. Source: 1. header; 2. Safety (h1 SAFETY). New page: 1. header; 2. Safety (h1 SAFETY).',
      previous: [
        'Awards: the source shows one row of three awards; the new page shows them stacked',
      ],
    },
    client,
  );
  expect(r).toMatchObject({
    differences: [],
    minor: ['Intro: the source heading is 40px, the new one 48px'],
  });
  const texts = sent[0]!.content.filter((c) => c.type === 'text').map((c) => c.text!);
  expect(texts[0]).toContain('Measured sections.');
  expect(texts[1]).toContain(
    "Last round's findings for this page:\n- Awards: the source shows one row",
  );
  expect(sent[0]!.system).toContain('Never report the reverse of one of them');
  expect(sent[0]!.system).toContain('"minor" is the rest');
});
