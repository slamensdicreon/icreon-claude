import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { BlobStore, OperationCatalog, ToolResult, ToolServer } from '@lw/tool-gateway';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { extractPage, type PageExtract } from './extract';
import { assertNavigable, BlockedUrlError, isBlockedSubresource, type UrlPolicy } from './ssrf';

export const BREAKPOINTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 834, height: 1112 },
  phone: { width: 390, height: 844 },
} as const;
type Breakpoint = keyof typeof BREAKPOINTS;

export interface BrowserServerOptions {
  /** Source-site hosts per project; the browser goes nowhere else. */
  policy: (projectId: string) => UrlPolicy;
  blobs: BlobStore;
  /** Defaults to CHROMIUM_PATH, then the image's pre-installed Chromium. */
  executablePath?: string;
  navigationTimeoutMs?: number;
}

const CATALOG: OperationCatalog = {
  crawl: {
    description:
      'Crawl the source site from a start URL (plus its sitemap): page inventory with titles, headings, word counts, images and alt text, internal links, and header/nav/footer regions repeated across pages. Same host only.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        maxPages: { type: 'integer', minimum: 1, maximum: 500 },
      },
      required: ['url'],
      additionalProperties: false,
    },
    mutates: false,
    untrusted: true,
  },
  snapshot: {
    description:
      'Structure of one source page: headings, content blocks in order, images, links and regions.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
      additionalProperties: false,
    },
    mutates: false,
    untrusted: true,
  },
  screenshot: {
    description:
      'Full-page screenshots of a URL at desktop (1440), tablet (834) and phone (390) widths, for visual comparison.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        breakpoints: {
          type: 'array',
          items: { type: 'string', enum: ['desktop', 'tablet', 'phone'] },
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
    mutates: false,
  },
  'fetch.asset': {
    description:
      'Download a media asset from the source site; returns its content hash (for de-duplication), type, size and stored reference.',
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

/** Tool server for everything that needs a real browser against the source site. */
export class BrowserToolServer implements ToolServer {
  readonly name = 'browser';
  readonly catalog = CATALOG;
  private browser: Promise<Browser> | null = null;

  constructor(private readonly opts: BrowserServerOptions) {}

  target(projectId: string): string {
    return this.opts.policy(projectId).allowedHosts[0] ?? projectId;
  }

  async close(): Promise<void> {
    if (this.browser) await (await this.browser).close();
    this.browser = null;
  }

  async call(
    op: string,
    args: Record<string, unknown>,
    ctx: { projectId: string },
  ): Promise<ToolResult> {
    const policy = this.opts.policy(ctx.projectId);
    try {
      switch (op) {
        case 'crawl':
          return await this.crawl(policy, String(args.url), Number(args.maxPages ?? 200));
        case 'snapshot':
          return await this.withPage(policy, async (context) => {
            const r = await this.load(context, policy, String(args.url));
            return {
              code: r.status,
              body: r.page,
              summary: `Snapshot of ${r.page.url}: ${r.page.blocks.length} blocks`,
            };
          });
        case 'screenshot':
          return await this.screenshot(
            ctx.projectId,
            policy,
            String(args.url),
            (args.breakpoints as Breakpoint[]) ?? ['desktop', 'tablet', 'phone'],
          );
        case 'fetch.asset':
          return await this.fetchAsset(ctx.projectId, policy, String(args.url));
        default:
          return { code: 400, body: { error: `Unknown operation ${op}` } };
      }
    } catch (err) {
      if (err instanceof BlockedUrlError)
        return { code: 403, body: { error: err.message }, summary: `Blocked: ${err.message}` };
      throw err;
    }
  }

  private launch(): Promise<Browser> {
    this.browser ??= chromium.launch({
      executablePath:
        this.opts.executablePath ??
        process.env.CHROMIUM_PATH ??
        (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined),
      args: ['--no-sandbox'],
    });
    return this.browser;
  }

  /** A fresh context per call: no cookies or storage carried between projects or tasks. */
  private async withPage<T>(
    policy: UrlPolicy,
    fn: (context: BrowserContext) => Promise<T>,
  ): Promise<T> {
    const context = await (
      await this.launch()
    ).newContext({ javaScriptEnabled: true, viewport: BREAKPOINTS.desktop });
    await context.addInitScript('globalThis.__name = (f) => f;');
    await context.route('**/*', (route) => {
      const req = route.request();
      if (isBlockedSubresource(req.url(), policy)) return route.abort('blockedbyclient');
      // Navigations (and redirects) must stay on the project's hosts.
      if (req.isNavigationRequest()) {
        const host = new URL(req.url()).hostname.toLowerCase();
        if (!policy.allowedHosts.map((h) => h.toLowerCase()).includes(host))
          return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    try {
      return await fn(context);
    } finally {
      await context.close();
    }
  }

  private async load(context: BrowserContext, policy: UrlPolicy, raw: string) {
    const url = await assertNavigable(raw, policy);
    const page = await context.newPage();
    const response = await page.goto(url.toString(), {
      waitUntil: 'domcontentloaded',
      timeout: this.opts.navigationTimeoutMs ?? 30_000,
    });
    const status = response?.status() ?? 0;
    const contentType = response?.headers()['content-type'] ?? '';
    if (!contentType.includes('html')) {
      await page.close();
      return { status, page: null as never, contentType };
    }
    const extract = (await page.evaluate(`(${extractPage.toString()})()`)) as PageExtract;
    await page.close();
    return { status, contentType, page: { url: canonical(page.url()), status, ...extract } };
  }

  private async crawl(policy: UrlPolicy, start: string, maxPages: number): Promise<ToolResult> {
    const origin = (await assertNavigable(start, policy)).origin;
    const queue = [canonical(start), ...(await this.sitemap(policy, origin))];
    const seen = new Set<string>();
    const pages: (PageExtract & { url: string; status: number })[] = [];
    const excluded: { url: string; reason: string }[] = [];

    await this.withPage(policy, async (context) => {
      while (queue.length && pages.length < maxPages) {
        const next = queue.shift()!;
        if (seen.has(next)) continue;
        seen.add(next);
        if (
          /\.(pdf|zip|docx?|xlsx?|pptx?|jpe?g|png|gif|svg|webp|mp4|mp3)$/i.test(
            new URL(next).pathname,
          )
        ) {
          excluded.push({ url: next, reason: 'not a page (file download)' });
          continue;
        }
        try {
          const r = await this.load(context, policy, next);
          if (!r.page) {
            excluded.push({
              url: next,
              reason: `not a page (${r.contentType || 'no content type'})`,
            });
            continue;
          }
          if (r.status >= 400) {
            excluded.push({ url: next, reason: `HTTP ${r.status}` });
            continue;
          }
          pages.push(r.page);
          for (const link of r.page.links) {
            const c = safeCanonical(link);
            if (c && new URL(c).origin === origin && !seen.has(c)) queue.push(c);
          }
        } catch (err) {
          excluded.push({
            url: next,
            reason: err instanceof Error ? err.message.split('\n')[0]! : String(err),
          });
        }
      }
    });

    // Regions present on at least half the pages are partial-design candidates.
    const counts = new Map<string, { region: string; hash: string; text: string; pages: number }>();
    for (const p of pages) {
      for (const [region, r] of Object.entries(p.regions)) {
        if (!r) continue;
        const key = `${region}:${r.hash}`;
        const c = counts.get(key) ?? { region, hash: r.hash, text: r.text, pages: 0 };
        c.pages++;
        counts.set(key, c);
      }
    }
    const repeatedRegions = [...counts.values()].filter(
      (c) => pages.length > 1 && c.pages >= pages.length / 2,
    );
    const truncated = queue.some((u) => !seen.has(u));
    return {
      code: 200,
      body: { origin, pages, excluded, repeatedRegions, truncated },
      summary: `Crawled ${pages.length} pages from ${origin}; ${excluded.length} excluded; ${repeatedRegions.length} repeated regions`,
    };
  }

  private async sitemap(policy: UrlPolicy, origin: string): Promise<string[]> {
    try {
      const url = await assertNavigable(`${origin}/sitemap.xml`, policy);
      const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return [];
      const xml = await res.text();
      return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)]
        .map((m) => safeCanonical(m[1]!))
        .filter((u): u is string => Boolean(u) && new URL(u!).origin === origin);
    } catch {
      return [];
    }
  }

  private async screenshot(
    projectId: string,
    policy: UrlPolicy,
    raw: string,
    breakpoints: Breakpoint[],
  ): Promise<ToolResult> {
    const url = await assertNavigable(raw, policy);
    const shots = await this.withPage(policy, async (context) => {
      const out = [];
      for (const bp of breakpoints) {
        const page = await context.newPage();
        await page.setViewportSize(BREAKPOINTS[bp]);
        await page.goto(url.toString(), {
          waitUntil: 'load',
          timeout: this.opts.navigationTimeoutMs ?? 30_000,
        });
        const png = await page.screenshot({ fullPage: true, type: 'png' });
        await page.close();
        const sha256 = createHash('sha256').update(png).digest('hex');
        const ref = await this.opts.blobs.put(
          projectId,
          `screenshots/${sha256}.png`,
          png,
          'image/png',
        );
        out.push({ breakpoint: bp, width: BREAKPOINTS[bp].width, bytes: png.length, sha256, ref });
      }
      return out;
    });
    return {
      code: 200,
      body: { url: url.toString(), shots },
      summary: `Screenshots of ${url.pathname} at ${breakpoints.join(', ')}`,
    };
  }

  private async fetchAsset(projectId: string, policy: UrlPolicy, raw: string): Promise<ToolResult> {
    const url = await assertNavigable(raw, policy);
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return { code: res.status, body: { error: `HTTP ${res.status}` } };
    const bytes = new Uint8Array(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const ext = (/\.([a-z0-9]{2,5})$/i.exec(url.pathname)?.[1] ?? 'bin').toLowerCase();
    const ref = await this.opts.blobs.put(projectId, `assets/${sha256}.${ext}`, bytes, contentType);
    return {
      code: 200,
      body: { url: url.toString(), contentType, bytes: bytes.length, sha256, ref },
      summary: `Fetched ${url.pathname} (${bytes.length} bytes)`,
    };
  }
}

/** Same page, one spelling: no fragment, no trailing slash (except the root). */
export function canonical(raw: string): string {
  const u = new URL(raw);
  u.hash = '';
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

function safeCanonical(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? canonical(raw) : null;
  } catch {
    return null;
  }
}
