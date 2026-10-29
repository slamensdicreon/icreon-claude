/**
 * What a builder needs to rebuild a live page without its source code: the page's sections and
 * their markup, and the styles that make them look the way they do. Each function runs inside the
 * page (passed to `page.evaluate` as source), so it may use only the DOM and its arguments.
 */

/** A page's sections, in order: enough to choose one and ask for its markup. */
export interface SectionOutline {
  index: number;
  /** A selector that finds it again (`#id`, or tag and classes with :nth-of-type). */
  selector: string;
  tag: string;
  classes: string[];
  headings: string[];
  /** The first words of its text, to recognize it. */
  text: string;
  /** Size of its markup in characters. */
  size: number;
}

/**
 * The page's top-level sections: the header, the footer, and the children of `main` (or of the
 * body's main wrapper when there is no `main`), skipping scripts and invisible elements.
 */
export function outlineSections(): SectionOutline[] {
  const visible = (el: Element) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.height > 4;
  };
  const selectorOf = (el: Element): string => {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.body && parts.length < 4) {
      const tag = cur.tagName.toLowerCase();
      const parent: Element | null = cur.parentElement;
      const same = parent
        ? Array.from(parent.children).filter((c) => c.tagName === cur!.tagName)
        : [];
      const nth = same.length > 1 ? `:nth-of-type(${same.indexOf(cur) + 1})` : '';
      parts.unshift(cur.id ? `#${CSS.escape(cur.id)}` : `${tag}${nth}`);
      if (cur.id) break;
      cur = parent;
    }
    return parts.join(' > ');
  };
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META']);
  const main =
    document.querySelector('main') ??
    Array.from(document.body.children)
      .filter((c) => !skip.has(c.tagName))
      .sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0] ??
    document.body;
  // A wrapper with a single child (main > div.page > sections) is looked through.
  let root: Element = main;
  while (root.children.length === 1 && root.firstElementChild!.children.length > 1)
    root = root.firstElementChild!;
  const header = document.querySelector('header');
  const footer = document.querySelector('footer');
  const els = [
    ...(header && !root.contains(header) ? [header] : []),
    ...Array.from(root.children).filter((c) => !skip.has(c.tagName)),
    ...(footer && !root.contains(footer) ? [footer] : []),
  ].filter(visible);
  return els.map((el, index) => ({
    index,
    selector: selectorOf(el),
    tag: el.tagName.toLowerCase(),
    classes: Array.from(el.classList).slice(0, 8),
    headings: Array.from(el.querySelectorAll('h1, h2, h3'))
      .map((h) => (h.textContent ?? '').trim().replace(/\s+/g, ' '))
      .filter(Boolean)
      .slice(0, 4),
    text: (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 120),
    size: el.outerHTML.length,
  }));
}

/**
 * One element's markup, cleaned for rebuilding: class names and structure kept; scripts,
 * styles, event handlers, tracking attributes and inline data images removed; long text kept.
 */
export function cleanMarkup(
  selector: string,
  maxChars: number,
): {
  found: boolean;
  html: string;
  truncated: boolean;
} {
  const el = document.querySelector(selector);
  if (!el) return { found: false, html: '', truncated: false };
  const copy = el.cloneNode(true) as Element;
  copy
    .querySelectorAll('script, style, noscript, template, iframe[src*="googletagmanager"]')
    .forEach((n) => n.remove());
  const keep =
    /^(class|id|href|src|srcset|alt|title|role|type|name|for|placeholder|value|aria-[\w-]+|data-(toggle|target|bs-[\w-]+))$/;
  const walk = (n: Element) => {
    for (const a of Array.from(n.attributes)) {
      if (!keep.test(a.name)) n.removeAttribute(a.name);
      else if ((a.name === 'src' || a.name === 'srcset') && a.value.startsWith('data:'))
        n.setAttribute(a.name, 'data:…');
    }
    // An inline SVG's path data says nothing a builder can use; its size and classes do.
    if (n.tagName.toLowerCase() === 'path') n.setAttribute('d', '…');
    Array.from(n.children).forEach(walk);
  };
  walk(copy);
  const html = copy.outerHTML.replace(/\n\s*\n+/g, '\n');
  return { found: true, html: html.slice(0, maxChars), truncated: html.length > maxChars };
}

const PROPS = [
  'display',
  'position',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'text-transform',
  'text-align',
  'color',
  'background-color',
  'background-image',
  'padding',
  'margin',
  'border',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-radius',
  'box-shadow',
  'width',
  'max-width',
  'height',
  'gap',
  'grid-template-columns',
  'flex-direction',
  'justify-content',
  'align-items',
  'list-style-type',
  'clip-path',
  'transform',
  'opacity',
  'content',
];

/** Computed styles for chosen selectors, the page's design tokens, and its stylesheets. */
export function readStyles(
  selectors: string[],
  props: string[],
): {
  elements: { selector: string; matches: number; styles: Record<string, string> | null }[];
  tokens: {
    fonts: { family: string; uses: number }[];
    colors: { value: string; uses: number }[];
    backgrounds: { value: string; uses: number }[];
    fontSizes: { value: string; uses: number }[];
    customProperties: Record<string, string>;
    breakpoints: string[];
  };
  stylesheets: { href: string | null; rules: number | null }[];
} {
  const defaults: Record<string, string> = {
    'background-image': 'none',
    'box-shadow': 'none',
    'clip-path': 'none',
    transform: 'none',
    'letter-spacing': 'normal',
    'text-transform': 'none',
    border: '0px none rgb(0, 0, 0)',
    opacity: '1',
    content: 'normal',
  };
  const elements = selectors.map((selector) => {
    // querySelectorAll refuses pseudo-elements: read ::before/::after from their element.
    const pseudo = /::?(before|after)\s*$/i.exec(selector);
    const base = pseudo ? selector.slice(0, pseudo.index) : selector;
    let all: Element[] = [];
    try {
      all = Array.from(document.querySelectorAll(base));
    } catch {
      return { selector, matches: 0, styles: null };
    }
    const el = all[0];
    if (!el) return { selector, matches: 0, styles: null };
    const cs = getComputedStyle(el, pseudo ? `::${pseudo[1]!.toLowerCase()}` : null);
    if (pseudo && cs.getPropertyValue('content') === 'none')
      return { selector, matches: 0, styles: null };
    const styles: Record<string, string> = {};
    for (const p of props) {
      const v = cs.getPropertyValue(p);
      if (!v || v === defaults[p]) continue;
      // Sides only when they differ (the shorthand is empty then), and only drawn ones.
      if (
        /^border-(top|right|bottom|left)$/.test(p) &&
        (cs.getPropertyValue('border') || /^0px/.test(v))
      )
        continue;
      styles[p] = v;
    }
    return { selector, matches: all.length, styles };
  });

  const count = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const fonts = new Map<string, number>();
  const colors = new Map<string, number>();
  const backgrounds = new Map<string, number>();
  const sizes = new Map<string, number>();
  const sample = Array.from(document.querySelectorAll('body *')).slice(0, 4000);
  for (const el of sample) {
    if (!(el instanceof HTMLElement) || !el.offsetParent) continue;
    const cs = getComputedStyle(el);
    const hasText = Array.from(el.childNodes).some(
      (n) => n.nodeType === 3 && n.textContent?.trim(),
    );
    if (hasText) {
      count(fonts, cs.fontFamily.split(',')[0]!.replace(/["']/g, '').trim());
      count(colors, cs.color);
      count(sizes, cs.fontSize);
    }
    const bg = cs.backgroundColor;
    if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') count(backgrounds, bg);
  }
  const top = (m: Map<string, number>, n: number) =>
    Array.from(m)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n);

  const customProperties: Record<string, string> = {};
  const breakpoints = new Set<string>();
  const stylesheets: { href: string | null; rules: number | null }[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | null = null;
    try {
      rules = sheet.cssRules;
    } catch {
      rules = null; // Another origin's sheet: its rules can't be read here.
    }
    stylesheets.push({ href: sheet.href, rules: rules ? rules.length : null });
    if (!rules) continue;
    const visit = (list: CSSRuleList) => {
      for (const r of Array.from(list)) {
        if (r instanceof CSSMediaRule) {
          breakpoints.add(r.conditionText);
          visit(r.cssRules);
        } else if (
          r instanceof CSSStyleRule &&
          (r.selectorText === ':root' || r.selectorText === 'html')
        ) {
          for (const p of Array.from(r.style))
            if (p.startsWith('--') && Object.keys(customProperties).length < 80)
              customProperties[p] = r.style.getPropertyValue(p).trim();
        }
      }
    };
    visit(rules);
  }
  return {
    elements,
    tokens: {
      fonts: top(fonts, 6).map(([family, uses]) => ({ family, uses })),
      colors: top(colors, 10).map(([value, uses]) => ({ value, uses })),
      backgrounds: top(backgrounds, 10).map(([value, uses]) => ({ value, uses })),
      fontSizes: top(sizes, 12).map(([value, uses]) => ({ value, uses })),
      customProperties,
      breakpoints: Array.from(breakpoints)
        .filter((b) => /width/.test(b))
        .slice(0, 20),
    },
    stylesheets: stylesheets.slice(0, 40),
  };
}

export const STYLE_PROPS = PROPS;
