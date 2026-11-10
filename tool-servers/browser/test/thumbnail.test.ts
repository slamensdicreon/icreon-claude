import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { MemoryBlobStore } from '@lw/tool-gateway';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserToolServer, designFrom, GuardedBrowser, safeSvg, thumbnailHtml } from '../src';

const HERO = fileURLToPath(new URL('./fixture-site/media/brand-hero.jpg', import.meta.url));

/** A brand's home page: a navy brand colour, a red accent, an SVG logo on a white header, a hero photo. */
const home = (h1 = 'Building the networks that connect America') => `<!doctype html><html><head>
<title>Acme Telecom | Home</title><meta name="description" content="Telecom construction since 1985.">
<style>body{margin:0;font-family:Arial} header{background:#fff;height:90px;display:flex;align-items:center;padding:0 40px}
.btn{background:#C8203F;color:#fff;padding:12px 20px;display:inline-block} nav a{color:#1B2462} section.band{background:#1B2462;color:#fff;padding:20px}
footer{background:#1B2462;color:#fff} .hero{width:1200px;height:520px}</style></head><body>
<header><a href="/" class="logo"><svg width="180" height="40" viewBox="0 0 180 40" onload="alert(1)"><script>alert(1)</script><rect width="40" height="40" fill="#C8203F"/><text x="50" y="30" font-size="28" fill="#1B2462">ACME</text></svg></a>
<nav><a href="/a">About</a> <a href="/b">Services</a> <a href="/c">Careers</a> <a href="/d">Contact</a></nav></header>
<img class="hero" src="/brand-hero.jpg" alt="">
<h1>${h1}</h1><a class="btn" href="/q">Get a quote</a> <a class="btn" href="/r">Careers</a> <a class="btn" href="/s">Safety</a>
<section class="band"><h2>Safety first</h2></section><section class="band"><h2>Quality</h2></section><section class="band"><h2>Careers</h2></section>
<footer>Acme</footer></body></html>`;

let http: Server;
let origin = '';
let guarded: GuardedBrowser;
let blobs: MemoryBlobStore;
let server: BrowserToolServer;
let page = home();

beforeAll(async () => {
  http = createServer(async (req, res) => {
    if (req.url === '/brand-hero.jpg')
      return res.writeHead(200, { 'content-type': 'image/jpeg' }).end(await readFile(HERO));
    if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(page);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  guarded = new GuardedBrowser({ allowPrivateNetworks: true });
  blobs = new MemoryBlobStore();
  server = new BrowserToolServer({
    policy: () => ({ allowedHosts: ['127.0.0.1'], allowPrivateNetworks: true }),
    blobs,
    browser: guarded,
  });
}, 60_000);

afterAll(async () => {
  await server.close();
  await guarded.close();
  await new Promise((r) => http.close(r));
});

const ctx = { projectId: 'p1', token: '', role: 'deployment-engineer', taskId: 'site-thumbnail' };
type Body = {
  ref: string;
  width: number;
  height: number;
  readFromPage: boolean;
  design: Record<string, unknown>;
};

describe('brand.thumbnail', () => {
  it('makes a 1200×640 PNG from the brand of the home page', async () => {
    const r = await server.call(
      'brand.thumbnail',
      { url: `${origin}/`, eyebrow: 'Telecom construction', motif: 'route' },
      ctx,
    );
    expect(r.code).toBe(200);
    const b = r.body as Body;
    expect(b.ref).toMatch(/^blob:\/\/p1\/assets\/site-thumbnail-[0-9a-f]{16}\.png$/);
    const png = await blobs.get(b.ref);
    expect([...png.slice(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG');
    // Width and height from the PNG header.
    const view = new DataView(png.buffer, png.byteOffset);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([1200, 640]);
    expect(b.readFromPage).toBe(true);
    expect(b.design).toMatchObject({
      // The brand's own navy as the field, its red as the accent.
      tone: 'dark',
      field: '#1B2462',
      accent: '#C8203F',
      headline: 'Building the networks that connect America',
      eyebrow: 'Telecom construction',
      logo: 'the inline SVG logo from the page',
      logoShownWhite: true,
      motif: 'route',
    });
    expect((b.design.photos as string[])[0]).toBe(`${origin}/brand-hero.jpg`);
    expect(r.summary).toMatch(
      /^Thumbnail for 127\.0\.0\.1: dark field #1B2462, accent #C8203F, its logo, its hero photo/,
    );
  }, 60_000);

  it('takes what it is given over what the page says', async () => {
    const r = await server.call(
      'brand.thumbnail',
      {
        url: `${origin}/`,
        headline: 'Connecting the East Coast',
        emphasis: 'East Coast',
        tone: 'light',
        accent: '#FF8A00',
        chip: 'Demo',
      },
      ctx,
    );
    expect((r.body as Body).design).toMatchObject({
      tone: 'light',
      accent: '#FF8A00',
      headline: 'Connecting the East Coast',
      emphasis: 'East Coast',
      chip: 'Demo',
      logoShownWhite: false,
    });
  }, 60_000);

  it("makes one from what it is given when the page can't be read", async () => {
    const r = await server.call(
      'brand.thumbnail',
      { url: `${origin}/missing`, headline: 'Acme Telecom' },
      ctx,
    );
    expect(r.code).toBe(200);
    expect(r.summary).toMatch(/the home page couldn't be read: only what was given, and defaults/);
    expect((r.body as Body).design).toMatchObject({
      headline: 'Acme Telecom',
      wordmark: '127',
      tone: 'light',
    });
  }, 60_000);
});

describe('the design', () => {
  const cues = {
    logo: null,
    headerBackground: 'rgb(255, 255, 255)',
    colors: [
      { c: 'rgb(0, 0, 0)', n: 40 },
      { c: 'rgb(56, 106, 255)', n: 12 },
    ],
    headline: 'LEADING PROVIDER OF TELECOM CONSTRUCTION',
    headlineColor: 'rgb(0, 0, 0)',
    font: 'Montserrat',
    photos: [],
    description: '',
  };

  it('keeps a brand with no deep colour of its own light, and quiets a headline in capitals', () => {
    const d = designFrom(cues, { host: 'www.ervincable.com' });
    expect(d).toMatchObject({
      tone: 'light',
      field: '#FFFFFF',
      accent: '#386AFF',
      headline: 'Leading provider of telecom construction',
      wordmark: 'ervincable',
    });
  });

  it('never lets a logo from another site run code in the render', () => {
    const svg =
      '<svg onload="steal()"><script>steal()</script><a href="javascript:steal()"><rect/></a><foreignObject><div>x</div></foreignObject></svg>';
    expect(safeSvg(svg)).toBe('<svg><a href="#"><rect/></a></svg>');
    // A photo URL can't close the script it is written into.
    const html = thumbnailHtml({
      ...designFrom(cues, { host: 'x.com' }),
      photos: ['https://x.com/a.jpg?</script><script>steal()</script>'],
    });
    expect(html).not.toContain('</script><script>steal()');
  });
});
