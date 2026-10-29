import type Anthropic from '@anthropic-ai/sdk';
import { expect, it } from 'vitest';
import { draftRule, type RuleDraft } from '../src/rule-draft';

it('drafts a general rule from the card and the Director’s answer', async () => {
  const seen: string[] = [];
  const client = {
    messages: {
      parse: async (req: { messages: { content: string }[] }) => {
        seen.push(req.messages[0]!.content);
        const parsed: RuleDraft = {
          when: ' the source site refuses a media download ',
          then: 'skip the file and log it as a gap',
        };
        return { parsed_output: parsed, stop_reason: 'end_turn' };
      },
    },
  } as unknown as Anthropic;
  const r = await draftRule(
    {
      card: {
        title: 'Access denied: Upload hero.png',
        context: 'The source answered 403.',
        options: ['Skip it and log the gap', 'Retry later'],
      },
      answer: 'Skip it and log the gap',
      notes: 'They are stock images we no longer license.',
      role: 'Media Migrator',
      task: 'Upload hero.png',
      similar: [{ title: 'Access denied: Upload logo.png', answer: 'Skip it and log the gap' }],
    },
    client,
  );
  expect(r).toEqual({
    when: 'the source site refuses a media download',
    then: 'skip the file and log it as a gap',
  });
  expect(seen[0]).toContain('The Director chose: Skip it and log the gap');
  expect(seen[0]).toContain("The Director's notes: They are stock images we no longer license.");
  expect(seen[0]).toContain('- Access denied: Upload logo.png: Skip it and log the gap');
});
