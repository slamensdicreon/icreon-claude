import { ArtifactPointer, type DecisionView } from '@lw/contracts';
import { Blueprint } from '@lw/plan';
import type { OperationCatalog, ToolCallContext, ToolResult, ToolServer } from '@lw/tool-gateway';
import { z } from 'zod';
import type { ArtifactLibrary } from './library';
import { rejected } from '@lw/tool-gateway';
import { readabilityOf } from '@lw/domain';

const Kind = z.enum(['blueprint', 'platform_notes', 'inventory', 'report', 'handover_pack']);

const WriteArgs = z.object({
  artifactId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'kebab-case id'),
  kind: Kind.exclude(['blueprint']),
  title: z.string().min(1).max(120),
  format: z.enum(['markdown', 'json']),
  content: z.string().min(1).max(2_000_000),
  /**
   * The document in plain words for the Director, and up to three pointers into it. Both are
   * extras: a bad one is dropped (and a long summary trimmed), never a reason to refuse the save.
   */
  summary: z.unknown().optional(),
  attention: z.unknown().optional(),
  /** A short plain title and who it is for: extras too, dropped when malformed. */
  headline: z.unknown().optional(),
  audience: z.unknown().optional(),
});

const Headline = z.string().trim().min(1);
const headlineOf = (v: unknown) => {
  const h = Headline.safeParse(v);
  return h.success ? h.data.slice(0, 80) : undefined;
};
const audienceOf = (v: unknown) => (v === 'director' || v === 'team' ? v : undefined);

const Summary = z.string().trim().min(1);
const Pointers = z.array(ArtifactPointer);
const summaryOf = (v: unknown) => {
  const s = Summary.safeParse(v);
  return s.success ? s.data.slice(0, 1_200) : undefined;
};
const pointersOf = (v: unknown) => {
  const p = Pointers.safeParse(v);
  return p.success ? p.data.slice(0, 3) : undefined;
};

/** A JSON document may carry its own summary and pointers (lw.document/1); they lift onto the save. */
const DocVoice = z.object({
  summary: z.unknown().optional(),
  attention: z.unknown().optional(),
  headline: z.unknown().optional(),
  audience: z.unknown().optional(),
});

const ReadArgs = z.object({
  artifactId: z.string(),
  version: z.number().int().positive().optional(),
});

/** Agents' working documents: inventories, Platform Notes, reports, the handover pack. */
export class ArtifactsToolServer implements ToolServer {
  readonly name = 'artifacts';
  readonly catalog: OperationCatalog = {
    write: {
      description:
        'Save a new version of a project document (inventory, platform notes, report, handover pack). Use a stable kebab-case artifactId; each write creates the next version. ' +
        'Markdown documents are read by the Director and the client in the Workbench, who are not technical, so write them to be read: open with two or three plain sentences for them (what this settles, what it means for the site, the editors or the schedule, and anything they need to do), with no file paths, package names, code, rule ids or version strings in that opening; then the detail for the team under ## headings. Give every number its meaning (what it measures and whether it is good, when you know). Use ## headings; tables for anything listed with attributes; callouts for what needs attention (> [!NOTE], > [!TIP], > [!WARNING], > [!IMPORTANT]); ```mermaid diagrams for structures and flows (site maps, component trees, data flow), with every node label in double quotes (`home["/"] --> about["/about"]`; an unquoted label starting with / is a syntax error); embed screenshots and images with ![caption](blob://...) using the refs tools return; link sources and files. ' +
        'JSON documents hold data for other agents; they are shown as tables.',
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
          summary: {
            type: 'string',
            description:
              'Two or three plain sentences for the Director: what this document settles and what, if anything, needs their eye. No jargon, no process narration.',
          },
          headline: {
            type: 'string',
            description:
              'A short title in plain words for a non-technical reader, at most eight words, saying what the document is about ("How the site gets rebuilt", "What content moves, and where"). Not the file name.',
          },
          audience: {
            type: 'string',
            enum: ['director', 'team'],
            description:
              'Who it is written for: "director" for plans, results, briefings and audits a person reads; "team" for working files other agents build from (lists, checks, data).',
          },
          attention: {
            type: 'array',
            maxItems: 3,
            description:
              'Up to three things in it worth the Director’s look, each { label, target: { kind, ref } } with kind one of artifact, agent, task, activity, preview, settings, surface, decision.',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                target: {
                  type: 'object',
                  properties: { kind: { type: 'string' }, ref: { type: 'string' } },
                  required: ['kind', 'ref'],
                },
              },
              required: ['label', 'target'],
            },
          },
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
        return rejected(a.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      let lifted: z.infer<typeof DocVoice> = {};
      if (a.data.format === 'json') {
        let parsed: unknown;
        try {
          parsed = JSON.parse(a.data.content);
        } catch {
          return rejected('content is not valid JSON');
        }
        const voice = DocVoice.safeParse(parsed);
        if (voice.success) lifted = voice.data;
      }
      const v = await this.library.write(ctx.projectId, {
        ...a.data,
        summary: summaryOf(a.data.summary) ?? summaryOf(lifted.summary) ?? null,
        attention: pointersOf(a.data.attention) ?? pointersOf(lifted.attention) ?? [],
        headline: headlineOf(a.data.headline) ?? headlineOf(lifted.headline) ?? null,
        audience: audienceOf(a.data.audience) ?? audienceOf(lifted.audience) ?? null,
        producer: ctx.role,
      });
      // The opening is for the Director: say so when it isn't plain, so the author can fix it.
      const read = readabilityOf(a.data.content, a.data.format);
      return {
        code: 200,
        body: {
          artifactId: v.artifactId,
          version: v.version,
          ...(read.ok
            ? {}
            : {
                readability: {
                  ok: false,
                  notes: read.notes,
                  next: 'Saved. Write a new version whose opening a non-technical Director can read.',
                },
              }),
        },
        summary: read.ok
          ? `${v.title} v${v.version}`
          : `${v.title} v${v.version}, saved; the opening needs plain words`,
      };
    }
    if (op === 'read') {
      const a = ReadArgs.safeParse(args);
      if (!a.success) return rejected('artifactId is required');
      const r = await this.library.read(ctx.projectId, a.data.artifactId, a.data.version);
      if (!r) return { code: 404, body: { error: `No stored content for ${a.data.artifactId}` } };
      return {
        code: 200,
        body: { ...r.meta, content: r.content },
        summary: `Read ${r.meta.title} v${r.meta.version}`,
      };
    }
    return rejected(`Unknown operation ${op}`);
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
        return rejected(
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
    return rejected(`Unknown operation ${op}`);
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
    if (op !== 'read') return rejected(`Unknown operation ${op}`);
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
