import { FactDraft, type FactView } from '@lw/contracts';
import type { OperationCatalog, ToolCallContext, ToolResult, ToolServer } from '@lw/tool-gateway';
import { z } from 'zod';

const bad = (message: string): ToolResult => ({
  code: 422,
  body: { error: message },
  summary: message,
});

const ReadArgs = z.object({
  kind: z.string().optional(),
  key: z.string().optional(),
  search: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
});

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * The project's facts: what tasks made that later tasks need (a rendering's ID, a template's
 * path, a page's item, a media item, a query name). Tool results record most of them; an agent
 * publishes what its tools don't.
 */
export class FactsToolServer implements ToolServer {
  readonly name = 'facts';
  readonly catalog: OperationCatalog = {
    read: {
      description:
        "Look up what the project's tasks made: renderings, templates, pages (by route), datasources and media (by source URL) with their Sitecore IDs and paths, and anything agents published. Filter by kind, exact key, or a search over keys, values and summaries. Read here before searching the CMS or asking for an ID or path another task created.",
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string' },
          key: { type: 'string' },
          search: { type: 'string' },
          limit: { type: 'integer' },
        },
        additionalProperties: false,
      },
      mutates: false,
      // Values quote source content (names, alt text) and what agents wrote.
      untrusted: true,
    },
    publish: {
      description:
        'Record something later tasks will need that your tools did not record themselves: a GraphQL query name, an environment variable, a route, a placeholder name. kind is a short lower-case word; key is how others will look it up; value holds short scalar fields. Publishing the same kind and key again replaces the value (the previous one is kept).',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string' },
          key: { type: 'string' },
          value: {
            type: 'object',
            additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
          },
          summary: { type: 'string' },
        },
        required: ['kind', 'key', 'value'],
        additionalProperties: false,
      },
      mutates: true,
    },
  };

  constructor(
    private readonly deps: {
      facts(projectId: string): Promise<FactView[]>;
      publish(projectId: string, fact: FactDraft, ctx: ToolCallContext): Promise<void>;
    },
  ) {}

  target(projectId: string) {
    return `workspace:${projectId}`;
  }

  async call(op: string, args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
    if (op === 'read') {
      const a = ReadArgs.safeParse(args);
      if (!a.success) return bad('kind, key and search are strings; limit is a number');
      const { kind, key, search } = a.data;
      const words = search ? norm(search).split(' ') : [];
      const all = (await this.deps.facts(ctx.projectId))
        .filter((f) => !kind || f.kind === kind.trim().toLowerCase())
        .filter((f) => !key || norm(f.key) === norm(key))
        .filter((f) => {
          if (!words.length) return true;
          const hay = norm(`${f.kind} ${f.key} ${f.summary} ${JSON.stringify(f.value)}`);
          return words.every((w) => hay.includes(w));
        })
        .sort((x, y) => y.at.localeCompare(x.at));
      const limit = a.data.limit ?? 50;
      const facts = all
        .slice(0, limit)
        .map(({ kind, key, value, summary, taskId, by, at, version }) => ({
          kind,
          key,
          value,
          summary,
          taskId,
          by,
          at,
          version,
        }));
      return {
        code: 200,
        body: {
          facts,
          total: all.length,
          ...(all.length > limit ? { more: `${all.length - limit} more; narrow the search` } : {}),
        },
        summary: `Read ${facts.length} fact${facts.length === 1 ? '' : 's'}${kind ? ` (${kind})` : ''}${search ? ` matching "${search}"` : ''}`,
      };
    }
    if (op === 'publish') {
      const f = FactDraft.safeParse(args);
      if (!f.success)
        return bad(f.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      await this.deps.publish(ctx.projectId, f.data, ctx);
      return {
        code: 200,
        body: { kind: f.data.kind, key: f.data.key },
        summary: `Published ${f.data.kind} ${f.data.key}`,
      };
    }
    return bad(`Unknown operation ${op}`);
  }
}

/** One acceptance check's standing, as the agent's self-check reports it. */
export interface SelfCheckRow {
  id: string;
  status: 'pass' | 'fail' | 'pending';
  detail: string;
}

/**
 * The task's own acceptance checks, for the agent to run before it submits: the same checks the
 * Lead's review runs, with nothing recorded against the task.
 */
export class AcceptanceToolServer implements ToolServer {
  readonly name = 'acceptance';
  readonly timeoutMs = 15 * 60_000;
  readonly catalog: OperationCatalog = {
    check: {
      description:
        "Run this task's automated acceptance checks now, the same ones your Lead's review runs after you submit, and see each one's result. Run it before submitting done; fix what fails that is yours, and say in your summary what fails because of another task's work. Nothing is recorded against the task.",
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      mutates: false,
    },
  };

  constructor(
    private readonly check: (projectId: string, taskId: string) => Promise<SelfCheckRow[] | null>,
  ) {}

  target(projectId: string) {
    return `workspace:${projectId}`;
  }

  async call(
    op: string,
    _args: Record<string, unknown>,
    ctx: ToolCallContext,
  ): Promise<ToolResult> {
    if (op !== 'check') return bad(`Unknown operation ${op}`);
    const rows = await this.check(ctx.projectId, ctx.taskId);
    if (!rows) return { code: 404, body: { error: 'This task is not running here.' } };
    if (!rows.length)
      return {
        code: 200,
        body: { checks: [], passed: true, note: 'This task has no automated checks.' },
        summary: 'No automated checks for this task',
      };
    const failed = rows.filter((r) => r.status === 'fail');
    const pending = rows.filter((r) => r.status === 'pending');
    return {
      code: 200,
      body: { checks: rows, passed: !failed.length },
      summary: failed.length
        ? `${failed.length} of ${rows.length} checks fail: ${failed.map((r) => r.id).join(', ')}`
        : `${rows.length - pending.length} of ${rows.length} checks pass${pending.length ? `, ${pending.length} pending` : ''}`,
    };
  }
}
