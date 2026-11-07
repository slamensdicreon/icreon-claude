import { createHash } from 'node:crypto';
import type { BlobStore, OperationCatalog, ToolResult, ToolServer } from '@lw/tool-gateway';
import type { BrowserContext, Page } from 'playwright-core';
import { BREAKPOINTS, GuardedBrowser, type Breakpoint } from './guarded';
import { extractContent, extractPage, type PageExtract } from './extract';
import { cleanMarkup, outlineSections, readStyles, STYLE_PROPS } from './structure';
import { layoutData } from './layout-data';
import { assertNavigable, BlockedUrlError, type UrlPolicy } from './ssrf';

export interface BrowserServerOptions {
  /** Source-site hosts per project; the browser goes nowhere else. */
  policy: (projectId: string) => UrlPolicy;
  blobs: BlobStore;
  /** Shared with other browser-driven servers; one is launched if not given. */
  browser?: GuardedBrowser;
  navigationTimeoutMs?: number;
  /** How long a page built in the browser may take to render before it is read (default 6 s). */
  settleMs?: number;
  /**
   * Hosts a project's own records point media at (a CDN, an uploads host): downloads may come
   * from them as well as from the source site.
   */
  assetHosts?: (projectId: string) => Promise<string[]>;
  /** Most characters a crawl result may take (default 400,000, about 100K tokens). */
  crawlBudget?: number;
  /**
   * Longest a crawl reads pages before it returns what it has (default 7 minutes). The gateway
   * gives a call 10 minutes and returns nothing when it runs out, so a large site's crawl must
   * stop short of that and hand back the pages read.
   */
  crawlTimeMs?: number;
}

/**
 * A crawl's pages, small enough for an agent's context whatever the site's size. Links are used
 * to find pages, not returned; images on most pages (the logo, the footer's icons) are listed
 * once; each block keeps a short excerpt. Past the budget, detail goes in steps: block text,
 * then blocks, then all but the main headings. `browser.snapshot` reads any page in full.
 */
export function compactCrawl(
  pages: (PageExtract & { url: string; status: number })[],
  budget: number,
) {
  const imageCount = new Map<string, { src: string; alt: string | null; pages: number }>();
  for (const p of pages)
    for (const img of new Map(p.images.map((i) => [i.src, i])).values()) {
      const c = imageCount.get(img.src) ?? { ...img, pages: 0 };
      c.pages++;
      imageCount.set(img.src, c);
    }
  const shared = [...imageCount.values()].filter(
    (c) => pages.length > 1 && c.pages >= pages.length / 2,
  );
  const isShared = new Set(shared.map((c) => c.src));
  const levels = [
    { blocks: 25, blockText: 200, headings: 30, images: 30 },
    { blocks: 25, blockText: 0, headings: 20, images: 20 },
    { blocks: 0, blockText: 0, headings: 12, images: 10 },
    { blocks: 0, blockText: 0, headings: 4, images: 3 },
  ];
  const detail = [
    'full',
    'block text left out to fit; use browser.snapshot for a page in full',
    'blocks left out to fit; use browser.snapshot for a page in full',
    'only main headings and a few images kept to fit; use browser.snapshot for a page in full',
  ];
  let out: unknown[] = [];
  let level = 0;
  for (; level < levels.length; level++) {
    const l = levels[level]!;
    out = pages.map((p) => ({
      url: p.url,
      status: p.status,
      title: p.title,
      description: p.description,
      lang: p.lang,
      wordCount: p.wordCount,
      headings: (l.headings < 12 ? p.headings.filter((h) => h.level <= 2) : p.headings).slice(
        0,
        l.headings,
      ),
      images: p.images.filter((i) => !isShared.has(i.src)).slice(0, l.images),
      links: p.links.length,
      ...(l.blocks
        ? {
            blocks: p.blocks.slice(0, l.blocks).map((b) => ({
              tag: b.tag,
              className: b.className,
              heading: b.heading,
              ...(l.blockText ? { text: b.text.slice(0, l.blockText) } : {}),
            })),
          }
        : {}),
    }));
    if (JSON.stringify(out).length <= budget) break;
  }
  return {
    pages: out,
    sharedImages: shared.map(({ src, alt, pages: n }) => ({ src, alt, pages: n })),
    detail: detail[Math.min(level, detail.length - 1)]!,
  };
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
      "A live page's structure for rebuilding it without the source code. Without `selector`: its sections in order (header, each section of the main content, footer), each with a selector, tag, classes, headings, first words, markup size, and the URLs of its CSS background images and videos (a section's photo often sits on a theme layer as a background). With `selector` (one from the outline, or any CSS selector): that element's markup, cleaned (classes, structure, links, images and text kept; scripts, styles, handlers and tracking removed), up to `maxChars` (default 30000).",
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
  'page.data': {
    description:
      "A page's content as its CMS delivered it, when the page embeds its layout data (Next.js sites on Sitecore, SitecoreAI or XM Cloud do): each component in order, with its datasource and fields (text, rich text, images with src and alt, links with href, child items with their fields). It includes what the page renders only in the browser (carousels, tabs, team and award lists) and link targets a snapshot shows only as button text. Without `component`, every component up to `maxChars` (default 40000); give `component` (a name from the list) for that one in full. Returns no components when the page embeds no layout data: use snapshot and page.markup then.",
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        component: { type: 'string' },
        maxChars: { type: 'integer', minimum: 2000, maximum: 120000 },
      },
      required: ['url'],
      additionalProperties: false,
    },
    mutates: false,
    untrusted: true,
  },
  'page.styles': {
    description:
      "How a live page looks, in values a builder can use: computed styles (font, size, weight, colour, background, spacing, borders per side, radius, layout, clip-path, opacity) of up to 20 selectors (a selector may end in ::before or ::after), plus the page's design tokens (most used fonts, text colours, backgrounds and font sizes; :root custom properties; media-query breakpoints) and its stylesheets. Measured at desktop width (1440) unless `width` says otherwise: give 768 or 390 to read the tablet or phone layout.",
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        selectors: { type: 'array', items: { type: 'string' }, maxItems: 20 },
        width: { type: 'integer', minimum: 320, maximum: 2560 },
      },
      required: ['url'],
      additionalProperties: false,
    },
    mutates: false,
    untrusted: true,
  },
};

/** Tool server for everything that needs a real browser against the source site. */
/** Words and images on a page as it stands, the measure of whether it has rendered yet. */
const PAGE_SIZE = `(() => {
  const words = (document.body ? document.body.innerText : '').split(/\\s+/).filter(Boolean).length;
  return words + 10 * document.images.length;
})()`;

/**
 * A page built in the browser (client-side rendering) is nearly empty when its HTML has loaded:
 * its copy and images arrive once its scripts and their requests run. For such a page, wait for
 * the network to go quiet and the page to stop growing, up to `maxMs`. A page that arrived with
 * its content (server-rendered) is read at once.
 */
async function settle(page: Page, maxMs: number): Promise<void> {
  let size = (await page.evaluate(PAGE_SIZE)) as number;
  if (size >= 80 || maxMs <= 0) return;
  const deadline = Date.now() + maxMs;
  await page.waitForLoadState('networkidle', { timeout: maxMs }).catch(() => {});
  let steady = 0;
  while (steady < 2 && Date.now() < deadline) {
    await page.waitForTimeout(300);
    const next = (await page.evaluate(PAGE_SIZE)) as number;
    steady = next === size ? steady + 1 : 0;
    size = next;
  }
}

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
              code: pageCode(r.status),
              body: r.page,
              summary: `Snapshot of ${r.page.url}: ${r.page.blocks.length} blocks, ${r.page.content?.length ?? 0} text items in full${refusedNote(r.status)}`,
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
        case 'page.data':
          return await this.pageData(policy, args);
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

  /** Section outline, one section's markup, or styles: read as rendered at desktop width, or styles at another `width`. */
  private async structure(
    policy: UrlPolicy,
    op: 'page.markup' | 'page.styles',
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const url = await assertNavigable(String(args.url), policy);
    return this.withPage(policy, async (context) => {
      const page = await context.newPage();
      const width = Number(args.width);
      await page.setViewportSize(
        op === 'page.styles' && Number.isInteger(width) && width >= 320 && width <= 2560
          ? { width, height: BREAKPOINTS.desktop.height }
          : BREAKPOINTS.desktop,
      );
      const response = await page.goto(url.toString(), {
        waitUntil: 'load',
        timeout: this.opts.navigationTimeoutMs ?? 30_000,
      });
      const status = response?.status() ?? 0;
      const code = pageCode(status);
      const refused = refusedNote(status);
      const run = <T>(fn: (...a: never[]) => T, ...a: unknown[]) =>
        page.evaluate(
          `(${fn.toString()})(${a.map((x) => JSON.stringify(x)).join(',')})`,
        ) as Promise<T>;
      try {
        if (op === 'page.styles') {
          const selectors = ((args.selectors as string[] | undefined) ?? []).slice(0, 20);
          const styles = await run(readStyles, selectors, STYLE_PROPS);
          return {
            code,
            body: { url: canonical(page.url()), width: page.viewportSize()?.width, ...styles },
            summary: `Styles of ${canonical(page.url())} at ${page.viewportSize()?.width}px wide: ${styles.elements.filter((e) => e.matches).length}/${selectors.length} selectors matched, ${styles.tokens.fonts.length} fonts, ${Object.keys(styles.tokens.customProperties).length} custom properties${refused}`,
          };
        }
        if (typeof args.selector !== 'string' || !args.selector) {
          const sections = await run(outlineSections);
          return {
            code,
            body: { url: canonical(page.url()), sections },
            summary: `${sections.length} sections on ${canonical(page.url())}${refused}`,
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
          code,
          body: { url: canonical(page.url()), selector: args.selector, ...markup },
          summary: `Markup of ${args.selector}: ${markup.html.length} characters${markup.truncated ? ' (truncated)' : ''}${refused}`,
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
    await settle(page, this.opts.settleMs ?? 6_000);
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
    const fromSitemap = await this.sitemap(policy, origin);
    const queue = [canonical(start), ...fromSitemap];
    const deadline = Date.now() + (this.opts.crawlTimeMs ?? 7 * 60_000);
    let outOfTime = false;
    const seen = new Set<string>();
    const pages: (PageExtract & { url: string; status: number })[] = [];
    const excluded: { url: string; reason: string }[] = [];

    await this.withPage(policy, async (context) => {
      while (queue.length && pages.length < maxPages) {
        // The home page is always read, however long the sitemap took.
        if (pages.length && Date.now() > deadline) {
          outOfTime = true;
          break;
        }
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
    const compact = compactCrawl(pages, this.opts.crawlBudget ?? 400_000);
    // Pages the site refused (401/403): its bot protection turning our browser away.
    const refused = excluded.filter((e) => /^HTTP 40[13]$/.test(e.reason));
    if (!pages.length && refused.length)
      return {
        code: 422,
        body: { origin, ...compact, excluded, repeatedRegions, truncated, refusedBySite: true },
        summary: siteRefused(origin, refused[0]!.reason, refused.length, excluded.length),
      };
    const sitemapUrls = new Set(fromSitemap).size;
    return {
      code: 200,
      body: {
        origin,
        ...compact,
        excluded,
        repeatedRegions,
        truncated,
        sitemapUrls,
        ...(outOfTime ? { stoppedForTime: true } : {}),
      },
      summary: `Crawled ${pages.length} pages from ${origin}; ${excluded.length} excluded; ${repeatedRegions.length} repeated regions${
        outOfTime
          ? `. Stopped for time after ${pages.length} pages: the sitemap lists ${sitemapUrls} URLs. Use the sitemap for the page count, and read the pages a template still needs with browser.snapshot`
          : ''
      }${
        refused.length
          ? `. The site refused ${refused.length} of them (${refused[0]!.reason}): list those pages as not read, they aren't an access problem of ours`
          : ''
      }`,
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

  /** The page's components and fields from its embedded layout data, within a size budget. */
  private async pageData(policy: UrlPolicy, args: Record<string, unknown>): Promise<ToolResult> {
    let url = await assertNavigable(String(args.url), policy);
    let res: Response | null = null;
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
    let status = res?.status ?? 0;
    let html = res?.ok ? await res.text() : null;
    if (!html && [401, 403, 429, 503].includes(status)) {
      // Some sites turn away anything but a browser: ask the real one for the page as served.
      const got = await this.withPage(policy, async (context) => {
        const page = await context.newPage();
        try {
          const r = await page.goto(url.toString(), {
            timeout: this.opts.navigationTimeoutMs ?? 30_000,
          });
          return { status: r?.status() ?? 0, body: r?.ok() ? await r.text() : null };
        } finally {
          await page.close();
        }
      });
      status = got.status;
      html = got.body;
    }
    if (!html)
      return {
        code: status === 404 ? 404 : 422,
        body: { error: `HTTP ${status} from ${url.host}`, url: url.toString() },
        summary: `Couldn't read ${url.pathname}: HTTP ${status}`,
      };
    const all = layoutData(html);
    const want = typeof args.component === 'string' ? args.component.toLowerCase() : null;
    const picked = want ? all.filter((c) => c.name.toLowerCase() === want) : all;
    const budget = Number(args.maxChars) || (want ? 120_000 : 40_000);
    let used = 0;
    const components = picked.map((c) => {
      const size = JSON.stringify(c.fields ?? null).length;
      if (used + size > budget)
        return {
          name: c.name,
          dataSource: c.dataSource,
          fieldsOmitted: `${size} characters: ask for this component by name`,
        };
      used += size;
      return c;
    });
    return {
      code: 200,
      body: {
        url: url.toString(),
        embedsLayoutData: all.length > 0,
        components,
        ...(want && !picked.length
          ? {
              note: `No component named ${String(args.component)}: ${[...new Set(all.map((c) => c.name))].join(', ') || 'none'}`,
            }
          : {}),
      },
      summary: all.length
        ? `${url.pathname}: ${picked.length} of ${all.length} components from its layout data`
        : `${url.pathname} embeds no layout data`,
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

/**
 * A tool result's code for a page the browser loaded. The page's own HTTP status passes through,
 * except two cases where it would mislead:
 * - A not-found page (404, 410) was read all the same, and it's often what the agent asked for
 *   (the missing-page probe, the site's 404 page). An error code would hand the agent only the
 *   summary, without the page's title, headings and text, so it's a 200 with the status in the
 *   body and the summary.
 * - A refusal (401, 403: bot protection at the site's CDN, or how it answers a URL it doesn't
 *   have) says nothing about our access, but a 401 or 403 from a tool means a credential was
 *   refused, which stops the task for the Director. So it's a 422: the agent's to work around.
 */
export const pageCode = (status: number) =>
  status === 401 || status === 403 ? 422 : status === 404 || status === 410 ? 200 : status;

/** What the agent is told about a page the site refused, or a not-found page it read. */
const refusedNote = (status: number) =>
  status === 404 || status === 410
    ? `. The site answered HTTP ${status}: this is its not-found page, read as served. Its title, headings and text are in the result (for the missing-page probe, they are the errorPage)`
    : status === 401 || status === 403
      ? `. The site answered HTTP ${status} for this page: it refused it (often bot protection, or how the site answers a URL it doesn't have). That is the site, not our access: for the missing-page probe, record errorPage as null; otherwise leave the page out and say so`
      : '';

/**
 * The source site turned our browser away on every page it was asked for: Discovery can't read it
 * as a visitor. Said so the agent stops and asks the Director, instead of retrying or reporting a
 * refused credential (the site's refusal isn't one).
 */
export const siteRefused = (origin: string, reason: string, refused: number, tried: number) =>
  `${origin} refused our browser: ${refused} of ${tried} pages answered ${reason}, so no page could be read. ` +
  `That is the site's bot protection, not our access, and retrying won't change it. ` +
  `Stop and submit needs_decision for the Director: the client allows our crawler, or gives the source repository, or the project uses another site`;
