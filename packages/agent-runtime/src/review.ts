import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

/** A Lead's verdict on a specialist's finished task. */
export const ReviewVerdict = z.object({
  verdict: z.enum(['accept', 'reject']),
  /**
   * For a rejection: what is missing or wrong, written to the specialist as the instruction for
   * its next attempt. For an acceptance: one sentence on what the evidence shows.
   */
  reason: z.string(),
});
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;

export interface ReviewInput {
  lead: {
    name: string;
    mandate: string;
    model: string;
    effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  };
  specialist: string;
  charter: { mission: string; outcomes: { title: string; measure: string }[] } | null;
  task: { title: string; acceptance: string[] };
  /** What the specialist said it did. */
  summary: string;
  /** What it actually did, from the audit trail: one line per tool call. */
  steps: string[];
  /** Documents it wrote this attempt. */
  artifacts: string[];
  /** Automated checks: passed, failed, or pending (no check exists yet). */
  checks: { id: string; status: 'pass' | 'fail' | 'pending'; detail: string }[];
}

const SYSTEM = `You are a Lead reviewing a specialist's finished task before it counts as done. Judge it on evidence, not on the summary:

- The steps are the audit trail of what the specialist actually did: every tool call, with its result code and summary. A write counts only if the steps show it succeeded; a claim the steps don't support is not done. Executed is not verified: where the task changed something, look for a read-back or check after the change.
- Failed checks mean rejection. Pending checks have no automated test yet; they are neither passed nor failed. Don't reject only because a check is pending, but don't treat it as passed either.
- Reject when the acceptance criteria aren't met, when the work went outside the task, or when the summary claims something the steps contradict. Write the reason as a direct instruction for the next attempt.
- Accept when the steps show the task was done as asked. Don't reject for style or for work that belongs to a later task.`;

/** A Lead's review of one task result, with Claude. Structured output keeps it to the verdict. */
export async function reviewTask(
  input: ReviewInput,
  client: Anthropic = new Anthropic(),
): Promise<ReviewVerdict & { tokens: number }> {
  const charter = input.charter
    ? `The team's mission: ${input.charter.mission}\nOutcomes:\n${input.charter.outcomes.map((o) => `- ${o.title} (${o.measure})`).join('\n')}\n\n`
    : '';
  const body = [
    `Task: ${input.task.title}`,
    `Specialist: ${input.specialist}`,
    input.task.acceptance.length
      ? `Acceptance criteria:\n${input.task.acceptance.map((a) => `- ${a}`).join('\n')}`
      : 'Acceptance criteria: none beyond the task itself.',
    `Checks:\n${input.checks.length ? input.checks.map((c) => `- ${c.id}: ${c.status}. ${c.detail}`).join('\n') : '- none'}`,
    `The specialist's summary:\n${input.summary || '(none)'}`,
    `Steps (oldest first):\n${input.steps.length ? input.steps.join('\n') : '(no tool calls)'}`,
    `Documents written: ${input.artifacts.length ? input.artifacts.join(', ') : 'none'}`,
  ].join('\n\n');
  const response = await client.messages.parse({
    model: input.lead.model,
    max_tokens: 4000,
    output_config: { effort: input.lead.effort, format: zodOutputFormat(ReviewVerdict) },
    system: `${SYSTEM}\n\nYou are ${input.lead.name}. ${input.lead.mandate}\n\n${charter}`.trim(),
    messages: [{ role: 'user', content: body }],
  });
  const verdict = response.parsed_output;
  if (!verdict) throw new Error(`Review not readable (stop reason ${response.stop_reason})`);
  const u = response.usage;
  return {
    ...verdict,
    tokens:
      u.input_tokens +
      u.output_tokens +
      (u.cache_read_input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0),
  };
}
