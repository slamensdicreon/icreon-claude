import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { ToolGateway } from '@lw/tool-gateway';
import { z } from 'zod';

export const SUBMIT = 'submit_result';

/**
 * How the agent ends its task: done; waiting on other tasks in the plan to produce what it needs;
 * blocked on a decision only the Director can make; or unable because its tools can't do it.
 */
export const SubmitInput = z.object({
  status: z.enum(['done', 'waiting', 'needs_decision', 'capability_gap']),
  summary: z.string().min(1),
  decision: z
    .object({
      question: z.string(),
      options: z.array(z.string()).min(2).max(4),
      recommended: z.string(),
    })
    .optional(),
  waitingOn: z
    .object({
      taskIds: z.array(z.string()).max(10).default([]),
      sendBack: z
        .array(z.object({ taskId: z.string(), fixes: z.string().min(1) }))
        .max(10)
        .default([]),
      what: z.string().min(1),
    })
    .refine((w) => w.taskIds.length + w.sendBack.length > 0, 'name a task to wait on or send back')
    .optional(),
  /** What the agent's tools can't do, for engineering's backlog. */
  gap: z.object({ capability: z.string().min(1).max(200) }).optional(),
  metrics: z.record(z.string(), z.number()).optional(),
});
export type SubmitInput = z.infer<typeof SubmitInput>;

const submitTool: BetaTool = {
  name: SUBMIT,
  description:
    'Call exactly once, when the task is finished (status "done"); when what it needs is still to be ' +
    'produced by other tasks in the team plan, or a finished task must fix its work (status "waiting": ' +
    'name the unfinished tasks in taskIds, and send finished ones back with sendBack and the exact fixes; ' +
    'you are restarted automatically when they finish); or when it cannot continue without a decision ' +
    'from the Director (status "needs_decision", with the question, two to four options and the option ' +
    'you recommend); or when none of your tools can do a step the task needs (status "capability_gap", ' +
    'naming the missing capability in gap.capability; the task waits until engineering adds it). The ' +
    'summary is one or two plain sentences on what changed.',
  input_schema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['done', 'waiting', 'needs_decision', 'capability_gap'] },
      summary: { type: 'string' },
      waitingOn: {
        type: 'object',
        properties: {
          taskIds: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 10,
            description: 'Ids of the unfinished tasks in the team plan that produce what you need.',
          },
          sendBack: {
            type: 'array',
            maxItems: 10,
            description:
              'Finished tasks whose work must change: each is re-run by its owner with your fixes, and you wait for it.',
            items: {
              type: 'object',
              properties: {
                taskId: { type: 'string' },
                fixes: {
                  type: 'string',
                  description:
                    'Exactly what to fix, with paths and IDs, so the owner can act on it.',
                },
              },
              required: ['taskId', 'fixes'],
            },
          },
          what: { type: 'string', description: 'What you need from them, in a few words.' },
        },
        required: ['what'],
      },
      decision: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description:
              'The decision as the Director will see it in a list: one short question, under 80 characters, no paths or IDs (put those in the summary).',
          },
          options: {
            type: 'array',
            items: { type: 'string' },
            minItems: 2,
            maxItems: 4,
            description: 'Each option a short action, under 100 characters.',
          },
          recommended: { type: 'string' },
        },
        required: ['question', 'options', 'recommended'],
      },
      gap: {
        type: 'object',
        properties: {
          capability: {
            type: 'string',
            description:
              'The operation your tools lack, as engineering would build it, in a few words ("create personalization variants in Page builder"). The same wording for the same gap.',
          },
        },
        required: ['capability'],
      },
      metrics: { type: 'object', additionalProperties: { type: 'number' } },
    },
    required: ['status', 'summary'],
  },
};

export interface ToolSet {
  tools: BetaTool[];
  /** Tool name → gateway operation. */
  route: Map<string, { server: string; op: string }>;
}

/** Tool names must match ^[a-zA-Z0-9_-]{1,64}$. */
export function toolName(server: string, op: string): string {
  return `${server}__${op}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

/**
 * The tools an agent sees: exactly the operations its role is granted (the gateway still checks
 * every call), plus submit_result. Sorted by name so the tool block, and the cache prefix it
 * starts, is byte-identical across tasks of the same role.
 */
export function toolsFor(role: string, gateway: ToolGateway): ToolSet {
  const route = new Map<string, { server: string; op: string }>();
  const tools: BetaTool[] = [];
  for (const { server, op } of gateway.allowedOperations(role)) {
    const name = toolName(server, op);
    const spec = gateway.operation(server, op)!;
    route.set(name, { server, op });
    tools.push({
      name,
      description: [
        spec.releases
          ? 'Release-affecting: call it only when your task is to release, and state in your result what was released and how to roll it back.'
          : '',
        spec.description ?? `${op} on ${server}.`,
      ]
        .filter(Boolean)
        .join(' '),
      input_schema: (spec.inputSchema as BetaTool['input_schema']) ?? {
        type: 'object',
        additionalProperties: true,
      },
    });
  }
  tools.sort((a, b) => a.name.localeCompare(b.name));
  tools.push(submitTool);
  return { tools, route };
}
