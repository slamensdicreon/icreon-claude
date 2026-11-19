import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromiumPath } from '../src/guarded';
import { settleForScreenshot } from '../src/server';

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ executablePath: chromiumPath() });
}, 60_000);
afterAll(async () => {
  await browser.close();
});

it('hides a cookie banner but keeps a footer pinned to the bottom, laid out at the end', async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  // As on cabotcorp.com: a fixed header, a "reveal" footer fixed to the bottom that the page
  // scrolls off, and a consent banner fixed above it.
  await page.setContent(`<body style="margin:0 0 300px">
    <header style="position:fixed;top:0;height:80px;width:100%">Header</header>
    <main style="height:2000px">Content</main>
    <footer class="footer" style="position:fixed;bottom:0;height:300px;width:100%;z-index:-1">
      <a href="/company">Company</a> <a href="/legal">Legal</a></footer>
    <section id="card" style="position:sticky;top:153px;height:600px">Monarch feature card</section>
    <div id="onetrust-banner-sdk" style="position:fixed;bottom:0;height:200px;width:100%">Privacy Settings</div>
  </body>`);
  await settleForScreenshot(page);
  const seen = await page.evaluate(() =>
    Object.fromEntries(
      ['header', 'footer', '#onetrust-banner-sdk', '#card'].map((sel) => {
        const el = document.querySelector<HTMLElement>(sel)!;
        const cs = getComputedStyle(el);
        return [sel, { visibility: cs.visibility, position: cs.position }];
      }),
    ),
  );
  expect(seen['#onetrust-banner-sdk']!.visibility).toBe('hidden');
  expect(seen.footer).toEqual({ visibility: 'visible', position: 'relative' });
  expect(seen.header).toEqual({ visibility: 'visible', position: 'fixed' });
  // A sticky card is content: kept, in its place in the page.
  expect(seen['#card']).toEqual({ visibility: 'visible', position: 'relative' });
  await page.close();
}, 60_000);
