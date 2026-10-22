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
    wordCount: clean(main.textContent).split(' ').filter(Boolean).length,
  };
}

export type PageExtract = ReturnType<typeof extractPage>;
