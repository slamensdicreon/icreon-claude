import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';

/**
 * A page the Director saved from their own browser ("Save page as… Webpage, Single File", an
 * .mhtml file) and attached to the project. When the source site refuses automated browsers
 * (Liberty Mutual: HTTP 403 to every browser read), the team works from this copy instead: the
 * browser tools open it offline, with its own styles and images, and never touch the live site.
 */
export interface Capture {
  /** The page it was saved from (Snapshot-Content-Location). */
  url: string;
  /** When it was saved, as the file says (Date header), or null. */
  savedAt: string | null;
  title: string | null;
  /** The resources inside it, by the URL each was loaded from. */
  parts: { location: string; contentType: string; body: Buffer }[];
  /** The file as saved, to open in the browser. */
  raw: Buffer;
}

/** Reads an MHTML file: its page URL, date and parts. Null when it isn't one. */
export function parseMhtml(raw: Buffer): Capture | null {
  const text = raw.toString('latin1');
  const headerEnd = text.search(/\r?\n\r?\n/);
  if (headerEnd < 0) return null;
  const head = unfold(text.slice(0, headerEnd));
  const header = (name: string) =>
    new RegExp(`^${name}:[ \\t]*(.*)$`, 'im').exec(head)?.[1]?.trim() ?? null;
  const type = header('Content-Type') ?? '';
  const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
  if (!/multipart\/related/i.test(type) || !boundary) return null;
  const parts: Capture['parts'] = [];
  for (const chunk of text.split(`--${boundary}`).slice(1)) {
    if (chunk.startsWith('--')) break;
    const split = chunk.search(/\r?\n\r?\n/);
    if (split < 0) continue;
    const ph = unfold(chunk.slice(0, split));
    const get = (name: string) =>
      new RegExp(`^${name}:[ \\t]*(.*)$`, 'im').exec(ph)?.[1]?.trim() ?? '';
    const body = chunk
      .slice(split)
      .replace(/^\r?\n\r?\n/, '')
      .replace(/\r?\n$/, '');
    const encoding = get('Content-Transfer-Encoding').toLowerCase();
    const bytes =
      encoding === 'base64'
        ? Buffer.from(body.replace(/\s+/g, ''), 'base64')
        : encoding === 'quoted-printable'
          ? quotedPrintable(body)
          : Buffer.from(body, 'latin1');
    parts.push({
      location: get('Content-Location'),
      contentType: get('Content-Type').split(';')[0]!.trim().toLowerCase(),
      body: bytes,
    });
  }
  const url = header('Snapshot-Content-Location') ?? parts[0]?.location ?? '';
  if (!/^https?:\/\//i.test(url)) return null;
  const date = header('Date');
  const savedAt = date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : null;
  return { url, savedAt, title: decodeWord(header('Subject')), parts, raw };
}

/** The same page, for matching a capture to a URL: host and path, no trailing slash or hash. */
export function pageKey(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.hostname.toLowerCase().replace(/^www\./, '')}${path}${u.search}`;
  } catch {
    return url;
  }
}

/** A resource inside a capture, by the URL it was loaded from. */
export function partFor(c: Capture, url: string): Capture['parts'][number] | undefined {
  return (
    c.parts.find((p) => p.location === url) ??
    c.parts.find((p) => pageKey(p.location) === pageKey(url))
  );
}

/**
 * Opens a capture in a new page, offline: every request but the file itself is refused, so
 * nothing reaches the live site (scripts the copy still holds can't call home either).
 */
export async function openCapture(context: BrowserContext, c: Capture): Promise<Page> {
  const dir = join(tmpdir(), 'launchworks-captures');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${createHash('sha256').update(c.raw).digest('hex').slice(0, 24)}.mhtml`);
  if (!existsSync(file)) writeFileSync(file, c.raw);
  const page = await context.newPage();
  await page.route('**/*', (route) =>
    route.request().url().startsWith('file:') ? route.continue() : route.abort(),
  );
  await page.goto(`file://${file}`, { waitUntil: 'load', timeout: 30_000 });
  return page;
}

/** The capture's own page (its HTML part), as served when it was saved. */
export function captureHtml(c: Capture): string {
  const part = c.parts.find((p) => p.contentType === 'text/html') ?? c.parts[0];
  return part ? part.body.toString('utf8') : '';
}

const unfold = (s: string) => s.replace(/\r?\n[ \t]+/g, ' ');

function quotedPrintable(s: string): Buffer {
  const soft = s.replace(/=\r?\n/g, '');
  const out: number[] = [];
  for (let i = 0; i < soft.length; i++) {
    const ch = soft[i]!;
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(soft.slice(i + 1, i + 3))) {
      out.push(parseInt(soft.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(ch.charCodeAt(0) & 0xff);
  }
  return Buffer.from(out);
}

/** A MIME encoded-word subject (=?utf-8?Q?…?=), as plain text. */
function decodeWord(s: string | null): string | null {
  if (!s) return null;
  return s.replace(/=\?([^?]+)\?([QqBb])\?([^?]*)\?=/g, (_m, _cs, enc: string, body: string) =>
    enc.toUpperCase() === 'B'
      ? Buffer.from(body, 'base64').toString('utf8')
      : quotedPrintable(body.replace(/_/g, ' ')).toString('utf8'),
  );
}
