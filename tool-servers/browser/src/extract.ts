/// <reference lib="dom" />
/**
 * Runs inside the page (serialized by Playwright), so it must be self-contained: no imports,
 * no closures over module scope.
 */
export function extractPage() {
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  // A small stable hash, enough to spot the same header on many pages.
  const hash = (s: string) => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  };
  const region = (selector: string) => {
    const el = document.querySelector(selector);
    const text = clean(el?.textContent);
    return text ? { hash: hash(text), text: text.slice(0, 200) } : null;
  };
  const main = document.querySelector('main') ?? document.body;
  const blocks = Array.from(main.children)
    .filter((el) => !['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(el.tagName))
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      className: (el.getAttribute('class') ?? '').slice(0, 80),
      heading: clean(el.querySelector('h1,h2,h3,h4')?.textContent).slice(0, 160) || null,
      text: clean(el.textContent).slice(0, 500),
    }));
  return {
    title: clean(document.title),
    description:
      document.querySelector('meta[name="description"]')?.getAttribute('content') ?? null,
    lang: document.documentElement.lang || null,
    headings: Array.from(document.querySelectorAll('h1,h2,h3')).map((h) => ({
      level: Number(h.tagName[1]),
      text: clean(h.textContent).slice(0, 160),
    })),
    links: Array.from(document.querySelectorAll('a[href]')).map(
      (a) => (a as HTMLAnchorElement).href,
    ),
    images: Array.from(document.querySelectorAll('img')).map((img) => ({
      src: img.currentSrc || img.src,
      alt: img.getAttribute('alt'),
    })),
    regions: { header: region('header'), nav: region('nav'), footer: region('footer') },
    blocks,
    layout: layoutOf(main),
    wordCount: clean(main.textContent).split(' ').filter(Boolean).length,
  };

  /**
   * The page's layout as a short list of section tokens (`section.hero`, `div.card-grid`), for
   * telling templates apart. Looks through single wrappers (page builders nest the content in
   * one or two divs), and keeps class names without digits, which are usually generated.
   */
  function layoutOf(root: Element): string[] {
    let el = root;
    for (let i = 0; i < 4; i++) {
      const kids = Array.from(el.children).filter(
        (c) => !['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK'].includes(c.tagName),
      );
      if (kids.length !== 1) break;
      el = kids[0]!;
    }
    const out: string[] = [];
    for (const c of Array.from(el.children)) {
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK'].includes(c.tagName)) continue;
      const hint =
        c.getAttribute('data-component') ??
        c.getAttribute('data-block') ??
        (c.getAttribute('class') ?? '')
          .split(/\s+/)
          .filter((t) => t && !/\d/.test(t))
          .slice(0, 2)
          .join('.');
      const token = `${c.tagName.toLowerCase()}${hint ? `.${hint.slice(0, 60)}` : ''}`;
      // A run of the same section (cards, list items) is one token.
      if (out[out.length - 1] !== token) out.push(token);
      if (out.length >= 40) break;
    }
    return out;
  }
}

export type PageExtract = ReturnType<typeof extractPage>;

/**
 * A page's whole text in reading order, for migrating its copy: headings, paragraphs, list items,
 * accordion answers (collapsed ones too), table cells, and loose text in layout wrappers. Runs
 * inside the page, like extractPage.
 */
export function extractContent() {
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const BLOCK = 'h1,h2,h3,h4,h5,h6,p,li,dt,dd,blockquote,figcaption,summary,th,td,label,pre';
  const main = document.querySelector('main') ?? document.body;
  const out: { tag: string; text: string; href?: string }[] = [];
  let total = 0;
  const walk = (el: Element) => {
    if (total > 60_000) return;
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG'].includes(el.tagName)) return;
    if (el.matches(BLOCK)) {
      const text = clean(el.textContent);
      if (text) {
        const a = el.tagName === 'LI' ? el.querySelector('a[href]') : null;
        out.push({
          tag: el.tagName.toLowerCase(),
          text,
          ...(a ? { href: (a as HTMLAnchorElement).href } : {}),
        });
        total += text.length;
      }
      return;
    }
    // Text sitting directly in a wrapper (page builders often do this).
    const own = clean(
      Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent)
        .join(' '),
    );
    if (own.length >= 20) {
      out.push({ tag: el.tagName.toLowerCase(), text: own });
      total += own.length;
    }
    if (el.tagName === 'A' && clean(el.textContent) && !el.closest(BLOCK)) {
      const text = clean(el.textContent);
      if (text !== own) out.push({ tag: 'a', text, href: (el as HTMLAnchorElement).href });
    }
    for (const c of Array.from(el.children)) walk(c);
  };
  walk(main);
  return { content: out, truncated: total > 60_000 };
}
