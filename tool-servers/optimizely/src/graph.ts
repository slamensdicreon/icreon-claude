import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { OperationCatalog, ToolCallContext, ToolResult, ToolServer } from '@lw/tool-gateway';
import { rejected } from '@lw/tool-gateway';
import { z } from 'zod';

/**
 * Optimizely Graph, read only: what the head and every visitor are served. The single key reads
 * published content; with the project's app key and secret a request is signed and reads drafts
 * too. Both stay in the server: an agent sees content, never a key.
 *
 * One Graph index holds every application on the instance, so the operations that list routes
 * narrow to this project's hosts.
 */

export interface GraphFacts {
  /** The application's hosts, as given to hostname.add: routes are narrowed to these. */
  hosts: string[];
  languages: string[];
}

export interface OptimizelyGraphServerOptions {
  facts(projectId: string): Promise<GraphFacts | null>;
  /** The project's Graph app key and secret, for signed (draft) reads; null when not given. */
  hmac?(projectId: string): Promise<{ appKey: string; secret: string } | null>;
  fetch?: typeof fetch;
  /** Graph's query endpoint. */
  graphUrl?: string;
}

const GRAPH_URL = 'https://cg.optimizely.com/content/v2';
const MAX_QUERY = 20_000;

const QueryArgs = z.object({
  query: z.string().min(1).max(MAX_QUERY),
  variables: z.record(z.string(), z.unknown()).optional(),
  /** Read drafts too, with a signed request. */
  drafts: z.boolean().optional(),
});
const RoutesArgs = z.object({
  locale: z.string().max(20).optional(),
  /** Every application's routes, not only this project's hosts. */
  all: z.boolean().optional(),
});
const ItemArgs = z
  .object({
    key: z
      .string()
      .regex(/^[0-9a-f]{32}$/i, 'a content key (32 hex digits)')
      .optional(),
    /** A route, e.g. /en/ or /en/about/ */
    path: z.string().startsWith('/').max(500).optional(),
    locale: z.string().max(20).optional(),
    drafts: z.boolean().optional(),
  })
  .refine((a) => Boolean(a.key) !== Boolean(a.path), 'give either key or path');

const METADATA =
  '_metadata { key displayName locale version status types published lastModified url { base default hierarchical type } }';

interface Metadata {
  key?: string;
  displayName?: string;
  locale?: string;
  version?: string;
  status?: string;
  types?: string[];
  published?: string;
  lastModified?: string;
  url?: {
    base?: string | null;
    default?: string | null;
    hierarchical?: string | null;
    type?: string | null;
  };
}

export class OptimizelyGraphToolServer implements ToolServer {
  readonly name = 'optimizely-graph';
  readonly catalog: OperationCatalog = {
    'graph.query': {
      description:
        "Run a read-only GraphQL query on Optimizely Graph, as the head does. Published content by default; drafts: true signs the request and reads drafts too (needs the project's Graph app key and secret). The index holds every application on the instance: narrow by _metadata.url.base or by this project's content types.",
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          variables: { type: 'object' },
          drafts: { type: 'boolean' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      mutates: false,
    },
    'graph.routes': {
      description:
        "List the published pages of this project's application as Graph serves them: route, name, content type, key and when each was published. Routes start with the locale (the start page is /en/). Empty until a host is registered and pages are published.",
      inputSchema: {
        type: 'object',
        properties: { locale: { type: 'string' }, all: { type: 'boolean' } },
        additionalProperties: false,
      },
      mutates: false,
    },
    'graph.item': {
      description:
        'Read one item from Graph by key or by route: whether it is indexed, its status, version and URL. drafts: true reads the latest draft with a signed request.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          path: { type: 'string' },
          locale: { type: 'string' },
          drafts: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      mutates: false,
    },
  };

  private readonly fetch: typeof fetch;
  private readonly url: string;

  constructor(private readonly opts: OptimizelyGraphServerOptions) {
    this.fetch = opts.fetch ?? ((...a) => fetch(...a));
    this.url = opts.graphUrl ?? GRAPH_URL;
  }

  target(projectId: string) {
    return `optimizely-graph:${projectId}`;
  }

  async call(op: string, args: Record<string, unknown>, ctx: ToolCallContext): Promise<ToolResult> {
    const facts = await this.opts.facts(ctx.projectId);
    if (!facts) return { code: 409, body: { error: 'This project has no Optimizely target.' } };
    switch (op) {
      case 'graph.query': {
        const a = QueryArgs.safeParse(args);
        if (!a.success) return rejected(a.error.issues[0]!.message);
        if (/^\s*(mutation|subscription)\b/i.test(a.data.query.replace(/#.*$/gm, '')))
          return rejected('Optimizely Graph is read only here: send a query.');
        const r = await this.run(ctx, a.data.query, a.data.variables ?? {}, a.data.drafts === true);
        if ('code' in r) return r;
        return {
          code: 200,
          body: { data: r.data },
          summary: `Graph query answered${a.data.drafts ? ' (drafts included)' : ''}`,
        };
      }
      case 'graph.routes': {
        const a = RoutesArgs.safeParse(args);
        if (!a.success) return rejected(a.error.issues[0]!.message);
        return await this.routes(ctx, facts, a.data);
      }
      case 'graph.item': {
        const a = ItemArgs.safeParse(args);
        if (!a.success) return rejected(a.error.issues[0]!.message);
        return await this.item(ctx, facts, a.data);
      }
      default:
        return { code: 404, body: { error: `Unknown operation ${op}` } };
    }
  }

  private async routes(
    ctx: ToolCallContext,
    facts: GraphFacts,
    a: z.infer<typeof RoutesArgs>,
  ): Promise<ToolResult> {
    const bases = facts.hosts.map(baseOf);
    if (!a.all && !bases.length)
      return {
        code: 200,
        body: { routes: [], hosts: [] },
        summary:
          "The application has no host yet, so Graph can't tell its routes from other applications': register the head's host (hostname.add) first",
      };
    const items: Metadata[] = [];
    for (let skip = 0; skip < 2000; skip += 100) {
      const r = await this.run(
        ctx,
        `query Routes($skip: Int) { _Page(limit: 100, skip: $skip) { total items { ${METADATA} } } }`,
        { skip },
        false,
      );
      if ('code' in r) return r;
      const page =
        (r.data as { _Page?: { items?: { _metadata?: Metadata }[] } })._Page?.items ?? [];
      items.push(...page.map((i) => i._metadata ?? {}));
      if (page.length < 100) break;
    }
    const mine = items
      .filter((m) => a.all || bases.includes((m.url?.base ?? '').toLowerCase()))
      .filter((m) => !a.locale || m.locale === a.locale)
      .map(view)
      .sort((x, y) => String(x.route).localeCompare(String(y.route)));
    return {
      code: 200,
      body: { routes: mine, hosts: facts.hosts },
      summary: `${mine.length} published page${mine.length === 1 ? '' : 's'} in Graph${a.all ? ' across every application' : ` on ${facts.hosts.join(', ')}`}`,
    };
  }

  private async item(
    ctx: ToolCallContext,
    facts: GraphFacts,
    a: z.infer<typeof ItemArgs>,
  ): Promise<ToolResult> {
    const drafts = a.drafts === true;
    const where = a.key
      ? `{ _metadata: { key: { eq: ${JSON.stringify(a.key.toLowerCase())} } } }`
      : `{ _metadata: { url: { default: { eq: ${JSON.stringify(withSlash(a.path!))} } } } }`;
    const locale = a.locale ? `, locale: [${a.locale.replace(/-/g, '_')}]` : '';
    const r = await this.run(
      ctx,
      `query Item { _Content(where: ${where}${locale}, limit: 20) { items { ${METADATA} } } }`,
      {},
      drafts,
    );
    if ('code' in r) return r;
    const found = (
      (r.data as { _Content?: { items?: { _metadata?: Metadata }[] } })._Content?.items ?? []
    ).map((i) => i._metadata ?? {});
    // A route can exist on several applications: this project's hosts first.
    const bases = facts.hosts.map(baseOf);
    const own = found.filter((m) => !m.url?.base || bases.includes(m.url.base.toLowerCase()));
    const pool = a.path && own.length ? own : found;
    if (!pool.length)
      return {
        code: 404,
        body: { indexed: false },
        summary: `${a.key ?? a.path} is not in Graph${drafts ? '' : ' (published content only: it may be a draft)'}`,
      };
    const best = pool.reduce((x, y) => (Number(y.version ?? 0) > Number(x.version ?? 0) ? y : x));
    return {
      code: 200,
      body: { indexed: true, ...view(best), versions: pool.length },
      summary: `${best.displayName ?? best.key} is in Graph: ${best.status ?? 'unknown status'}${best.url?.default ? ` at ${best.url.default}` : ''}`,
    };
  }

  /** One query. Published content with the single key; drafts with a signed request. */
  private async run(
    ctx: ToolCallContext,
    query: string,
    variables: Record<string, unknown>,
    drafts: boolean,
  ): Promise<{ data: unknown } | ToolResult> {
    const body = JSON.stringify({ query, variables });
    let authorization = `epi-single ${ctx.token}`;
    if (drafts) {
      const hmac = await this.opts.hmac?.(ctx.projectId);
      if (!hmac)
        return rejected(
          "Reading drafts needs the project's Graph app key and secret, which were not given. Add them in Settings, or read published content.",
          409,
        );
      authorization = signature(hmac.appKey, hmac.secret, 'POST', this.url, body);
    }
    const res = await this.fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let parsed: { data?: unknown; errors?: { message?: string }[] } = {};
    try {
      parsed = text ? (JSON.parse(text) as typeof parsed) : {};
    } catch {
      /* not JSON: reported by status below */
    }
    if (res.status === 401 || res.status === 403)
      return {
        code: res.status,
        body: {
          error: drafts
            ? 'Optimizely Graph refused the signed request: the app key or secret is wrong. Copy both again from Settings > API Keys.'
            : 'Optimizely Graph refused the single key. Copy it again from Settings > API Keys.',
        },
      };
    if (parsed.errors?.length) {
      const message = parsed.errors.map((e) => e.message).join('; ');
      return {
        code: 422,
        body: { error: `Graph rejected the query: ${message}` },
        summary: `Graph rejected the query: ${message.slice(0, 200)}`,
      };
    }
    if (res.status !== 200 || parsed.data === undefined)
      return {
        code: res.status === 200 ? 502 : res.status,
        body: { error: `Optimizely Graph answered ${res.status}.` },
      };
    return { data: parsed.data };
  }
}

const baseOf = (host: string) =>
  `https://${host.replace(/^https?:\/\//, '').replace(/\/.*$/, '')}`.toLowerCase();
const withSlash = (path: string) => (path.endsWith('/') ? path : `${path}/`);

const view = (m: Metadata) => ({
  route: m.url?.default ?? null,
  host: m.url?.base ?? null,
  name: m.displayName ?? null,
  contentType: m.types?.[0] ?? null,
  key: m.key ?? null,
  locale: m.locale ?? null,
  status: m.status ?? null,
  version: m.version ?? null,
  published: m.published ?? null,
});

/**
 * Optimizely Graph's HMAC authorization: the app key, method, path, a timestamp, a nonce and the
 * body's MD5, signed with the secret (itself base64).
 */
export function signature(
  appKey: string,
  secret: string,
  method: string,
  url: string,
  body: string,
  now: () => number = Date.now,
  nonce: () => string = randomUUID,
): string {
  const { pathname, search } = new URL(url);
  const timestamp = String(now());
  const n = nonce();
  const bodyHash = createHash('md5').update(body).digest('base64');
  const message = [appKey, method, pathname + search, timestamp, n, bodyHash].join('');
  const signed = createHmac('sha256', Buffer.from(secret, 'base64'))
    .update(message)
    .digest('base64');
  return `epi-hmac ${appKey}:${timestamp}:${n}:${signed}`;
}
