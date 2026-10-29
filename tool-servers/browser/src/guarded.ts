import { existsSync } from 'node:fs';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { EgressProxy } from './egress';
import { hostAllowed, isBlockedSubresource, type UrlPolicy } from './ssrf';

export const BREAKPOINTS = {
  desktop: { width: 1440, height: 900 },
  tablet: { width: 834, height: 1112 },
  phone: { width: 390, height: 844 },
} as const;
export type Breakpoint = keyof typeof BREAKPOINTS;

/** Chromium's path: CHROMIUM_PATH, the image's pre-installed browser, or Playwright's download. */
export function chromiumPath(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  if (existsSync('/opt/pw-browsers/chromium')) return '/opt/pw-browsers/chromium';
  try {
    const bundled = chromium.executablePath();
    return existsSync(bundled) ? bundled : undefined;
  } catch {
    return undefined;
  }
}

export interface GuardedBrowserOptions {
  executablePath?: string;
  /** Tests serve fixture sites on 127.0.0.1; production never sets this. */
  allowPrivateNetworks?: boolean;
}

/**
 * One Chromium shared by the browser-driven tool servers. Every call gets a fresh context (no
 * cookies or storage carried between projects or tasks) whose requests are held to the project's
 * URL policy: navigations stay on its hosts. All traffic leaves through the egress proxy, which
 * refuses private addresses after resolving them.
 */
export class GuardedBrowser {
  readonly executablePath: string | undefined;
  private browser: Promise<Browser> | null = null;
  private proxy: Promise<EgressProxy> | null = null;

  constructor(private readonly opts: GuardedBrowserOptions = {}) {
    this.executablePath = opts.executablePath ?? chromiumPath();
  }

  /** The egress proxy, for other Chrome drivers (Lighthouse) to launch behind. */
  egress(): Promise<EgressProxy> {
    this.proxy ??= EgressProxy.start({ allowPrivateNetworks: this.opts.allowPrivateNetworks });
    return this.proxy;
  }

  async withContext<T>(policy: UrlPolicy, fn: (context: BrowserContext) => Promise<T>): Promise<T> {
    const open = async () =>
      (await this.launch()).newContext({ javaScriptEnabled: true, viewport: BREAKPOINTS.desktop });
    let context: BrowserContext;
    try {
      context = await open();
    } catch (err) {
      // Chromium crashed or was closed under us: launch it again rather than fail every call.
      if (!/has been closed|disconnected/i.test(String(err))) throw err;
      this.browser = null;
      context = await open();
    }
    await context.addInitScript('globalThis.__name = (f) => f;');
    await context.route('**/*', (route) => {
      const req = route.request();
      if (isBlockedSubresource(req.url(), policy)) return route.abort('blockedbyclient');
      // Navigations (and redirects) must stay on the project's hosts.
      if (req.isNavigationRequest()) {
        const host = new URL(req.url()).hostname.toLowerCase();
        if (!hostAllowed(host, policy)) return route.abort('blockedbyclient');
      }
      return route.continue();
    });
    try {
      return await fn(context);
    } finally {
      await context.close();
    }
  }

  async close(): Promise<void> {
    if (this.browser) await (await this.browser).close();
    this.browser = null;
  }

  private launch(): Promise<Browser> {
    if (!this.browser) {
      const launched: Promise<Browser> = chromium
        .launch({ executablePath: this.executablePath, args: ['--no-sandbox'] })
        .then((b) => {
          // Once it disconnects (crash, or closed during a restart), the next call launches anew.
          b.on('disconnected', () => {
            if (this.browser === launched) this.browser = null;
          });
          return b;
        });
      launched.catch(() => {
        if (this.browser === launched) this.browser = null;
      });
      this.browser = launched;
    }
    return this.browser;
  }
}
