import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { costOf } from './pricing';

/**
 * Whose work a failed check is. A page migration fails its page checks for two kinds of reason:
 * its own content (copy, images, which items it placed) or a component's code (layout, colours,
 * spacing no field controls, a rendering that throws). The migrator can fix only the first; a
 * retry for the second costs a full attempt and changes nothing. This sorts each failure so the
 * second kind goes to the component's owner and the page waits for it.
 */
export const AttributionReading = z.object({
  failures: z.array(
    z.object({
      /** The failed check's id, as listed. */
      check: z.string(),
      /** `task`: the specialist can fix it with its own tools. `component`: a component's code. */
      owner: z.enum(['task', 'component']),
      /** For a component: its key, exactly as listed. Empty for the task's own. */
      component: z.string(),
      /** The fix, written to whoever owns it, naming the section and what to change. */
      fix: z.string(),
    }),
  ),
});
export type AttributionReading = z.infer<typeof AttributionReading>;

export interface AttributeInput {
  lead: { model: string; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' };
  task: { title: string; role: string };
  /** What the task's role may change: its tools and write scope. */
  permissions: string[];
  failures: { id: string; detail: string }[];
  /** The components the site's Blueprint keeps, by key and name. */
  components: { key: string; name: string }[];
}

export interface Attribution {
  failures: { check: string; owner: 'task' | 'component'; component: string | null; fix: string }[];
  tokens: number;
  usd: number;
}

const SYSTEM = `You are a Lead sorting a specialist's failed checks by who can fix them. The specialist's permissions are listed: it can change only what they reach. Content work (copy, headings, images and media links, which items and datasources a page uses, list items, field values) is the specialist's. A component's code is not: its layout and arrangement, colours, backgrounds and bands, spacing, typography, icons drawn in code, how it lays out its items, a rendering that throws or renders nothing although its datasource holds the content. The site's header and footer are components too.

For each failure, give one entry per part: if a check names several problems, split them, each with its owner. Name a component only from the list given, by its key; if you can't tell which component a code problem belongs to, or the problem could be the content's, it is the specialist's. Write each fix as an instruction to whoever owns it: the page and section where it shows, what the source has, what to change.`;

/** Sorts a task's failed checks into its own and its components', with Claude. */
export async function attributeFailures(
  input: AttributeInput,
  client: Anthropic = new Anthropic(),
): Promise<Attribution> {
  const body = [
    `Task: ${input.task.title}`,
    `Specialist: ${input.task.role}`,
    input.permissions.length
      ? `The specialist's permissions:\n${input.permissions.map((p) => `- ${p}`).join('\n')}`
      : '',
    `Components (key: name):\n${input.components.map((c) => `- ${c.key}: ${c.name}`).join('\n') || '- none'}`,
    `Failed checks:\n${input.failures.map((f) => `- ${f.id}: ${f.detail}`).join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const response = await client.messages.parse({
    model: input.lead.model,
    max_tokens: 3000,
    output_config: { effort: input.lead.effort, format: zodOutputFormat(AttributionReading) },
    system: SYSTEM,
    messages: [{ role: 'user', content: body }],
  });
  const reading = response.parsed_output;
  if (!reading) throw new Error(`Attribution not readable (stop reason ${response.stop_reason})`);
  const keys = new Set(input.components.map((c) => c.key));
  const checks = new Set(input.failures.map((f) => f.id));
  const failures = reading.failures
    .filter((f) => checks.has(f.check))
    .map((f) =>
      // A component not in the list can't be sent work: it stays the task's own.
      f.owner === 'component' && keys.has(f.component)
        ? { check: f.check, owner: 'component' as const, component: f.component, fix: f.fix }
        : { check: f.check, owner: 'task' as const, component: null, fix: f.fix },
    );
  // A failed check the model left out is the task's, with the check's own words.
  for (const f of input.failures)
    if (!failures.some((x) => x.check === f.id))
      failures.push({ check: f.id, owner: 'task', component: null, fix: f.detail });
  return { failures, ...spendOf(input.lead.model, response.usage) };
}

function spendOf(model: string, usage: Parameters<typeof costOf>[1] | undefined) {
  if (!usage) return { tokens: 0, usd: 0 };
  try {
    return costOf(model, usage);
  } catch {
    return { tokens: usage.input_tokens + usage.output_tokens, usd: 0 };
  }
}
