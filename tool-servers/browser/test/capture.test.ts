import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalBlobStore } from '@lw/tool-gateway';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { BrowserToolServer, GuardedBrowser } from '../src';
import { chromiumPath } from '../src/guarded';
import { pageKey, parseMhtml } from '../src/capture';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// A site that, once it has been saved, refuses every request (Liberty Mutual refused every
// browser read with HTTP 403), and counts what reaches it.
let walled = false;
let hits = 0;
let http: Server;
let origin: string;
let guarded: GuardedBrowser;
let browser: BrowserToolServer;
let blobs: LocalBlobStore;
let mhtml: Buffer;

beforeAll(async () => {
  http = createServer((req, res) => {
    if (walled) {
      hits++;
      return res
        .writeHead(403, { 'content-type': 'text/html' })
        .end('<html><body><h1>Access Denied</h1></body></html>');
    }
    if (req.url === '/s.css')
      return res
        .writeHead(200, { 'content-type': 'text/css' })
        .end(
          'h1{color:rgb(200,0,0)} .hero{padding:24px} .logo-ink{fill:rgb(26,20,70)} .logo-alt{display:none}',
        );
    if (req.url === '/hero.png')
      return res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
    res.writeHead(200, { 'content-type': 'text/html' }).end(
      `<html lang="en"><head><title>Acme Insurance</title><link rel="stylesheet" href="/s.css"></head>
       <body><header><svg aria-label="Acme logo" viewBox="0 0 20 10"><path class="logo-ink" d="M0 0h10v10z"/><path class="logo-alt" d="M10 0h10v10z"/><script>alert(1)</script></svg><nav><a href="/auto">Auto</a></nav></header>
       <section class="hero"><h1>Insurance made simple</h1><img src="/hero.png" alt="A family"></section>
       <section><h2>Get a quote</h2><p>Save up to 20 percent when you bundle.</p></section></body></html>`,
    );
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const addr = http.address();
  origin = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  // The Director saves the page from their own browser: Chrome's "Webpage, Single File".
  const real = await chromium.launch({ executablePath: chromiumPath() });
  const page = await real.newPage();
  await page.goto(`${origin}/`);
  const cdp = await page.context().newCDPSession(page);
  mhtml = Buffer.from(
    ((await cdp.send('Page.captureSnapshot', { format: 'mhtml' })) as { data: string }).data,
    'latin1',
  );
  await real.close();
  walled = true;

  blobs = new LocalBlobStore(await mkdtemp(join(tmpdir(), 'lw-capture-')));
  const ref = await blobs.put('p1', 'files/file-1-acme.mhtml', mhtml);
  guarded = new GuardedBrowser({ allowPrivateNetworks: true });
  browser = new BrowserToolServer({
    policy: () => ({ allowedHosts: ['127.0.0.1'], allowPrivateNetworks: true }),
    blobs,
    browser: guarded,
    captures: async () => [{ ref, name: 'acme.mhtml' }],
  });
}, 60_000);

afterAll(async () => {
  await browser.close();
  await guarded.close();
  await new Promise((r) => http.close(r));
});

const ctx = { projectId: 'p1', token: 'unused' };

it('reads an MHTML capture: its page, date and parts', () => {
  const c = parseMhtml(mhtml)!;
  expect(pageKey(c.url)).toBe(pageKey(`${origin}/`));
  expect(c.title).toBe('Acme Insurance');
  expect(c.parts.map((p) => p.contentType)).toEqual(
    expect.arrayContaining(['text/html', 'text/css', 'image/png']),
  );
  expect(parseMhtml(Buffer.from('<html></html>'))).toBeNull();
});

it("answers page reads from the Director's saved copy, and never asks the live site", async () => {
  hits = 0;
  const snap = await browser.call('snapshot', { url: `${origin}/` }, ctx);
  expect(snap.code).toBe(200);
  expect(snap.summary).toContain("from the Director's saved copy");
  expect(JSON.stringify(snap.body)).toContain('Insurance made simple');
  expect(snap.body).toMatchObject({ capture: { url: `${origin}/` } });

  const outline = await browser.call('page.markup', { url: `${origin}/` }, ctx);
  expect(outline.code).toBe(200);
  expect(JSON.stringify(outline.body)).toContain('header > nav');

  const styles = await browser.call('page.styles', { url: origin, selectors: ['h1'] }, ctx);
  expect(styles.code).toBe(200);
  expect(JSON.stringify(styles.body)).toContain('rgb(200, 0, 0)');

  const shots = await browser.call(
    'screenshot',
    { url: `${origin}/`, breakpoints: ['desktop', 'phone'] },
    ctx,
  );
  expect(shots.code).toBe(200);
  expect((shots.body as { shots: unknown[] }).shots).toHaveLength(2);

  // The page's image comes out of the saved copy too.
  const img = await browser.call('fetch.asset', { url: `${origin}/hero.png` }, ctx);
  expect(img).toMatchObject({ code: 200, body: { contentType: 'image/png', bytes: PNG.length } });
  expect(img.summary).toContain("from the Director's saved copy");

  expect(hits).toBe(0);
}, 60_000);

it('stores an inline logo as a standalone SVG, with the colours the page draws it in', async () => {
  hits = 0;
  const r = await browser.call('page.svg', { url: `${origin}/` }, ctx);
  expect(r.code).toBe(200);
  const [logo] = (r.body as { svgs: { label: string; region: string; ref: string }[] }).svgs;
  expect(logo).toMatchObject({ label: 'Acme logo', region: 'header' });
  const svg = new TextDecoder().decode(await blobs.get(logo!.ref));
  expect(svg).toContain('fill="rgb(26, 20, 70)"');
  expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  // The part the page hides, and anything that could run, are left out.
  expect(svg).not.toContain('M10 0h10v10z');
  expect(svg).not.toMatch(/<script|class=/);
  expect(r.summary).toContain("from the Director's saved copy");
  expect(hits).toBe(0);
}, 60_000);

it("answers a stored file's ref with the saved copy's image URLs", async () => {
  const r = await browser.call('fetch.asset', { url: 'blob://p1/files/file-1-acme.mhtml' }, ctx);
  expect(r.code).toBe(422);
  expect(r.summary).toContain("The Director's saved copy holds 1 images");
  expect(r.body).toMatchObject({ savedCopyImages: [`${origin}/hero.png`] });
});

it('asks for a saved copy, not an allowlist, when the site refuses a page it has none of', async () => {
  const r = await browser.call('snapshot', { url: `${origin}/auto` }, ctx);
  expect(r.code).toBe(422);
  expect(r.summary).toContain('Webpage, Single File');
  expect(r.summary).not.toMatch(/allows? our crawler/);
}, 60_000);
