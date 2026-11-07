import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

/** One waiting proposal, as Cypher reads it. */
export interface ProposalForSort {
  kind: 'knowledge' | 'rule';
  id: string;
  ref: string;
  /** Knowledge: lesson, procedure or gap. Rule: its card category. */
  type: string;
  title: string;
  /** Knowledge: what to know or do. Rule: "When … then …". */
  text: string;
  scope: { kind: string; id: string };
  roles: string[];
  /** The project it came from, by name. */
  from: string | null;
}

export interface ProposalSortInput {
  proposals: ProposalForSort[];
  /** What is already in force, so repeats are caught: "K-12: title" and "R-3: when". */
  active: string[];
  /** The playbooks and platforms there are, so scopes name real ones. */
  playbooks: { id: string; name: string; platform: string }[];
  /** What changed in the product since the proposals were written ("crawl results are now bounded"). */
  notes?: string[];
}

export const ProposalSorting = z.object({
  recommendations: z.array(
    z.object({
      id: z.string(),
      action: z.enum(['approve', 'edit', 'reject']),
      /** One plain sentence the Director reads in the list. */
      reason: z.string(),
      /** The ref of what it repeats, when that's why it's rejected; empty otherwise. */
      duplicateOf: z.string(),
      /** For "edit": only the fields that change; empty strings for the rest. */
      edit: z.object({
        title: z.string(),
        text: z.string(),
        when: z.string(),
        then: z.string(),
        scopeKind: z.string(),
        scopeId: z.string(),
        roles: z.array(z.string()),
      }),
    }),
  ),
});

export interface SortedProposal {
  id: string;
  action: 'approve' | 'edit' | 'reject';
  reason: string;
  duplicateOf: string | null;
  edit: {
    title?: string;
    text?: string;
    when?: string;
    then?: string;
    scope?: { kind: string; id: string };
    roles?: string[];
  } | null;
}

const SYSTEM = `You are Cypher, Chief of Staff of an agent team that builds websites. The team proposes lessons, procedures, known gaps and rules from its projects, and nothing applies until the Director approves it. Read every proposal and recommend one action, so the Director can approve the whole list in one go:
- "approve": true, useful beyond the moment it came from, scoped right, and not already in force.
- "edit": worth keeping, but its scope is wrong (a lesson about every project scoped to one project, or one scoped to every playbook that contradicts how a playbook works), it names a one-off detail where a general rule is meant, or it partly repeats something in force. Give only the fields that change.
- "reject": a repeat of something in force or of another proposal in this list (name it in duplicateOf, and approve the best of the repeats), out of date because the product changed (see the notes), wrong on the evidence, or something agents should never do (accept work that failed its checks, get around a site's protections, skip the Director on a scope or release decision).
Rules settle cards for the Leads, so rules that contradict each other can't both stand: keep the one that protects the work. A gap is engineering's to fix, not an agent's: approve real gaps so they are tracked, reject ones the notes say are fixed.
Scopes: "global", "platform" (a platform id), "playbook" (a playbook id), "role" (a role id, every playbook with that role) or "project" (one project only; right only for something true of that site alone).
Each reason is one plain sentence, under 25 words, that says why, not what the proposal says.`;

/**
 * Cypher's recommendation for each waiting proposal, read together so repeats and contradictions
 * are caught. Ids the model didn't recommend on are left out; ids it made up are dropped.
 */
export async function sortProposals(
  input: ProposalSortInput,
  client: Anthropic = new Anthropic(),
): Promise<SortedProposal[]> {
  if (!input.proposals.length) return [];
  const body = [
    `Playbooks: ${input.playbooks.map((p) => `${p.id} (${p.name}, on ${p.platform})`).join('; ')}`,
    input.notes?.length
      ? `Changed in the product since:\n${input.notes.map((n) => `- ${n}`).join('\n')}`
      : '',
    input.active.length ? `Already in force:\n${input.active.map((a) => `- ${a}`).join('\n')}` : '',
    `Proposals:\n${input.proposals
      .map(
        (p) =>
          `- id ${p.id} (${p.ref}, ${p.kind} ${p.type}, scope ${p.scope.kind}:${p.scope.id}${p.roles.length ? `, roles ${p.roles.join(', ')}` : ''}${p.from ? `, from ${p.from}` : ''})\n  ${p.title}\n  ${p.text}`,
      )
      .join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const response = await client.messages.parse({
    model: 'claude-opus-5-5',
    max_tokens: 16_000,
    output_config: { effort: 'medium', format: zodOutputFormat(ProposalSorting) },
    system: SYSTEM,
    messages: [{ role: 'user', content: body }],
  });
  const out = response.parsed_output;
  if (!out) throw new Error(`Proposal sorting not readable (stop reason ${response.stop_reason})`);
  const known = new Set(input.proposals.map((p) => p.id));
  return out.recommendations
    .filter((r) => known.has(r.id))
    .map((r) => {
      const e = r.edit;
      const edit = {
        ...(e.title.trim() ? { title: e.title.trim() } : {}),
        ...(e.text.trim() ? { text: e.text.trim() } : {}),
        ...(e.when.trim() ? { when: e.when.trim() } : {}),
        ...(e.then.trim() ? { then: e.then.trim() } : {}),
        ...(e.scopeKind.trim() && e.scopeId.trim()
          ? { scope: { kind: e.scopeKind.trim(), id: e.scopeId.trim() } }
          : {}),
        ...(e.roles.length ? { roles: e.roles } : {}),
      };
      const action = r.action === 'edit' && !Object.keys(edit).length ? 'approve' : r.action;
      return {
        id: r.id,
        action,
        reason: r.reason.trim(),
        duplicateOf: r.duplicateOf.trim() || null,
        edit: action === 'edit' ? edit : null,
      };
    });
}
