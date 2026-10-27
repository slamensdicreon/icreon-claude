import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { ToolGateway } from '@lw/tool-gateway';
import { z } from 'zod';

export const SUBMIT = 'submit_result';

/** How the agent ends its task: done, or blocked on a decision only the Director can make. */
export const SubmitInput = z.object({
  status: z.enum(['done', 'needs_decision']),
  summary: z.string().min(1),
  decision: z
    .object({
      question: z.string(),
      options: z.array(z.string()).min(2).max(4),
      recommended: z.string(),
    })
    .optional(),
  metrics: z.record(z.string(), z.number()).optional(),
});
export type SubmitInput = z.infer<typeof SubmitInput>;

const submitTool: BetaTool = {
  name: SUBMIT,
  description:
    'Call exactly once, when the task is finished (status "done") or cannot continue without a decision ' +
    'from the Director (status "needs_decision", with the question, two to four options and the option ' +
    'you recommend). The summary is one or two plain sentences on what changed.',
  input_schema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['done', 'needs_decision'] },
      summary: { type: 'string' },
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
