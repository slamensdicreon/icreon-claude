import type Anthropic from '@anthropic-ai/sdk';
import { expect, it } from 'vitest';
import { compareScreens, type ScreenVerdict } from '../src/visual';

it('tells the judge which differences the Director has already accepted', async () => {
  const systems: string[] = [];
  const client = {
    messages: {
      parse: async (req: { system: string }) => {
        systems.push(req.system);
        const parsed: ScreenVerdict = { verdict: 'match', differences: [] };
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
