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
  /** The Director's instructions for this attempt; what they say the Director did counts as done. */
  director?: string | null;
  /** This Lead's earlier verdicts on the task, oldest first. */
  previous?: string[];
  /** What the specialist's role may change: its tools and write scope. */
  permissions?: string[];
}

const SYSTEM = `You are a Lead reviewing a specialist's finished task before it counts as done. Judge it on evidence, not on the summary:

- The steps are the audit trail of what the specialist actually did: every tool call, with its result code and summary. Each is marked [read], [write] or [release] from the tool's own definition: a [read] step changed nothing, whatever its operation is called. A write counts only if the steps show it succeeded; a claim the steps don't support is not done. Executed is not verified: where the task changed something, look for a read-back or check after the change.
- The Checks section ran just now, after the specialist submitted, against the system as it stands: it covers the final state, whatever the steps did before. Check results inside the steps are from earlier attempts and are superseded. Specialists can't run checks; the system runs them on every submission, so never ask for a re-run.
- Failed checks mean rejection. Pending checks have no automated test yet; they are neither passed nor failed. Don't reject only because a check is pending, but don't treat it as passed either.
- Stay consistent with your earlier verdicts on this task. Don't reverse an instruction you gave unless the steps show it was wrong, and then say so.
- Only ask for what the specialist's role may do (its permissions are listed). Work that belongs to another role or a later task is not a reason to reject: note it in the reason instead.
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
    `Checks (run just now, on the final state):\n${input.checks.length ? input.checks.map((c) => `- ${c.id}: ${c.status}. ${c.detail}`).join('\n') : '- none'}`,
    input.director
      ? `The Director's instructions for this attempt (changes the Director says they made, such as an edit by hand, happened outside the steps and count as done):\n${input.director}`
      : '',
    input.permissions?.length
      ? `The specialist's permissions:\n${input.permissions.map((p) => `- ${p}`).join('\n')}`
      : '',
    input.previous?.length
      ? `Your earlier verdicts on this task (oldest first):\n${input.previous.map((p) => `- ${p}`).join('\n')}`
      : '',
    `The specialist's summary:\n${input.summary || '(none)'}`,
    `Steps (oldest first):\n${input.steps.length ? input.steps.join('\n') : '(no tool calls)'}`,
    `Documents written: ${input.artifacts.length ? input.artifacts.join(', ') : 'none'}`,
  ]
    .filter(Boolean)
    .join('\n\n');
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
