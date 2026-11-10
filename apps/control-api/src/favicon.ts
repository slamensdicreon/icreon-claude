import { assertNavigable, type UrlPolicy } from '@lw/tool-browser';

/**
 * A project's source site icon, for its tile in the Control Center: the best icon the home page
 * names (an apple-touch-icon or the largest declared icon), else /favicon.ico. Fetched like the
 * crawler fetches: only the source site's hosts, never a private address, each redirect checked.
 * Kept a day (an hour when the site has none), per origin.
 */
export interface Icon {
  bytes: Uint8Array;
  type: string;
}

export interface FaviconOptions {
  fetch?: typeof fetch;
  /** Tests serve fixture sites on 127.0.0.1; production never sets this. */
  allowPrivateNetworks?: boolean;
  now?: () => number;
}

const MAX_HTML = 1024 * 1024;
const MAX_ICON = 256 * 1024;
const DAY = 24 * 60 * 60_000;
const HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  accept: 'text/html,image/avif,image/webp,image/png,image/svg+xml,image/*,*/*;q=0.8',
};

const TYPES: Record<string, string> = {
  png: 'image/png',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** The icons a page names, best first: apple-touch-icon, then larger declared sizes, then SVG. */
export function iconLinks(html: string, base: string): string[] {
  const found: { href: string; score: number }[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? '';
    const href =
      /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? /\bhref\s*=\s*([^\s>]+)/i.exec(tag)?.[1];
    if (!href || !/(^|\s)(icon|shortcut icon|apple-touch-icon(-precomposed)?)(\s|$)/.test(rel))
      continue;
    // A Safari pinned-tab icon is a one-colour mask: not a picture of the brand.
    if (/mask-icon/.test(rel)) continue;
    const size = Number(/\bsizes\s*=\s*["']?(\d+)x\d+/i.exec(tag)?.[1] ?? 0);
    const svg = /\.svg(\?|$)/i.test(href) || /image\/svg/i.test(tag);
    const score = (rel.includes('apple-touch-icon') ? 1000 : 0) + (size || (svg ? 256 : 32));
    try {
      found.push({ href: new URL(href.replace(/&amp;/g, '&'), base).href, score });
    } catch {
      /* not a URL */
    }
  }
  return [...new Set(found.sort((a, b) => b.score - a.score).map((f) => f.href))];
}

export class Favicons {
  private readonly cache = new Map<string, { icon: Icon | null; until: number }>();
  private readonly pending = new Map<string, Promise<Icon | null>>();
  private readonly fetch: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: FaviconOptions = {}) {
    this.fetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  async get(sourceUrl: string): Promise<Icon | null> {
    let origin: string;
    try {
      origin = new URL(sourceUrl).origin;
    } catch {
      return null;
    }
    const hit = this.cache.get(origin);
    if (hit && hit.until > this.now()) return hit.icon;
    const running = this.pending.get(origin);
    if (running) return running;
    const p = this.find(origin)
      .catch(() => null)
      .then((icon) => {
        this.cache.set(origin, { icon, until: this.now() + (icon ? DAY : DAY / 24) });
        this.pending.delete(origin);
        return icon;
      });
    this.pending.set(origin, p);
    return p;
  }

  private policy(origin: string): UrlPolicy {
    const host = new URL(origin).hostname;
    const bare = host.replace(/^www\./, '');
    return {
      allowedHosts: [bare, `www.${bare}`],
      allowPrivateNetworks: this.opts.allowPrivateNetworks,
    };
  }

  /** GET with each redirect checked against the source site's hosts and private addresses. */
  private async get1(raw: string, policy: UrlPolicy): Promise<Response | null> {
    let url = await assertNavigable(raw, policy);
    for (let hop = 0; hop < 5; hop++) {
      const res = await this.fetch(url, {
        redirect: 'manual',
        headers: HEADERS,
        signal: AbortSignal.timeout(10_000),
      });
      const to = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!to) return res;
      await res.body?.cancel().catch(() => {});
      url = await assertNavigable(new URL(to, url).toString(), policy);
    }
    return null;
  }

  private async read(res: Response, max: number): Promise<Uint8Array | null> {
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > max) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return bytes.length && bytes.length <= max ? bytes : null;
  }

  private async find(origin: string): Promise<Icon | null> {
    const policy = this.policy(origin);
    let candidates: string[] = [];
    try {
      const home = await this.get1(`${origin}/`, policy);
      if (home?.ok && /html/i.test(home.headers.get('content-type') ?? '')) {
        const html = new TextDecoder().decode(
          (await this.read(home, MAX_HTML)) ?? new Uint8Array(),
        );
        candidates = iconLinks(html, home.url || `${origin}/`);
      }
    } catch {
      /* no page: try the conventional icon */
    }
    for (const href of [...candidates, `${origin}/favicon.ico`]) {
      try {
        const res = await this.get1(href, policy);
        if (!res?.ok) continue;
        const bytes = await this.read(res, MAX_ICON);
        if (!bytes) continue;
        const declared = (res.headers.get('content-type') ?? '')
          .split(';')[0]!
          .trim()
          .toLowerCase();
        const ext = /\.([a-z0-9]+)(\?|$)/i.exec(new URL(href).pathname)?.[1]?.toLowerCase() ?? '';
        const type = declared.startsWith('image/') ? declared : TYPES[ext];
        // A page answering for a missing icon is not an icon.
        if (!type || /html|text/.test(declared)) continue;
        return { bytes, type };
      } catch {
        /* the next candidate */
      }
    }
    return null;
  }
}
