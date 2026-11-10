import { createServer, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';

/**
 * A synthetic enterprise site for crawl tests, shaped like paylocity.com: thousands of pages in a
 * few big sections (articles, a glossary, product capabilities), a handful of one-off pages, a
 * sitemap index with a gzipped child, robots.txt with rules, paths spelled with a trailing slash
 * (the bare spelling redirects), a page built by scripts, a page that throttles, and a redirect.
 */
export interface LargeSite {
  origin: string;
  /** Requests served, by path. */
  hits: Map<string, number>;
  total(): number;
  /** Pages the sitemaps list. */
  listed: string[];
  close(): Promise<void>;
  /** Changes a section's lastmod (for the changed-only re-crawl). */
  touch(path: string): void;
}

export interface LargeSiteOptions {
  articles?: number;
  glossary?: number;
  capabilities?: number;
  /** Answer 429 this many times before serving /company/careers/. */
  throttleTimes?: number;
}

const shell = (title: string, main: string, desc = `${title} description`) =>
  `<!doctype html><html lang="en"><head><title>${title} | Acme HR</title><meta name="description" content="${desc}"></head><body>
<header><a href="/">Acme HR</a></header>
<nav><a href="/products/">Products</a> <a href="/resources/learn/">Learn</a> <a href="/company/about/">About</a></nav>
<main>${main}</main>
<footer>© Acme HR. <a href="/company/privacy/">Privacy</a> <a href="/private/admin/">Admin</a></footer>
</body></html>`;

const words = (n: number, seed: string) =>
  Array.from({ length: n }, (_, i) => `${seed}${i % 17}`).join(' ');

export async function largeSite(opts: LargeSiteOptions = {}): Promise<LargeSite> {
  const counts = {
    articles: opts.articles ?? 1200,
    glossary: opts.glossary ?? 900,
    capabilities: opts.capabilities ?? 880,
  };
  const lastmod = new Map<string, string>();
  const pages = new Map<string, () => string>();

  const article = (i: number) => () =>
    shell(
      `Article ${i}`,
      `<section class="article-hero"><h1>Article ${i}</h1><p>${words(30, 'lead')}</p></section>
       <article class="article-body"><h2>Why it matters</h2><p>${words(300 + (i % 50), 'body')}</p></article>
       <aside class="related"><h2>Related</h2><a href="/resources/learn/article-${(i + 1) % counts.articles}/">Next</a> <a href="/resources/learn/article-${(i + 7) % counts.articles}/?utm_source=x">More</a></aside>`,
    );
  const term = (i: number) => () =>
    shell(
      `Term ${i}`,
      `<div class="glossary-term"><h1>Term ${i}</h1><p>${words(80, 'def')}</p></div>
       <div class="glossary-nav"><a href="/resources/glossary/term-${(i + 1) % counts.glossary}/">Next term</a></div>`,
    );
  const capability = (i: number) => () =>
    shell(
      `Capability ${i}`,
      `<section class="product-hero"><h1>Capability ${i}</h1><p>${words(25, 'cap')}</p><img src="/media/cap-${i}.png" alt="Capability ${i}"></section>
       <section class="feature-grid"><h2>Features</h2><ul><li>${words(20, 'f')}</li></ul></section>
       <section class="cta-band"><h2>Get a demo</h2><a href="/company/contact/">Contact</a></section>`,
    );
  for (let i = 0; i < counts.articles; i++) pages.set(`/resources/learn/article-${i}/`, article(i));
  for (let i = 0; i < counts.glossary; i++) pages.set(`/resources/glossary/term-${i}/`, term(i));
  for (let i = 0; i < counts.capabilities; i++)
    pages.set(`/products/capabilities/cap-${i}/`, capability(i));
  const oneOff: Record<string, string> = {
    '/':
      '<section class="home-hero"><h1>HR for everyone</h1></section><section class="logos"><p>' +
      words(60, 'trust') +
      '</p></section>',
    '/products/':
      '<section class="listing"><h1>Products</h1><p>' +
      words(90, 'prod') +
      '</p><a href="/products/capabilities/cap-0/">First</a></section>',
    '/resources/learn/':
      '<section class="listing"><h1>Learn</h1><p>' + words(90, 'learn') + '</p></section>',
    '/company/about/':
      '<section class="about"><h1>About</h1><p>' + words(200, 'about') + '</p></section>',
    '/company/contact/':
      '<section class="contact"><h1>Contact</h1><form id="contact-form"><label>Email<input name="email"></label></form><p>' +
      words(40, 'c') +
      '</p></section>',
    '/company/privacy/':
      '<section class="legal"><h1>Privacy</h1><p>' + words(400, 'legal') + '</p></section>',
    '/company/careers/':
      '<section class="careers"><h1>Careers</h1><p>' + words(120, 'job') + '</p></section>',
  };
  for (const [path, main] of Object.entries(oneOff)) {
    const title = path === '/' ? 'Home' : path.split('/').filter(Boolean).pop()!;
    pages.set(path, () => shell(title, main));
  }
  // Built in the browser: empty as served.
  pages.set(
    '/company/app/',
    () =>
      `<!doctype html><html><head><title>App | Acme HR</title></head><body><main id="root"></main>
      <script>document.getElementById('root').innerHTML = '<section class="app"><h1>The app</h1><p>${words(150, 'app')}</p></section>';</script></body></html>`,
  );
  for (const path of pages.keys()) lastmod.set(path, '2026-10-01');

  const listed = [...pages.keys()].filter((p) => p !== '/company/app/');
  const hits = new Map<string, number>();
  let throttled = 0;

  let origin = '';
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const path = url.pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const send = (status: number, type: string, body: string | Buffer, headers = {}) =>
      res.writeHead(status, { 'content-type': type, ...headers }).end(body);
    if (path === '/robots.txt')
      return send(
        200,
        'text/plain',
        `User-agent: *\nDisallow: /private/\nDisallow: /*?print=\n\nUser-agent: BadBot\nDisallow: /\n\nSitemap: ${origin}/sitemap_index.xml\n`,
      );
    const urlset = (paths: string[]) =>
      `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths
        .map((p) => `<url><loc>${origin}${p}</loc><lastmod>${lastmod.get(p)}</lastmod></url>`)
        .join('')}</urlset>`;
    if (path === '/sitemap_index.xml')
      return send(
        200,
        'application/xml',
        `<?xml version="1.0"?><sitemapindex><sitemap><loc>${origin}/sitemap-pages.xml</loc></sitemap><sitemap><loc>${origin}/sitemap-resources.xml.gz</loc></sitemap></sitemapindex>`,
      );
    if (path === '/sitemap-pages.xml')
      return send(
        200,
        'application/xml',
        urlset(listed.filter((p) => !p.startsWith('/resources/'))),
      );
    if (path === '/sitemap-resources.xml.gz')
      return send(
        200,
        'application/x-gzip',
        gzipSync(urlset(listed.filter((p) => p.startsWith('/resources/')))),
      );
    if (path === '/old-page') return send(301, 'text/html', '', { location: '/company/about/' });
    if (path.startsWith('/media/')) return send(200, 'image/png', Buffer.from([0x89, 0x50]));
    // The site's spelling has a trailing slash: the bare one redirects.
    if (path !== '/' && !path.endsWith('/') && pages.has(`${path}/`))
      return send(301, 'text/html', '', { location: `${path}/${url.search}` });
    if (path === '/company/careers/' && throttled < (opts.throttleTimes ?? 0)) {
      throttled++;
      return send(429, 'text/plain', 'Too many requests', { 'retry-after': '0' });
    }
    const page = pages.get(path);
    if (!page) return send(404, 'text/html', '<h1>Not found</h1>');
    return send(200, 'text/html; charset=utf-8', page());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  // The home page links to the redirect and to a page only links reach.
  const home = pages.get('/')!;
  pages.set('/', () =>
    home().replace('</main>', '<a href="/old-page">Old</a> <a href="/company/app/">App</a></main>'),
  );
  return {
    origin,
    hits,
    total: () => [...hits.values()].reduce((a, b) => a + b, 0),
    listed,
    touch: (prefix) => {
      for (const p of lastmod.keys()) if (p.startsWith(prefix)) lastmod.set(p, '2026-11-07');
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
