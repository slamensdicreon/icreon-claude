import { mapLimit, type VerifyConfig } from '@lw/connectors';
import type { CheckResult, PlatformCheck, PlatformCheckContext } from '../src/index';
import { getText, redirectedAway, renderingName } from './checks';

/**
 * Discovery checks (phases 1 and 2): what the source site has that turns into a Director card in
 * migration when discovery doesn't say it up front. Forms a plugin renders, URLs the source sends
 * elsewhere, the error page Next.js won't serve at its own path, SEO titles that aren't headings,
 * content only the page's embedded layout data carries, media on other hosts, and a crawl that saw
 * only part of the site. Each reads the project's documents and a sample of the source's pages.
 */

/** The most source pages one check reads. */
const SAMPLE = 20;

/** The page inventory as the Content Analyst writes it (prompts/content-analyst.md). */
interface InventoryPage {
  path?: string;
  url?: string;
  title?: string;
  description?: string | null;
  template?: string;
  forms?: unknown;
  layoutData?: unknown;
  redirectsTo?: string;
}

interface Inventory {
  origin?: string;
  pages?: InventoryPage[];
  crawl?: { partial?: boolean; sampling?: string } | null;
  forms?: unknown;
  redirects?: unknown;
  layoutData?: unknown;
  mediaHosts?: unknown;
  excluded?: { url?: string }[];
  truncated?: boolean;
}

type Item = NonNullable<PlatformCheckContext['blueprint']>['collections'][string][number];

const pass = (detail: string): CheckResult => ({ status: 'pass', detail });
const fail = (problems: string[]): CheckResult => ({
  status: 'fail',
  detail: `${problems.slice(0, 8).join('; ')}${problems.length > 8 ? `; and ${problems.length - 8} more` : ''}.`,
});
const pending = (detail: string): CheckResult => ({ status: 'pending', detail });

/** A few of a list, in words: "a, b, c and 4 more". */
const few = (xs: string[], n = 5) =>
  xs.length <= n ? xs.join(', ') : `${xs.slice(0, n).join(', ')} and ${xs.length - n} more`;
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A path as the Blueprint gives it: no query, no trailing slash, `/` for the home page. */
export function pathOf(u: string): string {
  let p = u.trim();
  try {
    if (/^https?:\/\//i.test(p)) p = new URL(p).pathname;
  } catch {
    /* as given */
  }
  try {
    p = decodeURI(p);
  } catch {
    /* as given */
  }
  p = p.split(/[?#]/)[0]!.replace(/\/+$/, '');
  return p.startsWith('/') ? p : `/${p}`;
}
/** A path for comparing: case doesn't tell two pages apart here. */
const pk = (p: string) => pathOf(p).toLowerCase();

const inventoryPath = (p: InventoryPage) => {
  const raw = p.path ?? p.url;
  return raw ? pathOf(raw) : '';
};

const originOf = (inv: Inventory | null) => {
  try {
    return inv?.origin ? new URL(inv.origin).origin : null;
  } catch {
    return null;
  }
};

/** Where a page is read on the source: the inventory's URL for it, or the origin and its path. */
const urlFor = (origin: string, path: string, url?: string) =>
  url && /^https?:\/\//i.test(url) ? url : `${origin}${path}`;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  middot: '·',
  bull: '•',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
};

/** HTML entities as the text a browser shows. */
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e.startsWith('#')) {
      const n = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(n);
      } catch {
        return m;
      }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Letters and digits only: "Safety &#8211; Acme" and "Safety – Acme" read the same. */
const sameText = (a: string, b: string) => {
  const k = (s: string) =>
    decode(s)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '');
  return k(a) === k(b);
};

/** An HTML tag's attributes, names lower-cased. */
function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g))
    out[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return out;
}

const headOf = (html: string) => /<head\b[\s\S]*?<\/head>/i.exec(html)?.[0] ?? html;

/** The page's <title> as a browser tab shows it, or null when it has none. */
export function titleIn(html: string): string | null {
  const t = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(headOf(html))?.[1];
  return t === undefined ? null : decode(t).replace(/\s+/g, ' ').trim();
}

/** The page's meta description, or null when it has none. */
export function descriptionIn(html: string): string | null {
  for (const m of headOf(html).matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrsOf(m[0]);
    if (a.name?.toLowerCase() === 'description')
      return decode(a.content ?? '')
        .replace(/\s+/g, ' ')
        .trim();
  }
  return null;
}

/** Hosted form services a page embeds in an iframe. */
const FORM_EMBEDS =
  /typeform\.com|jotform\.com|formstack\.com|forms\.office\.com|docs\.google\.com\/forms|forms\.gle|pardot\.com|hsforms\.(?:com|net)|cognitoforms\.com|wufoo\.com|formsite\.com/i;

/** A search box is not a form the site's owner collects anything with. */
function isSearch(a: Record<string, string>, inner: string): boolean {
  if (
    /search/i.test(
      [a.role, a.id, a.class, a.action, a.name, a['aria-label']].filter(Boolean).join(' '),
    )
  )
    return true;
  if (/<input\b[^>]*\btype=["']?search\b/i.test(inner)) return true;
  return (
    /<input\b[^>]*\bname=["']?(?:s|q|query|search|keywords?)\b/i.test(inner) &&
    !/<textarea\b|\btype=["']?email\b/i.test(inner)
  );
}

export interface SourceForm {
  /** The form's id (`gform_2`), name, Contact Form 7 id, or embed; `form <n>` when it has none. */
  id: string;
  /** How a message names it: `form#gform_2`. */
  label: string;
  /** No id of its own: known only by its page and position. */
  positional: boolean;
}

/**
 * The forms on a page as served: form plugins (Gravity Forms `form#gform_1`, Contact Form 7,
 * Elementor) render a plain `<form>`; HubSpot and hosted services embed theirs. Search boxes are
 * left out.
 */
export function formsIn(html: string): SourceForm[] {
  const out = new Map<string, SourceForm>();
  const body = html.replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ');
  let n = 0;
  for (const m of body.matchAll(/<form\b([^>]*)>([\s\S]*?)(?:<\/form>|$)/gi)) {
    const a = attrsOf(m[1]!);
    if (isSearch(a, m[2] ?? '')) continue;
    n++;
    const cf7 = /#(wpcf7-[\w-]+)/.exec(a.action ?? '')?.[1];
    const id = a.id || a.name || cf7 || a['data-form-id'] || a['data-formid'] || '';
    const form: SourceForm = id
      ? { id, label: a.id ? `form#${a.id}` : `form "${id}"`, positional: false }
      : {
          id: `form ${n}`,
          label: `form ${n}${a.action ? ` (posting to ${a.action})` : ''}`,
          positional: true,
        };
    if (!out.has(form.id)) out.set(form.id, form);
  }
  for (const m of html.matchAll(
    /hbspt\.forms\.create\(\s*\{[\s\S]*?formId\s*:\s*["']([\w-]+)["']/g,
  ))
    out.set(`hubspot:${m[1]}`, {
      id: `hubspot:${m[1]}`,
      label: `HubSpot form ${m[1]}`,
      positional: false,
    });
  for (const m of body.matchAll(/<iframe\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
    const src = m[1]!.split('?')[0]!;
    if (FORM_EMBEDS.test(src))
      out.set(src, { id: src, label: `the form embedded from ${src}`, positional: false });
  }
  return [...out.values()];
}

/** The App Router's flight payload (`self.__next_f.push`), as one text. */
const flightOf = (html: string) =>
  [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)]
    .map((m) => {
      try {
        return JSON.parse(m[1]!) as string;
      } catch {
        return '';
      }
    })
    .join('');

const nextDataOf = (html: string) =>
  /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1] ?? '';

/**
 * The componentName of each component in a page's embedded layout data (Next.js sites on
 * Sitecore write it into the HTML), once each, read as the browser's page.data reads it.
 */
export function layoutNamesIn(html: string): string[] {
  const flight = flightOf(html);
  let names: string[];
  if (flight.includes('"componentName"')) {
    // A head may also serialize an error boundary per component: the layout's own entries first.
    const byUid = [
      ...flight.matchAll(/"uid":"([0-9a-f-]{36})","componentName":"([A-Za-z0-9_-]+)"/g),
    ];
    names = byUid.length
      ? byUid.map((m) => m[2]!)
      : [...flight.matchAll(/"componentName":"([A-Za-z0-9_-]+)"/g)].map((m) => m[1]!);
  } else {
    names = [...nextDataOf(html).matchAll(/"componentName"\s*:\s*"([A-Za-z0-9_-]+)"/g)].map(
      (m) => m[1]!,
    );
  }
  return [...new Set(names)];
}

/** Layout scaffolding the starter has too: it places components, it isn't content to map. */
const SCAFFOLDING = new Set([
  'partialdesigndynamicplaceholder',
  'container',
  'columnsplitter',
  'rowsplitter',
]);
const nameKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Hosts whose images are tracking pixels, avatars or third-party widgets, not the site's media. */
const NOT_MEDIA =
  /(^|\.)(facebook\.com|facebook\.net|google-analytics\.com|googletagmanager\.com|doubleclick\.net|google\.com|googleapis\.com|gstatic\.com|bing\.com|linkedin\.com|licdn\.com|twitter\.com|twimg\.com|t\.co|hotjar\.com|clarity\.ms|adsrvr\.org|pinterest\.com|gravatar\.com|w\.org|youtube\.com|ytimg\.com|vimeo\.com|vimeocdn\.com)$/i;
const MEDIA_FILE = /\.(avif|bmp|gif|ico|jpe?g|png|svg|tiff?|webp|mp4|m4v|mov|webm|mp3|wav|pdf)$/i;

/**
 * The media a page shows, as absolute URLs: images, sources, video posters, CSS backgrounds, the
 * originals behind Next.js's image optimizer, and image fields in its embedded layout data.
 */
export function mediaIn(html: string, pageUrl: string): string[] {
  const raw: string[] = [];
  const page = html.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ');
  for (const m of page.matchAll(/<(?:img|source|video|audio)\b[^>]*>/gi)) {
    const a = attrsOf(m[0]);
    for (const k of ['src', 'data-src', 'data-lazy-src', 'poster']) if (a[k]) raw.push(a[k]!);
    for (const k of ['srcset', 'data-srcset', 'data-lazy-srcset'])
      if (a[k]) raw.push(...a[k]!.split(',').map((s) => s.trim().split(/\s+/)[0]!));
  }
  const css = [
    ...[...page.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]!),
    ...[...page.matchAll(/\bstyle=(?:"([^"]*)"|'([^']*)')/gi)].map((m) => decode(m[1] ?? m[2]!)),
  ].join(' ');
  for (const m of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi))
    if (!/\.(woff2?|ttf|otf|eot)([?#]|$)/i.test(m[2]!)) raw.push(m[2]!);
  // Image fields in the layout data: only media, never the head's scripts or styles.
  const data = `${flightOf(html)} ${nextDataOf(html)}`;
  for (const m of data.matchAll(/"src"\s*:\s*"(https?:[^"]+)"/g)) {
    const u = m[1]!.replace(/\\\//g, '/').replace(/\\u0026/g, '&');
    const path = u.split(/[?#]/)[0]!;
    if (
      !/\.(m?js|css|json)$/i.test(path) &&
      (MEDIA_FILE.test(path) || /\/(-\/)?media\//i.test(path))
    )
      raw.push(u);
  }
  const out: string[] = [];
  for (const r of raw) {
    const v = decode(r.trim());
    if (!v || /^(data|blob|javascript):|^#/i.test(v)) continue;
    try {
      let u = new URL(v, pageUrl);
      const inner = u.pathname === '/_next/image' ? u.searchParams.get('url') : null;
      if (inner) u = new URL(inner, pageUrl);
      if (u.protocol === 'http:' || u.protocol === 'https:') out.push(u.href);
    } catch {
      /* not a URL */
    }
  }
  return [...new Set(out)];
}

/**
 * Hosts a document names, as the media download reads them (packages/stack hostsNamedIn): full
 * URLs, URLs encoded in another, and hosts written without a scheme before a path.
 */
export function hostsNamed(text: string): Set<string> {
  const decoded = text.replace(/%3A/gi, ':').replace(/%2F/gi, '/');
  const hosts = new Set<string>();
  for (const m of decoded.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?=[/:"'\s?#]|$)/gi))
    hosts.add(m[1]!.toLowerCase());
  for (const m of decoded.matchAll(/(?<![\w.@/-])((?:[a-z0-9-]+\.)+[a-z]{2,})(?=\/[\w%~-])/gi))
    hosts.add(m[1]!.toLowerCase());
  return hosts;
}

/** The source's own host, with and without www. */
const sourceHosts = (origin: string) => {
  const h = new URL(origin).hostname.toLowerCase();
  return new Set([h, h.startsWith('www.') ? h.slice(4) : `www.${h}`]);
};

/** What one source page shows that discovery has to record. */
interface SourcePage {
  path: string;
  url: string;
  status: number;
  /** Another path the source answers from (a 301 or 302 elsewhere), or null. */
  movedTo: string | null;
  title: string | null;
  description: string | null;
  forms: SourceForm[];
  components: string[];
  media: string[];
}

async function readSource(
  cfg: VerifyConfig,
  targets: { path: string; url: string }[],
): Promise<SourcePage[]> {
  return mapLimit(targets, 4, async ({ path, url }) => {
    const r = await getText(cfg, url);
    const movedTo = r.status === 200 && redirectedAway(url, r.url) ? pathOf(r.url!) : null;
    const html = r.status === 200 && !movedTo ? r.body : '';
    return {
      path,
      url,
      status: r.status,
      movedTo,
      title: html ? titleIn(html) : null,
      description: html ? descriptionIn(html) : null,
      forms: html ? formsIn(html) : [],
      components: html ? layoutNamesIn(html) : [],
      media: html ? mediaIn(html, r.url || url) : [],
    };
  });
}

/** Pages that usually carry a form. */
const FORMISH =
  /contact|request|quote|apply|applic|enquir|inquir|regist|sign-?up|subscri|book|demo|support|career|job|form|rfp|estimat/i;

/**
 * The pages to read, at most SAMPLE: the home page, pages that usually carry a form, structural
 * parents (they often redirect), one page per template, then the rest in order.
 */
function pick<T extends { path: string; template?: unknown; title?: unknown; parent?: boolean }>(
  all: T[],
): T[] {
  const out: T[] = [];
  const taken = new Set<string>();
  const add = (t: T) => {
    const k = pk(t.path);
    if (taken.has(k) || out.length >= SAMPLE) return false;
    taken.add(k);
    out.push(t);
    return true;
  };
  const keys = all.map((t) => pk(t.path));
  const isParent = (t: T) => {
    const k = pk(t.path);
    return t.parent || (k !== '/' && keys.some((o) => o.startsWith(`${k}/`)));
  };
  const upTo = (list: T[], n: number) => {
    let added = 0;
    for (const t of list) if (added < n && add(t)) added++;
  };
  upTo(
    all.filter((t) => pk(t.path) === '/'),
    1,
  );
  upTo(
    all.filter((t) => FORMISH.test(`${t.path} ${String(t.title ?? '')}`)),
    8,
  );
  upTo(all.filter(isParent), 5);
  const groups = new Set<string>();
  upTo(
    all.filter((t) => {
      const g = String(t.template ?? '');
      if (!g || groups.has(g)) return false;
      groups.add(g);
      return true;
    }),
    SAMPLE,
  );
  upTo(all, SAMPLE);
  return out;
}

/** Parent paths of the given pages (`/services` for `/services/web`), excluding the home page. */
function parentsOf(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const parts = pathOf(p).split('/').filter(Boolean);
    for (let i = parts.length - 1; i >= 1; i--) out.push(`/${parts.slice(0, i).join('/')}`);
  }
  return [...new Set(out)];
}

/** A form as a document lists it: by id, or by the pages it is on. */
interface Listed {
  id: string | null;
  pages: string[];
  drop: boolean;
  director: boolean;
}

function listedForms(v: unknown, page?: string): Listed[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((e): Listed[] => {
    if (typeof e === 'string')
      return e.startsWith('/')
        ? [{ id: null, pages: [e], drop: false, director: false }]
        : [{ id: e, pages: page ? [page] : [], drop: false, director: false }];
    if (!e || typeof e !== 'object') return [];
    const o = e as Record<string, unknown>;
    const id = [o.id, o.formId, o.form, o.selector].find(
      (x): x is string => typeof x === 'string' && !!x.trim(),
    );
    const pages = (Array.isArray(o.pages) ? o.pages : [o.pages ?? o.page ?? page]).filter(
      (x): x is string => typeof x === 'string',
    );
    return [
      {
        id: id ?? null,
        pages,
        drop: !!o.drop || o.status === 'drop',
        director:
          /director/i.test(String(o.builtBy ?? o.by ?? '')) ||
          o.director === true ||
          o.directorItem === true,
      },
    ];
  });
}

const formKey = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/^form\s*#?|^#/, '');

/**
 * Whether a listed form is this one: the same id, or one of its pages when the entry gives no id
 * or the form has none of its own (then only its page tells it apart).
 */
function isListed(l: Listed, form: { id: string; positional: boolean; pages: string[] }) {
  const onPage = l.pages.some(
    (p) => p === '*' || p.toLowerCase() === 'all' || form.pages.some((f) => pk(f) === pk(p)),
  );
  if (form.positional || !l.id) return onPage;
  const a = formKey(l.id);
  const b = formKey(form.id);
  return a === b || (a.length >= 10 && b.length >= 10 && (a.includes(b) || b.includes(a)));
}

/** Source URLs an inventory records as redirecting elsewhere, by path. */
function recordedRedirects(inv: Inventory | null): Map<string, { from: string; to: string }> {
  const out = new Map<string, { from: string; to: string }>();
  if (!inv) return out;
  for (const r of Array.isArray(inv.redirects) ? inv.redirects : []) {
    const o = (r ?? {}) as Record<string, unknown>;
    const from = typeof o.from === 'string' ? o.from : typeof o.url === 'string' ? o.url : '';
    if (from) out.set(pk(from), { from: pathOf(from), to: String(o.to ?? '') || 'elsewhere' });
  }
  for (const p of inv.pages ?? [])
    if (typeof p.redirectsTo === 'string' && inventoryPath(p))
      out.set(pk(inventoryPath(p)), { from: inventoryPath(p), to: p.redirectsTo });
  return out;
}

/** The pages an inventory says embed layout data, and the component names it lists. */
function recordedLayout(inv: Inventory) {
  const names = new Set<string>();
  const pages = new Set<string>();
  let all = false;
  const take = (v: unknown) => {
    if (Array.isArray(v)) for (const n of v) if (typeof n === 'string') names.add(nameKey(n));
  };
  const top = inv.layoutData;
  if (Array.isArray(top)) take(top);
  else if (top && typeof top === 'object') {
    const o = top as Record<string, unknown>;
    take(o.components);
    if (o.pages === 'all' || o.pages === '*' || o.embedded === 'all') all = true;
    else if (Array.isArray(o.pages))
      for (const p of o.pages) if (typeof p === 'string') pages.add(pk(p));
  }
  for (const p of inv.pages ?? [])
    if (Array.isArray(p.layoutData) && inventoryPath(p)) {
      take(p.layoutData);
      pages.add(pk(inventoryPath(p)));
    }
  return { all, pages, names };
}

/** Whether an inventory was written to the shape discovery records now, or predates it. */
const isCurrent = (inv: Inventory) =>
  ['crawl', 'forms', 'redirects', 'layoutData', 'mediaHosts'].some((k) => k in inv) ||
  (inv.pages ?? []).some((p) => 'description' in p);

/** A sitemap's page paths on the source's own host, child sitemaps included (up to 5). */
async function sitemapPaths(cfg: VerifyConfig, origin: string): Promise<string[] | null> {
  const site = new URL(origin).hostname.replace(/^www\./, '').toLowerCase();
  const own = (u: string) => {
    try {
      return new URL(u).hostname.replace(/^www\./, '').toLowerCase() === site;
    } catch {
      return false;
    }
  };
  const locs = (xml: string) =>
    [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)/gi)].map((m) => decode(m[1]!));
  const first = await getText(cfg, `${origin}/sitemap.xml`);
  if (first.status !== 200 || !/<(urlset|sitemapindex)\b/i.test(first.body)) return null;
  let urls = locs(first.body);
  if (/<sitemapindex\b/i.test(first.body)) {
    const children = await mapLimit(urls.filter(own).slice(0, 5), 3, (u) => getText(cfg, u));
    urls = children.flatMap((c) => (c.status === 200 ? locs(c.body) : []));
  }
  return [
    ...new Set(
      urls
        .filter(own)
        .filter(
          (u) => !/\.(pdf|zip|docx?|xlsx?|pptx?|jpe?g|png|gif|svg|webp|mp4|mp3|xml)$/i.test(u),
        )
        .map(pathOf),
    ),
  ];
}

/** A Blueprint component that renders forms: Form, ContactForm, form-block. */
const isFormComponent = (c: Item) =>
  [c.name, renderingName(c), c.attrs?.componentName]
    .filter((x): x is string => typeof x === 'string')
    .some((s) =>
      /\bforms?\b/i.test(s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ')),
    );

/** A page item's path, or null when it gives none. */
const itemPath = (p: Item) =>
  typeof p.attrs?.path === 'string' && p.attrs.path.trim() ? pathOf(p.attrs.path) : null;

/** Where the Blueprint sends a page's visitors instead, when it decided that. */
const redirectOf = (p: Item) => {
  const a = p.attrs ?? {};
  const v = a.redirect ?? a.redirectTo ?? a.redirectsTo;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
};

/** The error status a page item serves, from `attrs.errorPage` (404, "404", true for 404). */
const errorStatusOf = (p: Item) => {
  const v = p.attrs?.errorPage;
  if (v === true || v === 404 || v === '404' || /not.?found/i.test(String(v ?? ''))) return 404;
  if (v === 500 || v === '500') return 500;
  return null;
};

/** The source component names a Blueprint component says it renders. */
function mapsNames(c: Item): string[] {
  const out: string[] = [c.name, renderingName(c)];
  const take = (v: unknown) => {
    for (const s of Array.isArray(v) ? v : [v])
      if (typeof s === 'string' && s.trim()) {
        out.push(s);
        // A source given as a file (`src/components/HeroBanner.tsx`) names its component too.
        out.push(
          s
            .split('/')
            .pop()!
            .replace(/\.[a-z]+$/i, ''),
        );
      }
  };
  const a = c.attrs ?? {};
  for (const k of ['sourceComponents', 'sourceComponent', 'componentName', 'source']) take(a[k]);
  for (const v of Array.isArray(a.variants) ? a.variants : [])
    if (v && typeof v === 'object')
      for (const k of ['sourceComponents', 'sourceComponent', 'componentName', 'source'])
        take((v as Record<string, unknown>)[k]);
  return out;
}

export function discoveryChecks(cfg: VerifyConfig): Record<string, PlatformCheck> {
  return {
    // The page inventory records what migration needs from the source and can't see later: each
    // page's <title> and meta description (the SEO step copies them), every form, every URL that
    // redirects elsewhere, the components of pages that embed layout data, media hosts other than
    // the source, and how much of the site it covers. Checked against a sample of source pages.
    'discovery.inventory': async (ctx) => {
      const inv = (await ctx.document('page-inventory')) as Inventory | null;
      if (!inv?.pages?.length)
        return fail([
          'No page inventory has been written: save it with artifacts.write as page-inventory',
        ]);
      const problems: string[] = [];
      // What the inventory records since discovery began checking it: an inventory written before
      // has none of it, and is told so (pending) rather than failed.
      const later: string[] = [];
      const current = isCurrent(inv);
      const origin = originOf(inv);
      if (!origin) problems.push("the inventory has no origin (the source site's address)");

      const moved = recordedRedirects(inv);
      const pages = inv.pages
        .map((entry) => ({ entry, path: inventoryPath(entry) }))
        .filter((p) => p.path && !moved.has(pk(p.path)));
      const untitled = pages.filter((p) => !String(p.entry.title ?? '').trim());
      if (untitled.length)
        problems.push(
          `${count(untitled.length, 'page has', 'pages have')} no title (${few(untitled.map((p) => p.path))}): record each page's <title> as the browser tab shows it (the crawl's title), not its heading`,
        );
      if (current) {
        const undescribed = pages.filter((p) => !('description' in p.entry));
        if (undescribed.length)
          later.push(
            `${count(undescribed.length, 'page records', 'pages record')} no description (${few(undescribed.map((p) => p.path))}): give each its meta description, or null when it has none`,
          );
        if (!inv.crawl || typeof inv.crawl !== 'object')
          later.push(
            "the inventory doesn't say how much of the site it covers: add crawl ({ pagesFound, pagesInventoried, partial, sampling })",
          );
      }

      const listed = [
        ...listedForms(inv.forms),
        ...inv.pages.flatMap((p) => listedForms(p.forms, inventoryPath(p))),
      ];
      const layout = recordedLayout(inv);
      const repo = await ctx.document('repo-inventory');
      const named = hostsNamed(JSON.stringify([inv, repo ?? null]));

      let seen: SourcePage[] = [];
      if (origin) {
        const known = new Set(pages.map((p) => pk(p.path)));
        const probes = parentsOf(pages.map((p) => p.path))
          .filter((p) => !known.has(pk(p)) && !moved.has(pk(p)))
          .slice(0, 5);
        const targets = pick([
          ...pages.map((p) => ({
            path: p.path,
            url: urlFor(origin, p.path, p.entry.url),
            template: p.entry.template,
            title: p.entry.title,
            parent: false,
          })),
          ...probes.map((path) => ({ path, url: `${origin}${path}`, parent: true })),
        ]);
        seen = await readSource(cfg, targets);
        const probed = new Set(probes.map(pk));
        const entryOf = new Map(pages.map((p) => [pk(p.path), p.entry]));
        const own = sourceHosts(origin);

        const titles: string[] = [];
        const descriptions: string[] = [];
        const forms: string[] = [];
        const redirects: string[] = [];
        const layoutGaps: string[] = [];
        const hosts = new Map<string, string>();
        for (const s of seen) {
          if (s.status !== 200) continue;
          if (s.movedTo) {
            redirects.push(
              `${s.path}${probed.has(pk(s.path)) ? ' (a parent of pages you list)' : ''} redirects to ${s.movedTo}`,
            );
            continue;
          }
          if (probed.has(pk(s.path))) continue;
          const entry = entryOf.get(pk(s.path));
          if (!entry) continue;
          if (s.title && entry.title && !sameText(entry.title, s.title))
            titles.push(`${s.path} is recorded as "${entry.title}"; its <title> is "${s.title}"`);
          if (current && 'description' in entry && s.description) {
            const have = String(entry.description ?? '');
            if (!have.trim()) descriptions.push(`${s.path} has one ("${s.description}")`);
            else if (!sameText(have, s.description))
              descriptions.push(`${s.path}'s is "${s.description}", not "${have}"`);
          }
          for (const f of s.forms)
            if (!listed.some((l) => isListed(l, { ...f, pages: [s.path] })))
              forms.push(`${f.label} on ${s.path}`);
          const names = s.components.filter((n) => !SCAFFOLDING.has(nameKey(n)));
          if (names.length) {
            const unlisted = names.filter((n) => !layout.names.has(nameKey(n)));
            if (!layout.all && !layout.pages.has(pk(s.path)))
              layoutGaps.push(`${s.path} (${few(names, 6)})`);
            else if (unlisted.length) layoutGaps.push(`${few(unlisted, 6)} on ${s.path}`);
          }
          for (const u of s.media) {
            const h = new URL(u).hostname.toLowerCase();
            if (!own.has(h) && !NOT_MEDIA.test(h) && !named.has(h) && !hosts.has(h))
              hosts.set(h, `${u} on ${s.path}`);
          }
        }
        if (titles.length)
          problems.push(
            `titles that aren't the page's <title>: ${few(titles, 3)}. Record the <title> word for word: the SEO step copies it`,
          );
        if (descriptions.length)
          later.push(
            `meta descriptions the inventory doesn't match: ${few(descriptions, 3)}. Record each word for word`,
          );
        if (forms.length)
          later.push(
            `forms the inventory doesn't record: ${few(forms)}. List each in forms ({ "id", "by", "pages", "fields" }); form plugins (Gravity Forms, Contact Form 7, HubSpot) render forms the crawl summary doesn't show`,
          );
        if (redirects.length)
          later.push(
            `source URLs that redirect elsewhere, not recorded: ${few(redirects)}. List each in redirects ({ "from", "to" }) instead of pages, so the Blueprint decides whether to keep it as a structural parent or drop it`,
          );
        if (layoutGaps.length)
          later.push(
            `layout data the inventory doesn't record: ${few(layoutGaps, 4)}. These pages embed their components and fields (browser.page.data): list each componentName in layoutData.components and the pages in layoutData.pages`,
          );
        if (hosts.size)
          later.push(
            `media on ${count(hosts.size, 'host')} the inventory doesn't name: ${few(
              [...hosts].map(([h, at]) => `${h} (${at})`),
              4,
            )}. List each in mediaHosts as a full https:// URL, or the media download can't fetch from it`,
          );

        const sitemap = await sitemapPaths(cfg, origin);
        const crawl = inv.crawl && typeof inv.crawl === 'object' ? inv.crawl : null;
        if (sitemap) {
          const covered = new Set([
            ...pages.map((p) => pk(p.path)),
            ...moved.keys(),
            ...(inv.excluded ?? []).flatMap((e) => (e?.url ? [pk(e.url)] : [])),
          ]);
          const missing = sitemap.filter((p) => !covered.has(pk(p)));
          if (missing.length && crawl?.partial !== true)
            later.push(
              `the sitemap lists ${count(missing.length, 'page')} the inventory neither lists nor excludes (${few(missing)}): inventory them, list them in excluded with the reason, or say the inventory is partial (crawl.partial: true, crawl.sampling: how you chose the pages)`,
            );
        }
        if (inv.truncated === true && crawl?.partial !== true)
          later.push(
            "the crawl was truncated, but the inventory doesn't say it is partial (crawl.partial: true, crawl.sampling)",
          );
        if (crawl?.partial === true && !String(crawl.sampling ?? '').trim())
          later.push(
            "the inventory is partial but doesn't say how its pages were chosen (crawl.sampling)",
          );
      }

      const read = seen.filter((s) => s.status === 200);
      const data = {
        sampled: seen.map((s) => ({ path: s.path, status: s.status, movedTo: s.movedTo })),
      };
      if (problems.length || (current && later.length))
        return { ...fail([...problems, ...later]), data };
      if (later.length)
        return {
          ...pending(
            `The page inventory predates what discovery records now (description, forms, redirects, layoutData, mediaHosts, crawl): ${later.join('; ')}. Amend it (artifacts.read, then artifacts.write) with them.`,
          ),
          data,
        };
      if (origin && seen.length && !read.length)
        return {
          ...pending(
            `${count(pages.length, 'page')}, each with a title; the source pages couldn't be read, so forms, redirects, layout data and media hosts weren't compared`,
          ),
          data,
        };
      if (!current)
        return {
          ...pending(
            `${count(pages.length, 'page')}, each with a title, but the inventory predates what discovery records now: add each page's description, and forms, redirects, layoutData, mediaHosts and crawl (artifacts.read, then artifacts.write)`,
          ),
          data,
        };
      return {
        ...pass(
          `${count(pages.length, 'page')}, each with its <title> and meta description; ${read.length} source pages read, their forms, redirects, layout data and media hosts recorded; ${inv.crawl?.partial ? `a partial inventory (${String(inv.crawl.sampling)})` : 'the whole site'}.`,
        ),
        data,
      };
    },

    // The Blueprint decides up front what would otherwise reach the Director mid-migration: every
    // source form placed (a Director item when Form is the SDK's built-in), every URL the source
    // redirects kept as a structural parent with its redirect or dropped, the 404 page planned at
    // /404, every source componentName mapped, and every media host named.
    'discovery.blueprint': async (ctx) => {
      const bp = ctx.blueprint;
      if (!bp?.collections) return pending('No Blueprint has been written yet.');
      const all = (c: string) => bp.collections[c] ?? [];
      const inv = (await ctx.document('page-inventory')) as Inventory | null;
      const repo = await ctx.document('repo-inventory');
      const origin = originOf(inv);
      const problems: string[] = [];
      const pageAt = new Map<string, Item>();
      for (const p of all('pages')) {
        const path = itemPath(p);
        if (path && !pageAt.has(pk(path))) pageAt.set(pk(path), p);
      }
      const dropped = (path: string) => pageAt.get(pk(path))?.status === 'drop';

      // The 404 page: Next.js reserves /404, so the page item never renders at its own path.
      const errorPages = all('pages').filter(
        (p) => p.status !== 'drop' && (itemPath(p) === '/404' || errorStatusOf(p) === 404),
      );
      const misplaced = errorPages.filter((p) => itemPath(p) !== '/404');
      // A 404 page recorded as dropped is a decision too (the homepage demo builds none).
      const decidedOut = all('pages').some(
        (p) => p.status === 'drop' && (itemPath(p) === '/404' || errorStatusOf(p) === 404),
      );
      if (!errorPages.length && !decidedOut)
        problems.push(
          `the Blueprint plans no 404 page: add a page with attrs.path "/404" and attrs.errorPage: 404 (copy from the inventory's errorPage). Next.js reserves /404, so the page never renders at its own path: the site's error-handling setting points at it, and it is checked at a URL that doesn't exist`,
        );
      else if (misplaced.length && !errorPages.some((p) => itemPath(p) === '/404'))
        problems.push(
          `${misplaced.map((p) => `${p.key} (${itemPath(p) ?? 'no path'})`).join(', ')} is the 404 page: give it attrs.path "/404" (and drop the source's own URL for it). Next.js reserves /404, so the page renders only through the site's error-handling setting, at a URL that doesn't exist, which is where it is checked`,
        );

      // Read the kept pages on the source.
      const invAt = new Map(
        (inv?.pages ?? []).map((p) => [pk(inventoryPath(p)), p] as const).filter(([k]) => k),
      );
      const kept = all('pages').filter(
        (p) => p.status !== 'drop' && itemPath(p) && !redirectOf(p) && !errorStatusOf(p),
      );
      const targets = origin
        ? pick(
            kept
              .filter((p) => itemPath(p) !== '/404')
              .map((p) => {
                const path = itemPath(p)!;
                return {
                  path,
                  url: urlFor(origin, path, invAt.get(pk(path))?.url),
                  template: p.attrs?.template,
                  title: p.name,
                };
              }),
          )
        : [];
      const seen = await readSource(cfg, targets);
      const read = seen.filter((s) => s.status === 200);

      // Forms: every form on the source is placed, or a Director item, or dropped on purpose.
      const forms = new Map<
        string,
        { id: string; label: string; positional: boolean; pages: string[] }
      >();
      const addForm = (f: { id: string; label: string; positional: boolean }, page: string) => {
        const key = f.positional ? `${pk(page)} ${f.id}` : formKey(f.id);
        const known = forms.get(key) ?? { ...f, pages: [] };
        if (!known.pages.includes(page)) known.pages.push(page);
        forms.set(key, known);
      };
      for (const s of read) for (const f of s.forms) addForm(f, s.path);
      if (inv)
        for (const l of [
          ...listedForms(inv.forms),
          ...(inv.pages ?? []).flatMap((p) => listedForms(p.forms, inventoryPath(p))),
        ])
          if (l.id)
            for (const page of l.pages.length ? l.pages : ['(the inventory)'])
              addForm({ id: l.id, label: `form ${l.id}`, positional: false }, page);
      const listed = Object.values(bp.collections).flatMap((items) =>
        items.flatMap((i) => listedForms(i.attrs?.forms, itemPath(i) ?? undefined)),
      );
      const formComponents = all('components').filter(
        (c) => c.status !== 'drop' && isFormComponent(c),
      );
      const builtIn = formComponents.find((c) => c.attrs?.builtIn === true);
      const unplaced: string[] = [];
      const unmarked: string[] = [];
      let accounted = 0;
      let directorItems = 0;
      for (const f of forms.values()) {
        const pages = f.pages.filter((p) => p.startsWith('/'));
        // A form only on pages the Blueprint drops goes with them.
        if (pages.length && pages.every(dropped)) continue;
        const where = `${f.label}${pages.length ? ` on ${few(pages, 3)}` : ''}`;
        const hit = listed.find((l) => isListed(l, f));
        if (!hit) unplaced.push(where);
        else {
          accounted++;
          if (hit.drop) continue;
          if (builtIn && !hit.director) unmarked.push(where);
          else if (builtIn) directorItems++;
        }
      }
      if (unplaced.length)
        problems.push(
          `forms on the source the Blueprint doesn't account for: ${few(unplaced)}. ${
            builtIn
              ? `${builtIn.name} keeps the SDK's built-in Form (attrs.builtIn), so each is a Director item, built by hand in SitecoreAI Forms before UAT: list each in its attrs.forms ({ "id", "pages", "fields", "builtBy": "director" })`
              : formComponents.length
                ? `List each in attrs.forms of the component that renders it (${formComponents.map((c) => c.name).join(', ')})`
                : `No component renders forms: add Form as the SDK's built-in (attrs.builtIn: true; each form is then a Director item made in SitecoreAI Forms) and list each in its attrs.forms ({ "id", "pages", "fields", "builtBy": "director" })`
          }, or list a form that won't move with "drop" and the reason`,
        );
      if (unmarked.length)
        problems.push(
          `${builtIn!.name} keeps the SDK's built-in Form (attrs.builtIn), so ${few(unmarked, 3)} ${unmarked.length === 1 ? 'is a Director item' : 'are Director items'} (SitecoreAI Forms, built by hand before UAT): mark ${unmarked.length === 1 ? 'its attrs.forms entry' : 'their attrs.forms entries'} "builtBy": "director"`,
        );
      const keptListed = listed.filter((l) => !l.drop);
      if (keptListed.length && !formComponents.length && !unplaced.length)
        problems.push(
          `the Blueprint lists forms (${few(
            keptListed.map((l) => l.id ?? l.pages.join(' ')),
            3,
          )}) but no component renders them: add Form as the SDK's built-in (attrs.builtIn: true; its forms are Director items made in SitecoreAI Forms) or the component that renders them`,
        );

      // Redirects: each source URL sent elsewhere is kept as a structural parent with its redirect,
      // or dropped.
      const redirects = recordedRedirects(inv);
      for (const s of read)
        if (s.movedTo) redirects.set(pk(s.path), { from: s.path, to: s.movedTo });
      const undecided: string[] = [];
      for (const [key, r] of redirects) {
        const p = pageAt.get(key);
        if (!p) undecided.push(`${r.from} (to ${r.to}) has no Blueprint entry`);
        else if (p.status !== 'drop' && !redirectOf(p))
          undecided.push(`${r.from} (${p.key}) redirects to ${r.to} on the source`);
      }
      if (undecided.length)
        problems.push(
          `source URLs that redirect elsewhere with no decision: ${few(undecided, 4)}. For each, keep its page as a structural parent with attrs.redirect naming where visitors go (the experience step adds the redirect), or drop it (status "drop", attrs.reason)`,
        );

      // Source components: every componentName the source's layout data uses maps to a rendering.
      const names = new Map<string, { name: string; pages: string[] }>();
      const addName = (n: string, page: string | null) => {
        const k = nameKey(n);
        if (!k || SCAFFOLDING.has(k)) return;
        const e = names.get(k) ?? { name: n, pages: [] };
        if (page && !e.pages.includes(page)) e.pages.push(page);
        names.set(k, e);
      };
      if (inv) {
        const top = inv.layoutData;
        const listedNames = Array.isArray(top)
          ? top
          : top && typeof top === 'object'
            ? (top as { components?: unknown }).components
            : null;
        for (const n of Array.isArray(listedNames) ? listedNames : [])
          if (typeof n === 'string') addName(n, null);
        for (const p of inv.pages ?? [])
          if (Array.isArray(p.layoutData))
            for (const n of p.layoutData) if (typeof n === 'string') addName(n, inventoryPath(p));
      }
      for (const s of read) for (const n of s.components) addName(n, s.path);
      const mapped = new Set(all('components').flatMap(mapsNames).map(nameKey));
      const unmapped = [...names.values()].filter((n) => !mapped.has(nameKey(n.name)));
      if (unmapped.length)
        problems.push(
          `source components no Blueprint component maps: ${few(
            unmapped.map((n) => (n.pages.length ? `${n.name} (${few(n.pages, 2)})` : n.name)),
            8,
          )}. The source embeds its layout data: list each componentName in attrs.sourceComponents of the component that renders it, or of a dropped component with the reason`,
        );

      // Media hosts: the media download fetches only from hosts the Blueprint or an inventory names.
      const named = hostsNamed(JSON.stringify([bp, inv ?? null, repo ?? null]));
      const hosts = new Map<string, string>();
      if (origin) {
        const own = sourceHosts(origin);
        for (const s of read)
          for (const u of s.media) {
            const h = new URL(u).hostname.toLowerCase();
            if (!own.has(h) && !NOT_MEDIA.test(h) && !named.has(h) && !hosts.has(h))
              hosts.set(h, `${u} on ${s.path}`);
          }
      }
      if (hosts.size)
        problems.push(
          `media on ${count(hosts.size, 'host')} neither the Blueprint nor an inventory names: ${few(
            [...hosts].map(([h, at]) => `${h} (${at})`),
            4,
          )}. Give those media items their full URLs (attrs.url, https://…), or the media download can't fetch from it`,
        );

      const data = {
        sampled: seen.map((s) => ({ path: s.path, status: s.status, movedTo: s.movedTo })),
        forms: [...forms.values()].map((f) => ({ id: f.id, pages: f.pages })),
        redirects: [...redirects.values()],
        components: [...names.values()].map((n) => n.name),
      };
      if (problems.length) return { ...fail(problems), data };
      if (!origin)
        return {
          ...pending(
            'No page inventory gives the source site, so no source page was compared; the 404 page is planned',
          ),
          data,
        };
      if (targets.length && !read.length)
        return {
          ...pending(
            "The source pages couldn't be read, so forms, redirects, layout data and media hosts weren't compared; the 404 page is planned",
          ),
          data,
        };
      return {
        ...pass(
          `${read.length} source pages compared with the Blueprint: ${count(accounted, 'form')} accounted for${builtIn ? ` (${count(directorItems, 'Director item')})` : ''}, ${count(redirects.size, 'redirect')} decided, the 404 page at /404, ${count(names.size, 'source component')} mapped, media hosts named.`,
        ),
        data,
      };
    },
  };
}
