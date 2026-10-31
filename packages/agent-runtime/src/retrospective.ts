import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

/** One entry a retrospective proposes, for the Director to approve, edit or reject. */
export const RetroProposal = z.object({
  /** lesson: what to know or do. procedure: steps that worked. gap: needs code or a permission. */
  kind: z.enum(['lesson', 'procedure', 'gap']),
  /** The problem, as an agent would meet it ("Two registrars overwrite Available Renderings"). */
  title: z.string(),
  /** What to do about it, in one to three sentences; for a procedure, the steps in order. */
  text: z.string(),
  /** Where it holds: the platform, this team's playbook, one role, or only this project. */
  scope: z.enum(['platform', 'playbook', 'role', 'project']),
  /** Roles it is for (role ids from the list given); empty for any. */
  roles: z.array(z.string()),
  /** Tool operations it concerns ("sitecore-authoring.item.update"); empty for any. */
  operations: z.array(z.string()),
  tags: z.array(z.string()),
  /** The evidence refs it stands on, from the list given. */
  evidence: z.array(z.string()),
  /** What it cost this phase, in plain words ("9 cards, 3 rejections, about a day"). */
  cost: z.string(),
});
export type RetroProposal = z.infer<typeof RetroProposal>;

export const Retro = z.object({
  /** Two or three sentences on what the phase's problems came down to. */
  summary: z.string(),
  proposals: z.array(RetroProposal),
});
export type Retro = z.infer<typeof Retro>;

export interface RetroInput {
  project: string;
  platform: string | null;
  phase: { number: number; name: string; tasks: number };
  roles: { id: string; name: string }[];
  items: { ref: string; kind: string; role: string | null; title: string; detail: string }[];
  procedures: {
    ref: string;
    role: string;
    title: string;
    attempts: number;
    rejections: number;
    steps: string[];
  }[];
  /** Entries the team already has, so nothing is proposed twice. */
  known: string[];
  model?: string;
}

const SYSTEM = `You are Cypher, the Chief of Staff of an implementation team, running the retrospective of a phase that just ended. You get what the phase cost: the cards the Director had to answer, the Lead's rejections, the waits, the failed checks and the missing capabilities, each with a ref; and the tasks that only got there after more than one try, with the steps of the attempt that worked.

Group them by cause, and propose what the team should know next time so the same thing doesn't cost again:
- A "lesson" says what to do, as an instruction an agent can follow, for a problem an agent will meet again. Write it in general terms: no page names, file names, ids or URLs from this project, unless the scope is "project".
- A "procedure" is the steps that worked for a task that took several tries, written so the next agent gets it right the first time. Only from the procedures given.
- A "gap" is a cause no instruction can fix: it needs code, a tool operation or a permission. Say what is missing.
- Each proposal stands on its evidence: cite the refs. Propose only causes seen at least twice, or once when it cost a rejection or a wait. Prefer fewer, stronger entries: at most eight.
- Choose the narrowest scope that is true: "platform" for how the platform behaves, "playbook" for how this team works, "role" for one role's craft, "project" for this client only.
- Don't repeat what the team already knows (given as known entries); if an existing entry should have prevented a problem, say so in the summary.
- Plain words. The Director reads every proposal and approves, edits or rejects it.`;

/** A phase's retrospective with Claude: proposed lessons, procedures and gaps, with evidence. */
export async function retrospect(
  input: RetroInput,
  client: Anthropic = new Anthropic(),
): Promise<Retro & { tokens: number }> {
  const body = [
    `Project: ${input.project}${input.platform ? ` (platform ${input.platform})` : ''}`,
    `Phase ${input.phase.number}, ${input.phase.name}: ${input.phase.tasks} tasks.`,
    `Roles: ${input.roles.map((r) => `${r.id} (${r.name})`).join(', ')}`,
    input.items.length
      ? `What it cost:\n${input.items.map((i) => `- [${i.ref}] ${i.kind}${i.role ? `, ${i.role}` : ''}: ${i.title}. ${i.detail}`).join('\n')}`
      : 'What it cost: nothing was raised, rejected or waited on.',
    input.procedures.length
      ? `Tasks that took several tries, with the attempt that worked:\n${input.procedures
          .map(
            (p) =>
              `- [${p.ref}] ${p.title} (${p.role}; ${p.attempts} attempts, ${p.rejections} rejections):\n${p.steps.map((s) => `    ${s}`).join('\n')}`,
          )
          .join('\n')}`
      : '',
    input.known.length
      ? `Known entries:\n${input.known.map((k) => `- ${k}`).join('\n')}`
      : 'Known entries: none yet.',
  ]
    .filter(Boolean)
    .join('\n\n');
  const response = await client.messages.parse({
    model: input.model ?? 'claude-opus-5-5',
    max_tokens: 8000,
    output_config: { effort: 'medium', format: zodOutputFormat(Retro) },
    system: SYSTEM,
    messages: [{ role: 'user', content: body }],
  });
  const out = response.parsed_output;
  if (!out) throw new Error(`Retrospective not readable (stop reason ${response.stop_reason})`);
  const refs = new Set([...input.items.map((i) => i.ref), ...input.procedures.map((p) => p.ref)]);
  const roles = new Set(input.roles.map((r) => r.id));
  return {
    summary: out.summary.trim(),
    // Evidence that wasn't given, and roles that don't exist, are dropped; so is an entry left
    // standing on nothing.
    proposals: out.proposals
      .map((p) => ({
        ...p,
        evidence: p.evidence.filter((r) => refs.has(r)),
        roles: p.roles.filter((r) => roles.has(r)),
      }))
      .filter((p) => p.evidence.length && p.title.trim() && p.text.trim())
      .slice(0, 8),
    tokens: response.usage.input_tokens + response.usage.output_tokens,
  };
}
