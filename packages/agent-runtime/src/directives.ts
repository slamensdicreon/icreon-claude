import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

/** What the Chief of Staff makes of a Director message. */
export const DirectiveReading = z.object({
  kind: z.enum(['status', 'note', 'replan']),
  /** One plain sentence restating what the Director asked for, in their terms. */
  interpretation: z.string(),
  /** For a re-plan: Blueprint item keys to take out of scope. */
  drop: z.array(z.string()),
});
export type DirectiveReading = z.infer<typeof DirectiveReading>;

export interface DirectiveInput {
  text: string;
  /** The project's Blueprint items, for a re-plan to name. Empty before one exists. */
  items: { collection: string; key: string; name: string; status: string }[];
}

const SYSTEM = `You are the Chief of Staff of a website migration to SitecoreAI. The Director (the human in charge) sent a message. Classify it:

- "status": they want to know where things stand.
- "replan": they want Blueprint items taken out of scope. Put the exact keys of the items to drop in "drop", choosing only from the item list given. Only use this when the message clearly asks to skip, drop, remove or exclude something that is in the list.
- "note": anything else (an instruction, a fact, a preference, an answer). It is recorded for the team.

"interpretation" restates what they asked for in one plain sentence without a trailing period, for example "the source site is https://example.com" or "skip the careers pages".`;

/**
 * Reads a Director message with Claude. Structured output keeps the answer to the schema, and only
 * item keys that exist survive, so a re-plan can never invent scope.
 */
export async function readDirective(
  input: DirectiveInput,
  client: Anthropic = new Anthropic(),
): Promise<DirectiveReading> {
  const items = input.items.length
    ? input.items.map((i) => `- ${i.collection}/${i.key}: ${i.name} (${i.status})`).join('\n')
    : '(no Blueprint yet)';
  const response = await client.messages.parse({
    model: 'claude-sonnet-5-5',
    max_tokens: 2000,
    output_config: { effort: 'low', format: zodOutputFormat(DirectiveReading) },
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Blueprint items:\n${items}\n\nDirector's message:\n${input.text}`,
      },
    ],
  });
  const reading = response.parsed_output;
  if (!reading) throw new Error(`Directive not understood (stop reason ${response.stop_reason})`);
  const known = new Set(input.items.map((i) => i.key));
  const drop = reading.drop.filter((k) => known.has(k));
  if (reading.kind === 'replan' && !drop.length) {
    return { kind: 'note', interpretation: reading.interpretation, drop: [] };
  }
  return { ...reading, drop };
}
