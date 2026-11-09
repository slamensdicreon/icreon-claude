/// <reference lib="dom" />
/**
 * A site's thumbnail for the Sitecore Sites dashboard, made from its own brand: the logo, colours,
 * typeface, headline and hero photo of its source home page, set in one design (a field with the
 * logo and headline, the photo behind a diagonal edge in the brand's accent). Each part can be
 * given instead of read, when the page gets it wrong.
 */

/** What a brand looks like, as read from its home page. Runs inside the page: self-contained. */
export function readBrand() {
  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width > 8 && r.height > 8 && r.top < 400;
  };
  const bgOf = (el: Element | null): string => {
    for (let e = el; e; e = e.parentElement) {
      const c = getComputedStyle(e).backgroundColor;
      if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c;
    }
    return 'rgb(255, 255, 255)';
  };
  const abs = (u: string | null | undefined) => {
    try {
      return u ? new URL(u, location.href).href : null;
    } catch {
      return null;
    }
  };
  // The logo: an image or SVG in the header, or one called a logo, near the top of the page.
  const candidates = Array.from(
    document.querySelectorAll(
      'header img, header svg, [class*=logo] img, [class*=logo] svg, img[class*=logo], img[alt*=logo i], img[src*=logo i], a[href="/"] img, a[href="/"] svg',
    ),
  ).filter(visible);
  const el = candidates[0] ?? null;
  let logo: { src?: string; svg?: string; ratio: number } | null = null;
  if (el) {
    const r = el.getBoundingClientRect();
    if (el.tagName.toLowerCase() === 'svg') {
      const copy = el.cloneNode(true) as SVGElement;
      if (!copy.getAttribute('viewBox')) copy.setAttribute('viewBox', `0 0 ${r.width} ${r.height}`);
      // Paint that comes from CSS (currentColor) is fixed to what the page showed.
      copy.setAttribute('color', getComputedStyle(el).color);
      copy.removeAttribute('width');
      copy.removeAttribute('height');
      logo = { svg: new XMLSerializer().serializeToString(copy), ratio: r.width / r.height };
    } else {
      const img = el as HTMLImageElement;
      logo = { src: img.currentSrc || img.src, ratio: r.width / r.height };
    }
  }
  // Colours the page uses, by how much: backgrounds and text of the parts that carry the brand.
  const count = new Map<string, number>();
  for (const e of Array.from(
    document.querySelectorAll(
      'a, button, [class*=btn], [class*=button], header, nav, h1, h2, footer, section',
    ),
  ).slice(0, 800)) {
    const s = getComputedStyle(e);
    for (const c of [s.backgroundColor, s.color, s.borderTopColor])
      if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) count.set(c, (count.get(c) ?? 0) + 1);
  }
  const h1 = document.querySelector('h1');
  const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute('content');
  // The hero photo: the largest picture near the top, an image or a CSS background.
  const photos: { src: string; area: number }[] = [];
  for (const e of Array.from(document.querySelectorAll('img, section, div, picture, figure')).slice(
    0,
    1500,
  )) {
    const r = e.getBoundingClientRect();
    if (r.top > 900 || r.width < 400 || r.height < 220) continue;
    let src: string | null = null;
    if (e.tagName === 'IMG')
      src = (e as HTMLImageElement).currentSrc || (e as HTMLImageElement).src;
    else {
      const m = /url\(["']?([^"')]+)["']?\)/.exec(getComputedStyle(e).backgroundImage);
      src = m ? m[1]! : null;
    }
    if (!src || /\.svg(\?|$)/i.test(src) || /logo/i.test(src)) continue;
    photos.push({ src, area: r.width * r.height });
  }
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  return {
    logo: logo?.src ? { ...logo, src: abs(logo.src)! } : logo,
    headerBackground: bgOf(el ?? document.querySelector('header')),
    colors: [...count]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 24)
      .map(([c, n]) => ({ c, n })),
    headline:
      clean(h1?.textContent).slice(0, 120) ||
      clean(document.title)
        .split(/\s[|–-]\s/)[0]!
        .slice(0, 120),
    headlineColor: h1 ? getComputedStyle(h1).color : null,
    font: (getComputedStyle(h1 ?? document.body).fontFamily.split(',')[0] ?? '')
      .replace(/["']/g, '')
      .trim(),
    photos: [
      ...new Set(
        [...photos.sort((a, b) => b.area - a.area).map((p) => abs(p.src)), abs(ogImage)].filter(
          (u): u is string => !!u,
        ),
      ),
    ].slice(0, 5),
    description: clean(
      document.querySelector('meta[name="description"]')?.getAttribute('content'),
    ).slice(0, 200),
  };
}

export type BrandCues = ReturnType<typeof readBrand>;

export type Motif = 'none' | 'route' | 'grid' | 'lines';

export interface ThumbnailDesign {
  tone: 'dark' | 'light';
  field: string;
  ink: string;
  accent: string;
  font: string;
  headline: string;
  /** Words of the headline set in the accent colour. */
  emphasis: string | null;
  eyebrow: string | null;
  logo: { src?: string; svg?: string; ratio: number } | null;
  /** Shown white on a dark field (a logo made for a light header). */
  logoWhite: boolean;
  /** Text in place of a logo the page didn't have. */
  wordmark: string | null;
  /** Photos to try, best first: the first that loads is used. */
  photos: string[];
  motif: Motif;
  chip: string | null;
}

// --- colour ------------------------------------------------------------------------------------

type RGB = [number, number, number];
export function parseColor(c: string | null | undefined): RGB | null {
  if (!c) return null;
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/.exec(c);
  if (m)
    return m[4] !== undefined && Number(m[4]) < 0.5
      ? null
      : [Number(m[1]), Number(m[2]), Number(m[3])];
  const h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (!h) return null;
  const x =
    h[1]!.length === 3
      ? h[1]!
          .split('')
          .map((d) => d + d)
          .join('')
      : h[1]!;
  return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)];
}
const hex = ([r, g, b]: RGB) =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
/** Relative luminance (WCAG). */
export function luminance([r, g, b]: RGB): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export const contrast = (a: RGB, b: RGB) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};
const saturation = ([r, g, b]: RGB) => {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  return max === 0 ? 0 : (max - min) / max;
};
const mix = (a: RGB, b: RGB, t: number): RGB =>
  [0, 1, 2].map((i) => Math.round(a[i]! * (1 - t) + b[i]! * t)) as RGB;

/**
 * The design, from the page's cues and anything given instead. The field takes the tone the logo
 * was made for (its header's background), so the logo shows as the brand intends; the accent is
 * the page's most used saturated colour that stands out on that field.
 */
export function designFrom(
  cues: BrandCues,
  given: Partial<ThumbnailDesign> & { host: string },
): ThumbnailDesign {
  const colors = cues.colors
    .map((x) => ({ rgb: parseColor(x.c), n: x.n }))
    .filter((x): x is { rgb: RGB; n: number } => !!x.rgb);
  const header = parseColor(cues.headerBackground) ?? [255, 255, 255];
  const darkest = colors
    .filter((x) => luminance(x.rgb) < 0.08 && saturation(x.rgb) > 0.25)
    .sort((a, b) => b.n - a.n)[0];
  // A brand with a deep colour of its own (a navy, a forest green) wears it as a dark field; one
  // whose header is dark keeps that; the rest stay light, as their logos were made for.
  const tone =
    given.tone ?? (luminance(header) < 0.35 || (darkest && darkest.n >= 3) ? 'dark' : 'light');
  const field: RGB =
    parseColor(given.field) ??
    (tone === 'dark'
      ? luminance(header) < 0.35
        ? header
        : (darkest?.rgb ?? [17, 17, 17])
      : luminance(header) > 0.85
        ? header
        : [255, 255, 255]);
  const ink: RGB =
    parseColor(given.ink) ??
    (tone === 'dark'
      ? [255, 255, 255]
      : (() => {
          const h = parseColor(cues.headlineColor);
          return h && contrast(h, field) >= 4.5 ? h : (darkest?.rgb ?? [26, 26, 26]);
        })());
  const accent: RGB =
    parseColor(given.accent) ??
    colors
      .filter((x) => saturation(x.rgb) > 0.45 && contrast(x.rgb, field) >= 1.5)
      .sort((a, b) => b.n - a.n)[0]?.rgb ??
    (tone === 'dark' ? mix(field, [255, 255, 255], 0.65) : mix(ink, field, 0.15));
  let headline = (given.headline ?? cues.headline ?? given.host).trim();
  // A headline set in capitals by CSS or by hand reads as shouting at thumbnail size.
  if (!given.headline && headline.length > 16 && headline === headline.toUpperCase())
    headline = headline.charAt(0) + headline.slice(1).toLowerCase();
  // A logo made for a light header is shown white on a dark field.
  const logoWhite = given.logoWhite ?? (tone === 'dark' && luminance(header) >= 0.35);
  return {
    tone,
    field: hex(field),
    ink: hex(ink),
    accent: hex(accent),
    font: given.font ?? (cues.font || 'Montserrat'),
    headline,
    emphasis: given.emphasis ?? null,
    eyebrow: given.eyebrow ?? null,
    logo: given.logo ?? cues.logo,
    logoWhite,
    wordmark:
      given.wordmark ?? (cues.logo ? null : given.host.replace(/^www\./, '').split('.')[0]!),
    photos: given.photos ?? cues.photos,
    motif: given.motif ?? 'none',
    chip: given.chip ?? null,
  };
}

// --- the page that is screenshotted ------------------------------------------------------------

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function motifSvg(m: Motif, color: string): string {
  if (m === 'route')
    return `<svg class="motif" viewBox="0 0 560 640"><path d="M-20 262 C 110 252, 190 214, 300 222 S 450 186, 560 150" fill="none" stroke="${color}" stroke-width="2" opacity=".5"/><g fill="${color}" opacity=".9"><circle cx="300" cy="222" r="5"/><circle cx="446" cy="190" r="5"/></g></svg>`;
  if (m === 'grid') {
    let g = '';
    for (let x = 0; x < 560; x += 40) g += `<line x1="${x}" y1="0" x2="${x}" y2="640"/>`;
    for (let y = 0; y < 680; y += 40) g += `<line x1="0" y1="${y}" x2="560" y2="${y}"/>`;
    return `<svg class="motif" viewBox="0 0 560 640"><g stroke="${color}" stroke-width="1" opacity=".1">${g}</g></svg>`;
  }
  if (m === 'lines') {
    let l = '';
    for (let i = 0; i < 14; i++)
      l += `<line x1="${-40 + i * 36}" y1="660" x2="${180 + i * 36}" y2="-20" stroke="${color}" stroke-width="${i % 3 ? 1.5 : 3}" opacity="${0.1 + (i % 4) * 0.05}"/>`;
    return `<svg class="motif" viewBox="0 0 560 640">${l}</svg>`;
  }
  return '';
}

/** The headline with its emphasised words in the accent colour. */
function headlineHtml(d: ThumbnailDesign): string {
  const h = esc(d.headline);
  if (!d.emphasis) return h;
  const e = esc(d.emphasis);
  const at = h.toLowerCase().indexOf(e.toLowerCase());
  return at < 0
    ? h
    : `${h.slice(0, at)}<em>${h.slice(at, at + e.length)}</em>${h.slice(at + e.length)}`;
}

/** An SVG from someone else's page, without what could run: scripts, handlers, embedded HTML. */
export function safeSvg(svg: string): string {
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href\s*=\s*["'])\s*javascript:[^"']*/gi, '$1#');
}

export function thumbnailHtml(d: ThumbnailDesign): string {
  const family = d.font.replace(/[^A-Za-z0-9 ]/g, '').trim();
  const fonts = [family, 'Montserrat']
    .filter(Boolean)
    .map(
      (f) =>
        `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(f)}:wght@500;700;800&display=block">`,
    )
    .join('');
  const logoH = d.logo
    ? Math.round(Math.max(48, Math.min(120, 300 / Math.max(d.logo.ratio, 0.5))))
    : 0;
  const logo = d.logo?.svg
    ? `<div class="logo svg${d.logoWhite ? ' white' : ''}" style="height:${logoH}px;width:${Math.round(logoH * d.logo.ratio)}px">${safeSvg(d.logo.svg)}</div>`
    : d.logo?.src
      ? `<img class="logo${d.logoWhite ? ' white' : ''}" style="height:${logoH}px" src="${esc(d.logo.src)}" alt="">`
      : `<div class="wordmark">${esc(d.wordmark ?? '')}</div>`;
  const blooms = `<div class="bloom" style="--c:${d.accent};left:62%;top:-20%"></div><div class="bloom" style="--c:${d.ink};left:78%;top:38%;opacity:.5"></div>`;
  const photo = d.photos.length
    ? `<div class="photo" id="photo" hidden></div><div class="edge" id="edge" hidden></div><div id="blooms">${blooms}</div>`
    : blooms;
  const long = d.headline.length > 48;
  return `<!doctype html><html><head><meta charset="utf-8">${fonts}<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1200px;height:640px;overflow:hidden}
.t{position:relative;width:1200px;height:640px;background:${d.field};color:${d.ink};font-family:'${family}','Montserrat',system-ui,sans-serif;overflow:hidden}
.photo{position:absolute;inset:0 0 0 auto;width:56%;background-size:cover;background-position:center;clip-path:polygon(18% 0,100% 0,100% 100%,0 100%)}
.photo::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,${d.field} 0%,color-mix(in srgb,${d.field} 55%,transparent) 22%,transparent 55%)}
.dark .photo::before{content:"";position:absolute;inset:0;background:linear-gradient(180deg,transparent 55%,rgba(0,0,0,.35))}
.edge{position:absolute;top:0;bottom:0;left:522px;width:10px;background:${d.accent};transform:skewX(10.7deg);transform-origin:bottom left}
.motif{position:absolute;left:0;top:0;width:560px;height:640px}
.bloom{position:absolute;width:560px;height:560px;border-radius:50%;background:radial-gradient(circle,color-mix(in srgb,var(--c) 40%,transparent),transparent 65%);filter:blur(10px)}
.copy{position:absolute;left:64px;top:60px;bottom:60px;width:430px;display:flex;flex-direction:column;justify-content:space-between}
.logo{max-width:360px;object-fit:contain;object-position:left center;align-self:flex-start}
.logo.svg svg{width:100%;height:100%;display:block}
.white{filter:brightness(0) invert(1)}
.wordmark{font-weight:800;font-size:58px;letter-spacing:-.02em;color:${d.accent};line-height:1}
.rule{width:72px;height:6px;background:${d.accent};margin-bottom:26px}
.eyebrow{font:700 17px/1.3 'Montserrat',system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;opacity:.78;margin-bottom:18px}
h1{font-weight:800;font-size:${long ? 46 : 54}px;line-height:1.04;letter-spacing:-.02em;text-wrap:balance}
[hidden]{display:none!important}
h1 em{font-style:normal;color:${d.accent}}
.chip{position:absolute;right:36px;top:32px;background:${d.accent};color:#fff;font:800 18px/1 'Montserrat',system-ui,sans-serif;letter-spacing:.14em;text-transform:uppercase;padding:12px 16px}
.grain{position:absolute;inset:0;opacity:.05;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")}
</style></head><body><div class="t ${d.tone}">
${motifSvg(d.motif, d.accent)}${photo}<div class="grain"></div>${d.chip ? `<div class="chip">${esc(d.chip)}</div>` : ''}
<div class="copy">${logo}<div><div class="rule"></div>${d.eyebrow ? `<div class="eyebrow">${esc(d.eyebrow)}</div>` : ''}<h1>${headlineHtml(d)}</h1></div></div>
</div>
<script>
// The first photo that loads, and a headline that fits: then the page is ready for its picture.
(async () => {
  const photos = ${JSON.stringify(d.photos).replace(/</g, '\\u003c')};
  for (const src of photos) {
    const ok = await new Promise((r) => { const i = new Image(); i.onload = () => r(i.naturalWidth >= 400); i.onerror = () => r(false); i.src = src; setTimeout(() => r(false), 8000); });
    if (ok) {
      const p = document.getElementById('photo');
      p.style.backgroundImage = 'url("' + src.replace(/"/g, '%22') + '")';
      p.hidden = false; document.getElementById('edge').hidden = false;
      document.getElementById('blooms').remove();
      break;
    }
  }
  await document.fonts.ready;
  const h = document.querySelector('h1');
  let size = parseFloat(getComputedStyle(h).fontSize);
  while (size > 30 && (h.scrollWidth > h.clientWidth + 1 || h.getBoundingClientRect().height > 250)) {
    size -= 2; h.style.fontSize = size + 'px';
  }
  window.__ready = true;
})();
</script></body></html>`;
}
