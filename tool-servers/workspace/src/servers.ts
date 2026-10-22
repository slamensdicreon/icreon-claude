import type { DecisionView } from '@lw/contracts';
import { Blueprint } from '@lw/plan';
import type { OperationCatalog, ToolCallContext, ToolResult, ToolServer } from '@lw/tool-gateway';
import { z } from 'zod';
import type { ArtifactLibrary } from './library';

const Kind = z.enum(['blueprint', 'platform_notes', 'inventory', 'report', 'handover_pack']);

const WriteArgs = z.object({
  artifactId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'kebab-case id'),
  kind: Kind.exclude(['blueprint']),
  title: z.string().min(1).max(120),
  format: z.enum(['markdown', 'json']),
  content: z.string().min(1).max(2_000_000),
});

const ReadArgs = z.object({
  artifactId: z.string(),
  version: z.number().int().positive().optional(),
});

const bad = (message: string): ToolResult => ({
  code: 422,
  body: { error: message },
  summary: message,
});

/** Agents' working documents: inventories, Platform Notes, reports, the handover pack. */
export class ArtifactsToolServer implements ToolServer {
  readonly name = 'artifacts';
  readonly catalog: OperationCatalog = {
    write: {
      description:
        'Save a new version of a project document (inventory, platform notes, report, handover pack). Use a stable kebab-case artifactId; each write creates the next version.',
      inputSchema: {
        type: 'object',
        properties: {
          artifactId: { type: 'string' },
          kind: {
            type: 'string',
            enum: ['platform_notes', 'inventory', 'report', 'handover_pack'],
          },
          title: { type: 'string' },
          format: { type: 'string', enum: ['markdown', 'json'] },
          content: { type: 'string' },
        },
        required: ['artifactId', 'kind', 'title', 'format', 'content'],
        additionalProperties: false,
      },
      mutates: true,
    },
    read: {
      description: 'Read a project document, latest version unless a version is given.',
      inputSchema: {
        type: 'object',
        properties: { artifactId: { type: 'string' }, version: { type: 'integer' } },
        required: ['artifactId'],
        additionalProperties: false,
      },
      mutates: false,
      // Documents are built from source-site and repository content: still data, not orders.
      untrusted: true,
    },
  };

  constructor(private readonly library: ArtifactLibrary) {}

  target(projectId: string) {
    return `workspace:${projectId}`;
  }

  async call(op: string, args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
    if (op === 'write') {
      const a = WriteArgs.safeParse(args);
      if (!a.success)
        return bad(a.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      if (a.data.format === 'json') {
        try {
          JSON.parse(a.data.content);
        } catch {
          return bad('content is not valid JSON');
        }
      }
      const v = await this.library.write(ctx.projectId, { ...a.data, producer: ctx.role });
      return {
        code: 200,
        body: { artifactId: v.artifactId, version: v.version },
        summary: `${v.title} v${v.version}`,
      };
    }
    if (op === 'read') {
      const a = ReadArgs.safeParse(args);
      if (!a.success) return bad('artifactId is required');
      const r = await this.library.read(ctx.projectId, a.data.artifactId, a.data.version);
      if (!r) return { code: 404, body: { error: `No stored content for ${a.data.artifactId}` } };
      return {
        code: 200,
        body: { ...r.meta, content: r.content },
        summary: `Read ${r.meta.title} v${r.meta.version}`,
      };
    }
    return bad(`Unknown operation ${op}`);
  }
}

/**
 * The shared plan of record. The Blueprint is a versioned artifact; writes are validated against
 * the plan compiler's schema, so whatever is written can be compiled into tasks.
 */
export class BlackboardToolServer implements ToolServer {
  readonly name = 'blackboard';
  readonly catalog: OperationCatalog = {
    read: {
      description:
        'Read the current Implementation Blueprint (component, template, page and media collections) and its version.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      mutates: false,
      untrusted: true,
    },
    'write.blueprint': {
      description:
        'Save a new Blueprint version: { version, collections: { components, templates, pages, media } }, each item { key (stable kebab-case), name, status: keep|merge|split|drop, pilot?, attrs? }.',
      inputSchema: {
        type: 'object',
        properties: { blueprint: { type: 'object' } },
        required: ['blueprint'],
        additionalProperties: false,
      },
      mutates: true,
    },
  };

  constructor(private readonly library: ArtifactLibrary) {}

  target(projectId: string) {
    return `workspace:${projectId}`;
  }

  async call(op: string, args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
    if (op === 'read') {
      const r = await this.library.read(ctx.projectId, 'blueprint');
      if (!r) return { code: 404, body: { error: 'No Blueprint has been written yet.' } };
      return {
        code: 200,
        body: { version: r.meta.version, blueprint: JSON.parse(r.content) },
        summary: `Read Blueprint v${r.meta.version}`,
      };
    }
    if (op === 'write.blueprint') {
      const parsed = Blueprint.safeParse(args.blueprint);
      if (!parsed.success) {
        return bad(
          `Blueprint is invalid: ${parsed.error.issues
            .slice(0, 5)
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ')}`,
        );
      }
      const v = await this.library.write(ctx.projectId, {
        artifactId: 'blueprint',
        kind: 'blueprint',
        title: 'Implementation Blueprint',
        format: 'json',
        content: JSON.stringify(parsed.data, null, 2),
        producer: ctx.role,
      });
      return { code: 200, body: { version: v.version }, summary: `Blueprint v${v.version}` };
    }
    return bad(`Unknown operation ${op}`);
  }
}

/** The project's Decision Log, for writing the handover pack's decision register. */
export class DecisionLogToolServer implements ToolServer {
  readonly name = 'decision-log';
  readonly catalog: OperationCatalog = {
    read: {
      description:
        'Every decision recorded on this project, oldest first: the question, the answer, why, and who decided (Director, Chief of Staff, or the default at deadline).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      mutates: false,
      // Questions and rationales quote agents' text, which quotes source content.
      untrusted: true,
    },
  };

  constructor(private readonly decisions: (projectId: string) => DecisionView[]) {}

  target(projectId: string) {
    return `workspace:${projectId}`;
  }

  async call(
    op: string,
    _args: Record<string, unknown>,
    ctx: ToolCallContext,
  ): Promise<ToolResult> {
    if (op !== 'read') return bad(`Unknown operation ${op}`);
    const decisions = this.decisions(ctx.projectId).map(
      ({ ts, question, answer, rationale, decidedBy }) => ({
        ts,
        question,
        answer,
        rationale,
        decidedBy,
      }),
    );
    return {
      code: 200,
      body: { decisions },
      summary: `Read ${decisions.length} decision${decisions.length === 1 ? '' : 's'}`,
    };
  }
}
