import { createHash } from 'node:crypto';
import type { BlobStore, OperationCatalog, ToolResult, ToolServer } from '@lw/tool-gateway';
import type { BrowserContext } from 'playwright-core';
import { BREAKPOINTS, GuardedBrowser, type Breakpoint } from './guarded';
import { extractContent, extractPage, type PageExtract } from './extract';
import { cleanMarkup, outlineSections, readStyles, STYLE_PROPS } from './structure';
import { assertNavigable, BlockedUrlError, type UrlPolicy } from './ssrf';

export interface BrowserServerOptions {
  /** Source-site hosts per project; the browser goes nowhere else. */
  policy: (projectId: string) => UrlPolicy;
  blobs: BlobStore;
  /** Shared with other browser-driven servers; one is launched if not given. */
  browser?: GuardedBrowser;
  navigationTimeoutMs?: number;
  /**
   * Hosts a project's own records point media at (a CDN, an uploads host): downloads may come
   * from them as well as from the source site.
   */
  assetHosts?: (projectId: string) => Promise<string[]>;
}

/** What a browser sends for an image, so sites that turn away bare clients serve the file. */
const BROWSER_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};

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
      "One source page: headings, content blocks, images (src, alt), links and regions, plus `content`, the page's whole text in reading order (paragraphs, list items, accordion answers, table cells), for migrating its copy word for word.",
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
  'page.markup': {
    description:
      "A live page's structure for rebuilding it without the source code. Without `selector`: its sections in order (header, each section of the main content, footer), each with a selector, tag, classes, headings, first words and markup size. With `selector` (one from the outline, or any CSS selector): that element's markup, cleaned (classes, structure, links, images and text kept; scripts, styles, handlers and tracking removed), up to `maxChars` (default 30000).",
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        selector: { type: 'string' },
        maxChars: { type: 'integer', minimum: 1000, maximum: 100000 },
      },
      required: ['url'],
      additionalProperties: false,
    },
    mutates: false,
    untrusted: true,
  },
  'page.styles': {
    description:
      "How a live page looks, in values a builder can use: computed styles (font, size, weight, colour, background, spacing, borders per side, radius, layout, clip-path, opacity) of up to 20 selectors at desktop width (a selector may end in ::before or ::after), plus the page's design tokens (most used fonts, text colours, backgrounds and font sizes; :root custom properties; media-query breakpoints) and its stylesheets.",
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        selectors: { type: 'array', items: { type: 'string' }, maxItems: 20 },
      },
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
  private readonly browser: GuardedBrowser;
  private readonly ownsBrowser: boolean;

  constructor(private readonly opts: BrowserServerOptions) {
    this.ownsBrowser = !opts.browser;
    this.browser = opts.browser ?? new GuardedBrowser();
  }

  target(projectId: string): string {
    return this.opts.policy(projectId).allowedHosts[0] ?? projectId;
  }

  async close(): Promise<void> {
    if (this.ownsBrowser) await this.browser.close();
  }

  private withPage<T>(policy: UrlPolicy, fn: (context: BrowserContext) => Promise<T>) {
    return this.browser.withContext(policy, fn);
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
            const r = await this.load(context, policy, String(args.url), true);
            return {
              code: r.status,
              body: r.page,
              summary: `Snapshot of ${r.page.url}: ${r.page.blocks.length} blocks, ${r.page.content?.length ?? 0} text items in full`,
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
        case 'page.markup':
        case 'page.styles':
          return await this.structure(policy, op, args);
        default:
          return { code: 400, body: { error: `Unknown operation ${op}` } };
      }
    } catch (err) {
      // A refused URL is the agent's to correct (another URL), not an access problem.
      if (err instanceof BlockedUrlError)
        return { code: 422, body: { error: err.message }, summary: `Blocked: ${err.message}` };
      throw err;
    }
  }

  /** Section outline, one section's markup, or styles: read from the page as rendered at desktop width. */
  private async structure(
    policy: UrlPolicy,
    op: 'page.markup' | 'page.styles',
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const url = await assertNavigable(String(args.url), policy);
    return this.withPage(policy, async (context) => {
      const page = await context.newPage();
      await page.setViewportSize(BREAKPOINTS.desktop);
      const response = await page.goto(url.toString(), {
        waitUntil: 'load',
        timeout: this.opts.navigationTimeoutMs ?? 30_000,
      });
      const status = response?.status() ?? 0;
      const run = <T>(fn: (...a: never[]) => T, ...a: unknown[]) =>
        page.evaluate(
          `(${fn.toString()})(${a.map((x) => JSON.stringify(x)).join(',')})`,
        ) as Promise<T>;
      try {
        if (op === 'page.styles') {
          const selectors = ((args.selectors as string[] | undefined) ?? []).slice(0, 20);
          const styles = await run(readStyles, selectors, STYLE_PROPS);
          return {
            code: status,
            body: { url: canonical(page.url()), ...styles },
            summary: `Styles of ${canonical(page.url())}: ${styles.elements.filter((e) => e.matches).length}/${selectors.length} selectors matched, ${styles.tokens.fonts.length} fonts, ${Object.keys(styles.tokens.customProperties).length} custom properties`,
          };
        }
        if (typeof args.selector !== 'string' || !args.selector) {
          const sections = await run(outlineSections);
          return {
            code: status,
            body: { url: canonical(page.url()), sections },
            summary: `${sections.length} sections on ${canonical(page.url())}`,
          };
        }
        const markup = await run(cleanMarkup, args.selector, Number(args.maxChars ?? 30_000));
        if (!markup.found)
          return {
            code: 404,
            body: { error: `Nothing matches ${args.selector} on ${canonical(page.url())}` },
            summary: `No element matches ${args.selector}`,
          };
        return {
          code: status,
          body: { url: canonical(page.url()), selector: args.selector, ...markup },
          summary: `Markup of ${args.selector}: ${markup.html.length} characters${markup.truncated ? ' (truncated)' : ''}`,
        };
      } finally {
        await page.close();
      }
    });
  }

  private async load(context: BrowserContext, policy: UrlPolicy, raw: string, full = false) {
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
    // The full text only where it's asked for (a snapshot): a crawl keeps the short form.
    let text = full
      ? ((await page.evaluate(`(${extractContent.toString()})()`)) as ReturnType<
          typeof extractContent
        > & { from?: 'served-html' })
      : null;
    // Some page builders take the copy out of the page once their scripts run (sliders, reveal
    // effects), though the server sent it. When the page as served holds far more words than
    // the page as rendered, read the served HTML with its scripts removed.
    if (text && response) {
      const served = await response.text().catch(() => '');
      const rendered = text.content.reduce((n, c) => n + words(c.text), 0);
      if (words(plainText(served)) > Math.max(150, rendered * 2.5)) {
        const copy = await context.newPage();
        try {
          await copy.setContent(withoutScripts(served, url.toString()), {
            waitUntil: 'domcontentloaded',
          });
          const fromServed = (await copy.evaluate(
            `(${extractContent.toString()})()`,
          )) as ReturnType<typeof extractContent>;
          if (fromServed.content.reduce((n, c) => n + words(c.text), 0) > rendered)
            text = { ...fromServed, from: 'served-html' };
        } finally {
          await copy.close();
        }
      }
    }
    await page.close();
    return {
      status,
      contentType,
      page: { url: canonical(page.url()), status, ...extract, ...(text ?? {}) },
    };
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
        await settleForScreenshot(page);
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

  private async fetchAsset(projectId: string, base: UrlPolicy, raw: string): Promise<ToolResult> {
    const extra = (await this.opts.assetHosts?.(projectId)) ?? [];
    const policy: UrlPolicy = {
      ...base,
      allowedHosts: [...new Set([...base.allowedHosts, ...extra].map((h) => h.toLowerCase()))],
    };
    let url = await assertNavigable(raw, policy);
    let res: Response | null = null;
    // Follow redirects one hop at a time, each checked like the first.
    for (let hop = 0; hop < 5; hop++) {
      res = await fetch(url, {
        redirect: 'manual',
        headers: BROWSER_HEADERS,
        signal: AbortSignal.timeout(30_000),
      });
      const to = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!to) break;
      url = await assertNavigable(new URL(to, url).toString(), policy);
    }
    let bytes: Uint8Array | null = null;
    let contentType = 'application/octet-stream';
    let status = res?.status ?? 0;
    if (res?.ok) {
      bytes = new Uint8Array(await res.arrayBuffer());
      contentType = res.headers.get('content-type') ?? contentType;
    } else if ([401, 403, 429, 503].includes(status)) {
      // Some sites turn away anything but a browser: ask the real one.
      const got = await this.withPage(policy, async (context) => {
        const page = await context.newPage();
        try {
          const r = await page.goto(url.toString(), {
            timeout: this.opts.navigationTimeoutMs ?? 30_000,
          });
          return {
            status: r?.status() ?? 0,
            body: r?.ok() ? new Uint8Array(await r.body()) : null,
            type: r?.headers()['content-type'] ?? null,
          };
        } finally {
          await page.close();
        }
      });
      status = got.status;
      if (got.body) {
        bytes = got.body;
        contentType = got.type ?? contentType;
      }
    }
    if (!bytes)
      return {
        // Not found, or refused even to a browser: the agent's to handle (another URL, or report
        // it), never a credential problem.
        code: status === 404 ? 404 : 422,
        body: { error: `HTTP ${status} from ${url.host}`, url: url.toString() },
        summary: `Couldn't download ${url.pathname}: HTTP ${status} from ${url.host}${status === 403 ? ' (the site refused it, also to a real browser)' : ''}`,
      };
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

/**
 * Readies a page for a full-page comparison: scrolls through it so lazy images and reveal-on-scroll
 * sections load, then hides overlays fixed mid-screen (cookie and chat banners), which otherwise
 * cover whatever content sits under them in the capture. A header pinned to the top stays.
 */
async function settleForScreenshot(page: {
  evaluate<T>(fn: () => Promise<T> | T): Promise<T>;
  waitForTimeout(ms: number): Promise<void>;
}) {
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 600) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 80));
    }
    window.scrollTo(0, 0);
  });
  // Scrolling starts count-ups and reveal animations (commonly up to 2s): let them finish, or the
  // shot shows half-counted numbers and half-faded sections.
  await page.waitForTimeout(2500);
  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const position = getComputedStyle(el).position;
      if ((position === 'fixed' || position === 'sticky') && el.getBoundingClientRect().top > 40)
        el.style.setProperty('visibility', 'hidden', 'important');
    }
  });
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** A page's text as served, without its markup, scripts or styles. */
const plainText = (html: string) =>
  html.replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');

/** The served HTML with its scripts removed, resolving links against the page's own URL. */
const withoutScripts = (html: string, url: string) =>
  `<base href="${url.replace(/"/g, '&quot;')}">${html.replace(/<script[\s\S]*?<\/script>/gi, '')}`;
