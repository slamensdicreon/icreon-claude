import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

/** What a Lead makes of a specialist's question: answer it, or pass it to the Director. */
export const TriageReading = z.object({
  decision: z.enum(['answer', 'forward']),
  /** For an answer: the id of the option chosen, exactly as listed. Empty when forwarding. */
  optionId: z.string(),
  /**
   * For an answer: one or two sentences to the specialist on why, naming what it follows from.
   * For a forward: why this is the Director's call, in one sentence.
   */
  reasoning: z.string(),
  /** Ids of the rules the answer applies, from the list given. */
  ruleIds: z.array(z.string()),
});
export type TriageReading = z.infer<typeof TriageReading>;

export interface TriageInput {
  lead: {
    name: string;
    mandate: string;
    model: string;
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  };
  specialist: string;
  /** The card's category in words ("Media sources"). */
  category: string;
  charter: { mission: string; outcomes: { title: string; measure: string }[] } | null;
  task: { title: string; acceptance: string[] };
  /** The task's Blueprint entry, as the specialist sees it; null when it has none. */
  blueprint: string | null;
  card: {
    title: string;
    context: string;
    impact: string;
    options: { id: string; label: string; recommended: boolean }[];
  };
  /** What the specialist's role may do: its tools and write scope. */
  permissions: string[];
  /** Earlier questions on this task and how they were answered, oldest first. */
  previous: string[];
  /** Rules that may apply: when this happens, do that. */
  rules: { id: string; when: string; then: string }[];
}

/** A Lead's answer, checked: only the card's options, only the rules given. */
export type Triage =
  | { decision: 'answer'; optionId: string; reasoning: string; ruleIds: string[]; tokens: number }
  | { decision: 'forward'; reasoning: string; tokens: number };

const SYSTEM = `You are a Lead. A specialist on your team stopped with a question and asked for a decision. You see it before the Director does: answer it yourself when the answer is yours to give, so the Director only sees the choices that are really theirs.

Answer when the answer follows from what you can see: the Blueprint entry, the team's charter, a rule listed below, the evidence on the card, or your earlier answers on this task. Choose one of the card's options, by its id. The specialist recommended one; take it unless the evidence says otherwise, and say why if you don't.

Forward to the Director when any of these hold:
- It changes scope: adding or dropping pages, components or Blueprint items.
- It needs access, a credential or a permission the team doesn't hold.
- It releases, publishes, deploys, spends budget or passes a gate.
- It is a content, design or brand choice the client owns and nothing you can see settles it.
- None of the options is right, or you aren't confident.

Never invent an option. Write the reasoning to the specialist, plainly, in one or two sentences, naming what the answer follows from (for a rule, its id).`;

/**
 * A Lead's triage of a specialist's question, with Claude. Structured output keeps it to the
 * reading; an option the card doesn't have, or a rule that wasn't given, can't get through.
 */
export async function triageQuestion(
  input: TriageInput,
  client: Anthropic = new Anthropic(),
): Promise<Triage> {
  const charter = input.charter
    ? `The team's mission: ${input.charter.mission}\nOutcomes:\n${input.charter.outcomes.map((o) => `- ${o.title} (${o.measure})`).join('\n')}`
    : '';
  const body = [
    `Task: ${input.task.title}`,
    `Specialist: ${input.specialist}`,
    `Kind of question: ${input.category}`,
    input.task.acceptance.length
      ? `Acceptance criteria:\n${input.task.acceptance.map((a) => `- ${a}`).join('\n')}`
      : '',
    input.blueprint ? `Blueprint entry:\n${input.blueprint}` : 'Blueprint entry: none.',
    input.permissions.length
      ? `The specialist's permissions:\n${input.permissions.map((p) => `- ${p}`).join('\n')}`
      : '',
    input.rules.length
      ? `Rules:\n${input.rules.map((r) => `- ${r.id}: when ${r.when}, ${r.then}`).join('\n')}`
      : 'Rules: none yet.',
    input.previous.length
      ? `Earlier questions on this task (oldest first):\n${input.previous.map((p) => `- ${p}`).join('\n')}`
      : '',
    `The question: ${input.card.title}`,
    `Context: ${input.card.context || '(none)'}`,
    input.card.impact ? `Impact: ${input.card.impact}` : '',
    `Options:\n${input.card.options.map((o) => `- ${o.id}: ${o.label}${o.recommended ? ' (recommended by the specialist)' : ''}`).join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const response = await client.messages.parse({
    model: input.lead.model,
    max_tokens: 2000,
    output_config: { effort: input.lead.effort, format: zodOutputFormat(TriageReading) },
    system: `${SYSTEM}\n\nYou are ${input.lead.name}. ${input.lead.mandate}\n\n${charter}`.trim(),
    messages: [{ role: 'user', content: body }],
  });
  const reading = response.parsed_output;
  if (!reading) throw new Error(`Triage not readable (stop reason ${response.stop_reason})`);
  const u = response.usage;
  const tokens = u
    ? u.input_tokens +
      u.output_tokens +
      (u.cache_read_input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0)
    : 0;
  if (reading.decision === 'forward')
    return { decision: 'forward', reasoning: reading.reasoning, tokens };
  if (!input.card.options.some((o) => o.id === reading.optionId))
    return {
      decision: 'forward',
      reasoning: `The Lead's answer ("${reading.optionId}") isn't one of the card's options.`,
      tokens,
    };
  const known = new Set(input.rules.map((r) => r.id));
  return {
    decision: 'answer',
    optionId: reading.optionId,
    reasoning: reading.reasoning,
    ruleIds: reading.ruleIds.filter((id) => known.has(id)),
    tokens,
  };
}
