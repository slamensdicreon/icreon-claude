import { gunzipSync } from 'node:zlib';
import { assertNavigable, type UrlPolicy } from '../ssrf';

/** What a browser sends for a page, so sites that turn away bare clients serve it. */
export const PAGE_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};

/** Largest response read; past it the page is cut (a page that big is a file, not a page). */
const MAX_BYTES = 8 * 1024 * 1024;

export interface Fetched {
  /** The URL asked for. */
  url: string;
  /** Where it ended up after redirects (each hop checked against the policy). */
  finalUrl: string;
  /** The first redirect's status and target, when the URL moved. */
  redirect: { status: number; to: string } | null;
  status: number;
  contentType: string;
  /** Seconds or a date, from Retry-After on a 429 or 503. */
  retryAfterMs: number | null;
  body: string;
}

export interface FetchOptions {
  timeoutMs?: number;
  /** Replaceable in tests. */
  fetch?: typeof fetch;
}

/**
 * GET over plain HTTP, the way a crawl reads most pages: no browser, so many at once. Redirects
 * are followed one hop at a time, each checked like the first (the project's hosts, no private
 * addresses), so a redirect can't take the crawl somewhere the browser couldn't go.
 */
export async function fetchPage(
  raw: string,
  policy: UrlPolicy,
  opts: FetchOptions = {},
): Promise<Fetched> {
  const get = opts.fetch ?? fetch;
  let url = await assertNavigable(raw, policy);
  let redirect: Fetched['redirect'] = null;
  for (let hop = 0; ; hop++) {
    const res = await get(url, {
      redirect: 'manual',
      headers: PAGE_HEADERS,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    const to = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (to && hop < 5) {
      await res.body?.cancel().catch(() => {});
      const next = new URL(to, url).toString();
      redirect ??= { status: res.status, to: next };
      url = await assertNavigable(next, policy);
      continue;
    }
    const contentType = res.headers.get('content-type') ?? '';
    const textual = /html|xml|text|json/i.test(contentType) || /\.gz$/i.test(url.pathname);
    const body = textual ? await readBody(res, url) : '';
    if (!textual) await res.body?.cancel().catch(() => {});
    return {
      url: raw,
      finalUrl: url.toString(),
      redirect,
      status: res.status,
      contentType,
      retryAfterMs: retryAfter(res.headers.get('retry-after')),
      body,
    };
  }
}

async function readBody(res: Response, url: URL): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const bytes = Buffer.concat(chunks);
  // A gzipped sitemap (sitemap.xml.gz) arrives compressed, not content-encoded.
  if (/\.gz$/i.test(url.pathname) && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      return gunzipSync(bytes, { maxOutputLength: MAX_BYTES * 4 }).toString('utf8');
    } catch {
      return '';
    }
  }
  return bytes.toString('utf8');
}

/** Retry-After as milliseconds: delta-seconds or an HTTP date; null when absent or nonsense. */
export function retryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const s = Number(value);
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}
