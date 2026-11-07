import type { BrowserContext, Page } from 'playwright-core';
import { extractContent, extractPage, type PageExtract } from './extract';
import { assertNavigable, type UrlPolicy } from './ssrf';

/** Words and images on a page as it stands, the measure of whether it has rendered yet. */
const PAGE_SIZE = `(() => {
  const words = (document.body ? document.body.innerText : '').split(/\\s+/).filter(Boolean).length;
  return words + 10 * document.images.length;
})()`;

/**
 * Below this (words plus ten per image), a page hasn't rendered its content yet: it is built in
 * the browser. The crawl reads such a page again in a real browser.
 */
export const RENDERED_SIZE = 80;

/** The same measure as PAGE_SIZE, from an extract. */
export const sizeOf = (p: { wordCount: number; images: unknown[] }) =>
  p.wordCount + 10 * p.images.length;

/**
 * A page built in the browser (client-side rendering) is nearly empty when its HTML has loaded:
 * its copy and images arrive once its scripts and their requests run. For such a page, wait for
 * the network to go quiet and the page to stop growing, up to `maxMs`. A page that arrived with
 * its content (server-rendered) is read at once.
 */
export async function settle(page: Page, maxMs: number): Promise<void> {
  let size = (await page.evaluate(PAGE_SIZE)) as number;
  if (size >= RENDERED_SIZE || maxMs <= 0) return;
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

export interface LoadOptions {
  /** The page's whole text as well (a snapshot); a crawl keeps the short form. */
  full?: boolean;
  settleMs?: number;
  navigationTimeoutMs?: number;
}

/** One page read in a real browser: navigated, rendered, and extracted. */
export async function loadPage(
  context: BrowserContext,
  policy: UrlPolicy,
  raw: string,
  opts: LoadOptions = {},
) {
  const url = await assertNavigable(raw, policy);
  const page = await context.newPage();
  const response = await page.goto(url.toString(), {
    waitUntil: 'domcontentloaded',
    timeout: opts.navigationTimeoutMs ?? 30_000,
  });
  const status = response?.status() ?? 0;
  const contentType = response?.headers()['content-type'] ?? '';
  if (!contentType.includes('html')) {
    await page.close();
    return { status, page: null as never, contentType };
  }
  await settle(page, opts.settleMs ?? 6_000);
  const extract = (await page.evaluate(`(${extractPage.toString()})()`)) as PageExtract;
  // The full text only where it's asked for (a snapshot): a crawl keeps the short form.
  let text = opts.full
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
        const fromServed = (await copy.evaluate(`(${extractContent.toString()})()`)) as ReturnType<
          typeof extractContent
        >;
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

const EXTRACT_OFFLINE = `(() => { globalThis.__name = globalThis.__name || ((f) => f); return (${extractPage.toString()})(); })()`;

/**
 * Reads HTML fetched without a browser, in an offline context (scripts off, no requests): the
 * same extract a browser makes, for pages the server renders. A few pages are opened once and
 * reused, since opening a page costs 30 times what parsing one does.
 */
export class OfflineParser {
  private readonly free: Page[] = [];
  private readonly waiting: ((p: Page) => void)[] = [];
  private opened = 0;

  constructor(
    private readonly context: BrowserContext,
    private readonly size = 4,
  ) {}

  async parse(html: string, url: string): Promise<PageExtract> {
    const page = await this.acquire();
    let healthy = true;
    try {
      await page.setContent(withoutScripts(html, url), { waitUntil: 'domcontentloaded' });
      // Init scripts don't run with scripts off: define the helper the bundler may reference.
      return (await page.evaluate(EXTRACT_OFFLINE)) as PageExtract;
    } catch (err) {
      healthy = false;
      throw err;
    } finally {
      if (healthy) this.release(page);
      else {
        // A page that failed may be broken: replace it.
        this.opened--;
        await page.close().catch(() => {});
        this.waiting.shift()?.(await this.open());
      }
    }
  }

  private async open(): Promise<Page> {
    this.opened++;
    return this.context.newPage();
  }

  private async acquire(): Promise<Page> {
    const p = this.free.pop();
    if (p) return p;
    if (this.opened < this.size) return this.open();
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(page: Page) {
    const next = this.waiting.shift();
    if (next) next(page);
    else this.free.push(page);
  }
}

/** Same page, one spelling: no fragment, no trailing slash (except the root). */
export function canonical(raw: string): string {
  const u = new URL(raw);
  u.hash = '';
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

export function safeCanonical(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? canonical(raw) : null;
  } catch {
    return null;
  }
}

export const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** A page's text as served, without its markup, scripts or styles. */
export const plainText = (html: string) =>
  html.replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');

/** The served HTML with its scripts removed, resolving links against the page's own URL. */
export const withoutScripts = (html: string, url: string) =>
  `<base href="${url.replace(/"/g, '&quot;')}">${html.replace(/<script[\s\S]*?<\/script>/gi, '')}`;
