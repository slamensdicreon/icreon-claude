import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

/** A rule drafted from one answered card: when this kind of thing happens, do that. */
export const RuleDraft = z.object({
  /** The situation, general enough to match the next card like it (no file names or ids). */
  when: z.string(),
  /** What to do, as an instruction a Lead can apply and an agent can follow. */
  then: z.string(),
});
export type RuleDraft = z.infer<typeof RuleDraft>;

export interface RuleDraftInput {
  /** The card's question, context and options, and what the Director chose. */
  card: { title: string; context: string; options: string[] };
  answer: string;
  notes: string | null;
  /** Who asked, and on what task. */
  role: string | null;
  task: string | null;
  /** Other answered cards that look like the same cause, to generalize from. */
  similar?: { title: string; answer: string }[];
}

const SYSTEM = `You turn a decision the Director made on one card into a rule a Lead can apply to the next card like it, so the Director isn't asked again.

- "when" describes the situation in general terms: the kind of problem, not this card's particulars (no file names, page names, URLs or ids). Start it lowercase, as if after the word "When": "the source site refuses a media download".
- "then" is what to do, as one instruction an agent can follow: "skip the file and log it as a gap for the content team".
- Stay true to what the Director chose and any notes they wrote. Don't widen it beyond what their answer supports.
- One sentence each, plain words.`;

/** Drafts a rule from an answered card with Claude, for the Director to edit and save. */
export async function draftRule(
  input: RuleDraftInput,
  client: Anthropic = new Anthropic(),
): Promise<RuleDraft> {
  const body = [
    input.task ? `Task: ${input.task}` : '',
    input.role ? `Asked by: ${input.role}` : '',
    `Question: ${input.card.title}`,
    `Context: ${input.card.context || '(none)'}`,
    `Options:\n${input.card.options.map((o) => `- ${o}`).join('\n')}`,
    `The Director chose: ${input.answer}`,
    input.notes ? `The Director's notes: ${input.notes}` : '',
    input.similar?.length
      ? `Cards like it, and their answers:\n${input.similar.map((s) => `- ${s.title}: ${s.answer}`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const response = await client.messages.parse({
    model: 'claude-sonnet-5-5',
    max_tokens: 1000,
    output_config: { effort: 'low', format: zodOutputFormat(RuleDraft) },
    system: SYSTEM,
    messages: [{ role: 'user', content: body }],
  });
  const draft = response.parsed_output;
  if (!draft) throw new Error(`Rule draft not readable (stop reason ${response.stop_reason})`);
  return { when: draft.when.trim(), then: draft.then.trim() };
}
