import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

/** What the Chief of Staff makes of a Director message. */
export const DirectiveReading = z.object({
  kind: z.enum(['status', 'note', 'replan', 'rerun', 'answer', 'add']),
  /** One plain sentence restating what the Director asked for, in their terms. */
  interpretation: z.string(),
  /** For a re-plan: Blueprint item keys to take out of scope. */
  drop: z.array(z.string()),
  /** For a re-run: the ids of the tasks to run again. */
  rerun: z.array(z.string()),
  /** For a re-run: what the Director wants done this time, in their words. */
  notes: z.string(),
  /** For answering cards: each card's id and the option chosen for it. */
  answers: z.array(z.object({ escalationId: z.string(), optionId: z.string() })),
  /** For new work: the task to add, for one of the roles given. Empty strings when not adding. */
  task: z.object({
    title: z.string(),
    role: z.string(),
    /** A task id it follows, from the task list, or "" to start now. */
    after: z.string(),
    instructions: z.string(),
  }),
});
export type DirectiveReading = z.infer<typeof DirectiveReading>;

export interface DirectiveInput {
  text: string;
  /** The project's Blueprint items, for a re-plan to name. Empty before one exists. */
  items: { collection: string; key: string; name: string; status: string }[];
  /** The plan's tasks, for a re-run to name. */
  tasks?: { taskId: string; title: string; state: string }[];
  /** The team's roles, for new work to name its owner. */
  roles?: { role: string; name: string; mandate: string }[];
  /** The cards waiting on the Director (no gates), for answering them to name. */
  cards?: {
    escalationId: string;
    type: string;
    title: string;
    options: { id: string; label: string; recommended: boolean }[];
    defaultOptionId: string | null;
  }[];
}

const SYSTEM = `You are the Chief of Staff of a website migration to SitecoreAI. The Director (the human in charge) sent a message. Classify it:

- "status": they want to know where things stand.
- "replan": they want Blueprint items taken out of scope. Put the exact keys of the items to drop in "drop", choosing only from the item list given. Only use this when the message clearly asks to skip, drop, remove or exclude something that is in the list.
- "rerun": they want a task done again or done now: redo, retry, re-run, run again, or have an agent do a task's work again ("we need David to configure the head again"). Put the ids of the matching tasks in "rerun", choosing only from the task list given (match on the task's title and the role the message names), and put what they want done this time in "notes", in their words.
- "answer": they tell you to answer, accept, clear, decide or settle cards that wait on them: all of them, a kind ("the retry ones"), or named ones. Put each card's id and the option you choose in "answers", choosing only from the card list given and only each card's own option ids. "With your recommendation", "as you'd recommend" or "clear them": the option marked recommended, else the card's default; leave a card that has neither. A named choice ("accept the current output on all of them"): the option whose label matches, on each card that has one; leave the rest. Only when the message tells you to act: a question ("should I accept these?") is a "note".
- "add": they ask for work no task in the list covers, to be done by the team ("have someone fill the footer from the source", "add a task to upload the press kit"). Fill "task": a short imperative "title", the "role" that should do it (choosing only from the role list given, by its mandate), "after" (the id of a task it must follow, from the task list, or "" to start now) and "instructions" (what they want done, in their words). When a task in the list already covers it, that is a "rerun" instead.
- "note": anything else (an instruction, a fact, a preference, an answer to a question). It is recorded for the team.

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
  const tasks = input.tasks?.length
    ? input.tasks.map((t) => `- ${t.taskId}: ${t.title} (${t.state})`).join('\n')
    : '(no tasks)';
  const cards = input.cards?.length
    ? input.cards
        .map(
          (c) =>
            `- ${c.escalationId} (${c.type}): ${c.title}\n${c.options
              .map(
                (o) =>
                  `    - ${o.id}: ${o.label}${o.recommended ? ' [recommended]' : ''}${o.id === c.defaultOptionId ? ' [default]' : ''}`,
              )
              .join('\n')}`,
        )
        .join('\n')
    : '(no cards)';
  const roles = input.roles?.length
    ? input.roles.map((r) => `- ${r.role}: ${r.name}: ${r.mandate}`).join('\n')
    : '(no roles)';
  const response = await client.messages.parse({
    model: 'claude-sonnet-5-5',
    max_tokens: 2000,
    output_config: { effort: 'low', format: zodOutputFormat(DirectiveReading) },
    system: SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Blueprint items:\n${items}\n\nTasks:\n${tasks}\n\nRoles:\n${roles}\n\nCards waiting on the Director:\n${cards}\n\nDirector's message:\n${input.text}`,
      },
    ],
  });
  const reading = response.parsed_output;
  if (!reading) throw new Error(`Directive not understood (stop reason ${response.stop_reason})`);
  const known = new Set(input.items.map((i) => i.key));
  const drop = reading.drop.filter((k) => known.has(k));
  const knownTasks = new Set((input.tasks ?? []).map((t) => t.taskId));
  const rerun = reading.rerun.filter((id) => knownTasks.has(id));
  // Only cards that wait, and only each card's own options, survive: nothing is answered by guess.
  const byId = new Map((input.cards ?? []).map((c) => [c.escalationId, c]));
  const seen = new Set<string>();
  const answers = reading.answers.filter((a) => {
    const c = byId.get(a.escalationId);
    if (!c || seen.has(a.escalationId) || !c.options.some((o) => o.id === a.optionId)) return false;
    seen.add(a.escalationId);
    return true;
  });
  // New work only for a role the team has, after a task that exists (or none).
  const knownRoles = new Set((input.roles ?? []).map((r) => r.role));
  const task = {
    ...reading.task,
    after: knownTasks.has(reading.task.after) ? reading.task.after : '',
  };
  if (
    (reading.kind === 'add' && (!knownRoles.has(task.role) || !task.title.trim())) ||
    (reading.kind === 'replan' && !drop.length) ||
    (reading.kind === 'rerun' && !rerun.length) ||
    (reading.kind === 'answer' && !answers.length)
  ) {
    return { ...reading, kind: 'note', drop: [], rerun: [], answers: [] };
  }
  return { ...reading, drop, rerun, answers, task };
}
