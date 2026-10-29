import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryEventStore } from '@lw/events';
import { loadPlaybook } from '@lw/playbook-sdk';
import {
  LocalBlobStore,
  MemoryIdempotencyStore,
  TokenBucketLimiter,
  ToolGateway,
} from '@lw/tool-gateway';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BrowserToolServer,
  EgressProxy,
  GuardedBrowser,
  isBlockedSubresource,
  isPrivateAddress,
} from '../src';

const SITE = fileURLToPath(new URL('./fixture-site', import.meta.url));
const PLAYBOOK = fileURLToPath(new URL('../../../playbooks/sitecoreai-migration', import.meta.url));
const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
};

let http: Server;
let origin: string;
let blobDir: string;
let browser: BrowserToolServer;
let guarded: GuardedBrowser;

beforeAll(async () => {
  http = createServer(async (req, res) => {
    let path = new URL(req.url!, 'http://x').pathname;
    // A redirect, and a file only a real browser gets (a firewall turning away bare clients).
    if (path === '/moved/hero.png')
      return res.writeHead(302, { location: '/media/hero.png' }).end();
    if (path === '/browser-only/hero.png') {
      if (!String(req.headers['user-agent']).includes('HeadlessChrome'))
        return res.writeHead(403).end('Forbidden');
      path = '/media/hero.png';
    }
    const candidates = path === '/' ? ['index.html'] : [path.slice(1), `${path.slice(1)}.html`];
    for (const c of candidates) {
      try {
        let body: Buffer | string = await readFile(join(SITE, c));
        if (c === 'sitemap.xml') body = body.toString().replaceAll('__ORIGIN__', origin);
        res.writeHead(200, { 'content-type': TYPES[extname(c)] ?? 'text/html' });
        return res.end(body);
      } catch {
        /* try the next candidate */
      }
    }
    res.writeHead(404, { 'content-type': 'text/html' }).end('<h1>Not found</h1>');
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const addr = http.address();
  origin = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  blobDir = await mkdtemp(join(tmpdir(), 'lw-blobs-'));
  guarded = new GuardedBrowser({ allowPrivateNetworks: true });
  browser = new BrowserToolServer({
    policy: () => ({ allowedHosts: ['127.0.0.1'], allowPrivateNetworks: true }),
    blobs: new LocalBlobStore(blobDir),
    browser: guarded,
    // As if the Blueprint pointed media at another host.
    assetHosts: async () => ['localhost'],
  });
}, 60_000);

afterAll(async () => {
  await browser.close();
  await guarded.close();
  await new Promise((r) => http.close(r));
});

const ctx = { projectId: 'p1', token: 'unused' };

describe('crawl', () => {
  it('inventories the site from links and the sitemap, and explains what it left out', async () => {
    const r = await browser.call('crawl', { url: `${origin}/` }, ctx);
    expect(r.code).toBe(200);
    const body = r.body as {
      pages: {
        url: string;
        title: string;
        headings: { level: number; text: string }[];
        images: { alt: string | null }[];
        wordCount: number;
      }[];
      excluded: { url: string; reason: string }[];
      repeatedRegions: { region: string; pages: number; text: string }[];
      truncated: boolean;
    };
    const paths = body.pages.map((p) => new URL(p.url).pathname).sort();
    expect(paths).toEqual([
      '/',
      '/about',
      '/blog/post-1',
      '/contact',
      '/hidden',
      '/privacy',
      '/services',
    ]);
    expect(body.excluded).toEqual(
      expect.arrayContaining([
        { url: `${origin}/brochure.pdf`, reason: 'not a page (file download)' },
        { url: `${origin}/missing`, reason: 'HTTP 404' },
      ]),
    );
    expect(body.pages.some((p) => p.url.includes('elsewhere.example'))).toBe(false);
    expect(body.repeatedRegions.map((r) => r.region).sort()).toEqual(['footer', 'header', 'nav']);
    expect(body.repeatedRegions.every((r) => r.pages === 7)).toBe(true);

    const home = body.pages.find((p) => new URL(p.url).pathname === '/')!;
    expect(home.title).toBe('Home | Acme');
    expect(home.headings).toEqual([
      { level: 1, text: 'Widgets for everyone' },
      { level: 2, text: 'New this season' },
    ]);
    const about = body.pages.find((p) => p.url.endsWith('/about'))!;
    expect(about.images).toEqual([expect.objectContaining({ alt: null })]); // missing alt text, for review
    expect(body.truncated).toBe(false);
    expect(r.summary).toMatch(
      /^Crawled 7 pages from http:\/\/127\.0\.0\.1:\d+; 2 excluded; 3 repeated regions$/,
    );
  }, 60_000);

  it('stops at maxPages and says the inventory is incomplete', async () => {
    const r = await browser.call('crawl', { url: `${origin}/`, maxPages: 2 }, ctx);
    const body = r.body as { pages: unknown[]; truncated: boolean };
    expect(body.pages).toHaveLength(2);
    expect(body.truncated).toBe(true);
  }, 60_000);
});

describe('a browser that closed', () => {
  it('launches Chromium again instead of failing every call', async () => {
    expect((await browser.call('crawl', { url: `${origin}/` }, ctx)).code).toBe(200);
    // As when the worker restarts, or Chromium crashes, under a running task.
    const running = (guarded as unknown as { browser: Promise<{ close(): Promise<void> }> })
      .browser;
    await (await running).close();
    const again = await browser.call('crawl', { url: `${origin}/` }, ctx);
    expect(again.code).toBe(200);
  }, 60_000);
});

describe('page.markup, page.styles', () => {
  it('outlines a page’s sections, looking through a single wrapper', async () => {
    const r = await browser.call('page.markup', { url: `${origin}/styled` }, ctx);
    const { sections } = r.body as {
      sections: { selector: string; tag: string; classes: string[]; headings: string[] }[];
    };
    expect(sections.map((s) => [s.tag, s.classes[0] ?? null, s.headings[0] ?? null])).toEqual([
      ['header', 'site-header', null],
      ['section', 'hero', 'Built to last'],
      ['section', 'cards', 'What we do'],
      ['footer', null, null],
    ]);
  }, 30_000);

  it('returns one section’s markup without scripts, handlers or tracking', async () => {
    const outline = await browser.call('page.markup', { url: `${origin}/styled` }, ctx);
    const hero = (outline.body as { sections: { selector: string }[] }).sections[1]!;
    const r = await browser.call(
      'page.markup',
      { url: `${origin}/styled`, selector: hero.selector },
      ctx,
    );
    const { html, truncated } = r.body as { html: string; truncated: boolean };
    expect(r.code).toBe(200);
    expect(html).toContain('<section class="hero">');
    expect(html).toContain('<h1>Built to last</h1>');
    expect(html).not.toMatch(/script|onclick|data-track/);
    expect(truncated).toBe(false);
    const missing = await browser.call(
      'page.markup',
      { url: `${origin}/styled`, selector: '.nope' },
      ctx,
    );
    expect(missing.code).toBe(404);
  }, 30_000);

  it('reads computed styles and design tokens', async () => {
    const r = await browser.call(
      'page.styles',
      {
        url: `${origin}/styled`,
        selectors: [
          '.hero',
          '.hero h1',
          '.cards',
          '.nope',
          'footer',
          '.hero::before',
          '.cards::after',
        ],
      },
      ctx,
    );
    const body = r.body as {
      elements: { selector: string; matches: number; styles: Record<string, string> | null }[];
      tokens: {
        fonts: { family: string }[];
        customProperties: Record<string, string>;
        breakpoints: string[];
      };
    };
    const [hero, h1, cards, nope, footer, before, after] = body.elements;
    expect(hero!.styles).toMatchObject({
      'background-color': 'rgb(228, 0, 43)',
      padding: '48px 24px',
    });
    expect(hero!.styles!['clip-path']).toContain('polygon');
    expect(h1!.styles).toMatchObject({ 'font-size': '40px', 'font-weight': '700' });
    expect(cards).toMatchObject({ matches: 1, styles: { display: 'grid', gap: '16px' } });
    expect(nope).toEqual({ selector: '.nope', matches: 0, styles: null });
    // One drawn side, which the border shorthand can't express.
    expect(footer!.styles).toMatchObject({ 'border-top': '1px solid rgb(234, 234, 234)' });
    expect(footer!.styles!['border-bottom']).toBeUndefined();
    expect(before).toMatchObject({
      matches: 1,
      styles: { 'background-color': 'rgba(204, 24, 0, 0.03)', opacity: '0.5' },
    });
    expect(after).toEqual({ selector: '.cards::after', matches: 0, styles: null });
    expect(body.tokens.fonts[0]!.family).toBe('Georgia');
    expect(body.tokens.customProperties).toEqual({ '--brand': '#e4002b', '--ink': '#1a1a1a' });
    expect(body.tokens.breakpoints).toEqual(['(max-width: 768px)']);
  }, 30_000);
});

describe('snapshot, screenshot, fetch.asset', () => {
  it('captures one page’s blocks in order', async () => {
    const r = await browser.call('snapshot', { url: `${origin}/` }, ctx);
    const page = r.body as { blocks: { tag: string; className: string; heading: string | null }[] };
    expect(page.blocks.slice(0, 2)).toEqual([
      expect.objectContaining({
        tag: 'section',
        className: 'hero',
        heading: 'Widgets for everyone',
      }),
      expect.objectContaining({ tag: 'section', className: 'promo', heading: 'New this season' }),
    ]);
  }, 30_000);

  it('gives a snapshot the page’s whole text, collapsed answers included', async () => {
    const r = await browser.call('snapshot', { url: `${origin}/faq-long` }, ctx);
    const page = r.body as {
      blocks: { text: string }[];
      content: { tag: string; text: string; href?: string }[];
    };
    const answer = page.content.find((c) => c.tag === 'p')!;
    expect(answer.text.length).toBeGreaterThan(900);
    expect(page.blocks[0]!.text.length).toBeLessThanOrEqual(500);
    expect(page.content.map((c) => c.tag)).toEqual(['h2', 'summary', 'p', 'div', 'li']);
    expect(page.content.at(-1)).toMatchObject({
      text: 'Florida contact: 555-0100',
      href: `${origin}/contact`,
    });
  }, 30_000);

  it('reads the copy from the page as served when its scripts take it out', async () => {
    const r = await browser.call('snapshot', { url: `${origin}/scripted` }, ctx);
    const page = r.body as { content: { tag: string; text: string }[]; from?: string };
    expect(page.from).toBe('served-html');
    expect(page.content.filter((c) => c.tag === 'h3')).toHaveLength(8);
    expect(page.content.find((c) => c.tag === 'p')!.text).toContain('Your health is important');
    // A page whose scripts leave its copy alone is read as rendered.
    const plain = await browser.call('snapshot', { url: `${origin}/faq-long` }, ctx);
    expect((plain.body as { from?: string }).from).toBeUndefined();
  }, 30_000);

  it('screenshots at three breakpoints and stores the images', async () => {
    const r = await browser.call('screenshot', { url: `${origin}/services` }, ctx);
    const shots = (
      r.body as { shots: { breakpoint: string; width: number; sha256: string; ref: string }[] }
    ).shots;
    expect(shots.map((s) => [s.breakpoint, s.width])).toEqual([
      ['desktop', 1440],
      ['tablet', 834],
      ['phone', 390],
    ]);
    for (const s of shots) {
      const png = await readFile(join(blobDir, 'p1', 'screenshots', `${s.sha256}.png`));
      expect(png.subarray(1, 4).toString()).toBe('PNG');
      expect(png.readUInt32BE(16)).toBe(s.width); // IHDR width = viewport width
      expect(s.ref).toBe(`blob://p1/screenshots/${s.sha256}.png`);
    }
  }, 60_000);

  it('follows redirects, asks a real browser when refused, and takes the Blueprint’s media hosts', async () => {
    const moved = await browser.call('fetch.asset', { url: `${origin}/moved/hero.png` }, ctx);
    expect(moved).toMatchObject({ code: 200, body: { url: `${origin}/media/hero.png` } });
    const guardedFile = await browser.call(
      'fetch.asset',
      { url: `${origin}/browser-only/hero.png` },
      ctx,
    );
    expect(guardedFile).toMatchObject({ code: 200, body: { contentType: 'image/png' } });
    const cdn = await browser.call(
      'fetch.asset',
      { url: origin.replace('127.0.0.1', 'localhost') + '/media/hero.png' },
      ctx,
    );
    expect(cdn.code).toBe(200);
    // Elsewhere is refused as the agent's to correct, not as an access problem.
    const other = await browser.call('fetch.asset', { url: 'http://elsewhere.example/a.png' }, ctx);
    expect(other.code).toBe(422);
    const missing = await browser.call('fetch.asset', { url: `${origin}/media/nope.png` }, ctx);
    expect(missing.code).toBe(404);
  }, 60_000);

  it('fetches an asset with its content hash for de-duplication', async () => {
    const r = await browser.call('fetch.asset', { url: `${origin}/media/hero.png` }, ctx);
    const expected = createHash('sha256')
      .update(await readFile(join(SITE, 'media/hero.png')))
      .digest('hex');
    expect(r.body).toMatchObject({
      contentType: 'image/png',
      sha256: expected,
      ref: `blob://p1/assets/${expected}.png`,
    });
  });
});

describe('network safety', () => {
  it('only goes to the project’s source hosts', async () => {
    const r = await browser.call('snapshot', { url: 'http://elsewhere.example/' }, ctx);
    expect(r).toMatchObject({
      code: 422,
      body: {
        error:
          "elsewhere.example is not one of this project's hosts (the source site, hosts its Blueprint and inventories point media at, and the project's own new site)",
      },
    });
    expect((await browser.call('crawl', { url: 'file:///etc/passwd' }, ctx)).code).toBe(422);
  });

  it('refuses private addresses unless explicitly allowed (tests only)', async () => {
    const strict = new BrowserToolServer({
      policy: () => ({ allowedHosts: ['127.0.0.1'] }),
      blobs: new LocalBlobStore(blobDir),
    });
    const r = await strict.call('snapshot', { url: `${origin}/` }, ctx);
    expect(r).toMatchObject({
      code: 422,
      body: { error: '127.0.0.1 resolves to a private address' },
    });
    await strict.close();
  });

  it('knows private, metadata and loopback addresses', () => {
    for (const ip of [
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '127.0.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111'])
      expect(isPrivateAddress(ip), ip).toBe(false);
    const policy = { allowedHosts: ['acme.example'] };
    expect(isBlockedSubresource('http://169.254.169.254/latest/meta-data', policy)).toBe(true);
    expect(isBlockedSubresource('http://localhost:8080/admin', policy)).toBe(true);
    expect(isBlockedSubresource('http://metadata.google.internal/', policy)).toBe(true);
    expect(isBlockedSubresource('https://cdn.example/img.png', policy)).toBe(false);
  });
});

describe('through the tool gateway', () => {
  it('reaches the Content Analyst as untrusted content, and quarantines an injection attempt', async () => {
    const playbook = await loadPlaybook(PLAYBOOK);
    const gateway = new ToolGateway({
      playbook,
      servers: [browser],
      bindings: () => ({}),
      credentials: { tokenFor: async () => 'n/a-for-browser' },
      idempotency: new MemoryIdempotencyStore(),
      rollback: { hasRecipe: async () => false },
      limiter: new TokenBucketLimiter(10, 10),
      store: new InMemoryEventStore(),
    });
    const call = (op: string, url: string, step: number) =>
      gateway.call({
        projectId: 'p1',
        taskId: 't',
        stepIndex: step,
        attempt: 1,
        role: 'content-analyst',
        server: 'browser',
        op,
        args: { url },
      });
    expect(await call('snapshot', `${origin}/about`, 1)).toMatchObject({
      ok: true,
      body: { untrusted: true, provenance: { server: 'browser', op: 'snapshot' } },
    });
    expect(await call('snapshot', `${origin}/ignore`, 2)).toMatchObject({
      ok: true,
      body: { quarantined: true },
    });
    // The Media Migrator's download tool is not the Content Analyst's.
    expect(await call('fetch.asset', `${origin}/`, 3)).toMatchObject({
      ok: false,
      denied: 'not_allowed',
    });
  }, 60_000);
});

describe('egress proxy', () => {
  const dns: Record<string, string[]> = {
    'intranet.corp': ['10.0.0.5'],
    'split.example': ['93.184.215.14', '169.254.169.254'],
  };
  const lookup = async (h: string) => dns[h] ?? [];

  it('refuses hosts that resolve to private addresses, over HTTP and CONNECT', async () => {
    const proxy = await EgressProxy.start({ lookup });
    try {
      const { request } = await import('node:http');
      const send = (opts: object) =>
        new Promise<number>((resolve, reject) => {
          const req = request({ host: '127.0.0.1', port: new URL(proxy.url).port, ...opts });
          req.on('response', (r) => resolve(r.statusCode!));
          req.on('connect', (r, socket) => (socket.destroy(), resolve(r.statusCode!)));
          req.on('error', reject);
          req.end();
        });
      expect(await send({ method: 'GET', path: 'http://intranet.corp/secret' })).toBe(403);
      expect(await send({ method: 'CONNECT', path: 'split.example:443' })).toBe(403);
      expect(await send({ method: 'GET', path: `${origin}/` })).toBe(403);
      expect(proxy.refused).toEqual(['intranet.corp', 'split.example', '127.0.0.1']);
    } finally {
      await proxy.close();
    }
  });

  it('keeps a page from loading subresources on privately resolving names', async () => {
    // The page asks for an image on a name the in-page check can't judge; the proxy can.
    const proxy = await EgressProxy.start({
      lookup: async (h) => (h === 'cdn.lan.example' ? ['192.168.1.20'] : []),
      allowPrivateNetworks: false,
    });
    const { chromium } = await import('playwright-core');
    const b = await chromium.launch({
      executablePath: guarded.executablePath,
      args: ['--no-sandbox', ...proxy.chromeFlags()],
    });
    try {
      const page = await b.newPage();
      await page.setContent('<img src="http://cdn.lan.example/pixel.png">');
      await page.waitForLoadState('load');
      expect(proxy.refused).toContain('cdn.lan.example');
    } finally {
      await b.close();
      await proxy.close();
    }
  });
});
