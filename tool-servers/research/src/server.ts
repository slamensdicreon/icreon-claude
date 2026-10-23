import Anthropic from '@anthropic-ai/sdk';
import type { OperationCatalog, ToolCallContext, ToolResult, ToolServer } from '@lw/tool-gateway';
import { z } from 'zod';

export interface ResearchServerOptions {
  client?: Anthropic;
  /** The model that runs Anthropic's server-side web search and fetch. */
  model?: string;
}

const SearchArgs = z.object({
  query: z.string().min(3).max(400),
  /** Limit to these sites, e.g. ["doc.sitecore.com", "developers.sitecore.com"]. */
  domains: z.array(z.string().min(3)).max(20).optional(),
});
const FetchArgs = z.object({ url: z.url({ protocol: /^https?$/ }) });

const MAX_FETCH_CHARS = 60_000;
const bad = (message: string): ToolResult => ({
  code: 422,
  body: { error: message },
  summary: message,
});

/**
 * Current facts from the web, for Platform Notes: Anthropic's server-side web search and web fetch
 * tools, run by Claude on Anthropic's infrastructure (nothing is fetched from inside the worker).
 * Search returns a cited summary plus the result list; fetch returns the page's text.
 */
export class ResearchToolServer implements ToolServer {
  readonly name = 'research';
  readonly catalog: OperationCatalog = {
    'web.search': {
      description:
        'Search the web and get a short cited summary with the result list (title, URL, age). Prefer official sources: pass domains such as ["doc.sitecore.com", "developers.sitecore.com"] for platform facts.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          domains: { type: 'array', items: { type: 'string' } },
        },
        required: ['query'],
        additionalProperties: false,
      },
      mutates: false,
      untrusted: true,
    },
    'web.fetch': {
      description: 'Fetch one web page (or PDF) and get its text, to quote and cite it.',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
        additionalProperties: false,
      },
      mutates: false,
      untrusted: true,
    },
  };

  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: ResearchServerOptions = {}) {
    this.client = opts.client ?? new Anthropic();
    this.model = opts.model ?? 'claude-sonnet-5-5';
  }

  target() {
    return 'anthropic:web';
  }

  async call(
    op: string,
    args: Record<string, unknown>,
    _ctx: ToolCallContext,
  ): Promise<ToolResult> {
    if (op === 'web.search') return this.search(SearchArgs.safeParse(args));
    if (op === 'web.fetch') return this.fetchPage(FetchArgs.safeParse(args));
    return { code: 404, body: { error: `Unknown operation ${op}` } };
  }

  private async search(a: z.ZodSafeParseResult<z.infer<typeof SearchArgs>>): Promise<ToolResult> {
    if (!a.success) return bad(a.error.issues[0]!.message);
    const message = await this.run(
      [
        {
          type: 'web_search_20260209',
          name: 'web_search',
          max_uses: 4,
          ...(a.data.domains?.length ? { allowed_domains: a.data.domains } : {}),
        },
      ],
      `Search the web for: ${a.data.query}\n\nThen answer in at most 200 words with the facts found, citing sources. Say plainly when sources disagree or are older than a year.`,
    );
    const results: { title: string; url: string; age: string | null }[] = [];
    let error: string | null = null;
    let summary = '';
    const cited = new Map<string, string>();
    for (const block of message.content) {
      if (block.type === 'web_search_tool_result') {
        if (Array.isArray(block.content)) {
          for (const r of block.content)
            results.push({ title: r.title, url: r.url, age: r.page_age });
        } else {
          error = block.content.error_code;
        }
      } else if (block.type === 'text') {
        summary += block.text;
        for (const c of block.citations ?? []) {
          if (c.type === 'web_search_result_location') cited.set(c.url, c.title ?? c.url);
        }
      }
    }
    if (!results.length && error) {
      return { code: 502, body: { error: `Web search failed: ${error}` } };
    }
    return {
      code: 200,
      body: {
        query: a.data.query,
        summary: summary.trim(),
        citations: [...cited].map(([url, title]) => ({ title, url })),
        results,
      },
      summary: `Searched "${a.data.query}": ${results.length} results`,
    };
  }

  private async fetchPage(a: z.ZodSafeParseResult<z.infer<typeof FetchArgs>>): Promise<ToolResult> {
    if (!a.success) return bad(a.error.issues[0]!.message);
    const message = await this.run(
      [{ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 1 }],
      `Fetch ${a.data.url} with the web_fetch tool. Do not summarise it; just confirm it was fetched.`,
    );
    for (const block of message.content) {
      if (block.type !== 'web_fetch_tool_result') continue;
      const c = block.content;
      if (c.type !== 'web_fetch_result') {
        return { code: 502, body: { error: `Could not fetch ${a.data.url}: ${c.error_code}` } };
      }
      const source = c.content.source;
      const text = source.type === 'text' ? source.data : '(PDF fetched; text not extracted)';
      return {
        code: 200,
        body: {
          url: c.url,
          title: c.content.title,
          retrievedAt: c.retrieved_at,
          truncated: text.length > MAX_FETCH_CHARS,
          text: text.slice(0, MAX_FETCH_CHARS),
        },
        summary: `Fetched ${new URL(c.url).host}${new URL(c.url).pathname} (${Math.round(text.length / 1000)}k characters)`,
      };
    }
    return { code: 502, body: { error: `Could not fetch ${a.data.url}: no result came back.` } };
  }

  /** One request, resumed while the server-side tool loop pauses (pause_turn). */
  private async run(tools: Anthropic.ToolUnion[], prompt: string): Promise<Anthropic.Message> {
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: prompt }];
    let message = await this.client.messages.create({
      model: this.model,
      max_tokens: 4000,
      output_config: { effort: 'low' },
      tools,
      messages,
    });
    const content = [...message.content];
    for (let i = 0; i < 3 && message.stop_reason === 'pause_turn'; i++) {
      messages.push({ role: 'assistant', content: message.content });
      message = await this.client.messages.create({
        model: this.model,
        max_tokens: 4000,
        output_config: { effort: 'low' },
        tools,
        messages,
      });
      content.push(...message.content);
    }
    return { ...message, content };
  }
}
