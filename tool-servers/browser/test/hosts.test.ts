import { describe, expect, it } from 'vitest';
import { afterEach, vi } from 'vitest';
import {
  BrowserToolServer,
  fetchPolitely,
  hostAllowed,
  layoutData,
  looksLikeBotCheck,
  pause,
  retryDelayMs,
  siteOf,
  sniffExt,
  withSibling,
} from '../src';

describe('hostAllowed', () => {
  const policy = {
    allowedHosts: ['anscollc.com', 'dycom-ansco-associates-s*.vercel.app'],
  };
  it("matches exact hosts and the project's provider addresses, nothing else", () => {
    expect(hostAllowed('anscollc.com', policy)).toBe(true);
    expect(hostAllowed('ANSCOLLC.com', policy)).toBe(true);
    for (const h of [
      'dycom-ansco-associates-sitecoreai-v.vercel.app',
      'dycom-ansco-associates-sitecoreai-v2-editing.vercel.app',
      'dycom-ansco-associates-sitecoreai-v2-stevetestings-projects.vercel.app',
    ])
      expect(hostAllowed(h, policy)).toBe(true);
    for (const h of [
      'evil.com',
      'dycom-ansco-associates-s.vercel.app.evil.com',
      'x.dycom-ansco-associates-sitecoreai.vercel.app',
      'dycom-ansco-associates-s.evil.vercel.app',
      'other-project.vercel.app',
    ])
      expect(hostAllowed(h, policy)).toBe(false);
    // A wildcard needs a real prefix.
    expect(hostAllowed('anything.vercel.app', { allowedHosts: ['a*.vercel.app'] })).toBe(false);
  });
});

describe('sibling media hosts', () => {
  it('lets an allowed media host stand for its CDN on the same site, never on shared domains', () => {
    const policy = { allowedHosts: ['www.paylocity.com', 'play.vidyard.com', 'acme*.vercel.app'] };
    // Paylocity: play.vidyard.com thumbnails redirect to cdn.vidyard.com.
    expect(withSibling(policy, 'cdn.vidyard.com').allowedHosts).toContain('cdn.vidyard.com');
    expect(withSibling(policy, 'evil.com')).toBe(policy);
    // A wildcard entry stands for no siblings, and hosting providers' domains are many customers.
    expect(withSibling(policy, 'other.vercel.app')).toBe(policy);
    expect(siteOf('x.cloudfront.net')).toBeNull();
    expect(siteOf('shop.acme.co.uk')).toBe('acme.co.uk');
    expect(siteOf('10.0.0.1')).toBeNull();
  });
});

describe('slowing down when a site asks', () => {
  afterEach(() => vi.restoreAllMocks());
  it('waits the Retry-After (capped) and asks again, twice at most', async () => {
    expect(retryDelayMs('3', 0)).toBe(3_000);
    expect(retryDelayMs('600', 0)).toBe(15_000);
    expect(retryDelayMs(null, 0)).toBe(4_000);
    expect(retryDelayMs(null, 1)).toBe(10_000);
    const waits: number[] = [];
    vi.spyOn(pause, 'ms').mockImplementation(async (n) => void waits.push(n));
    const answers = [429, 429, 200];
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () => new Response('', { status: answers.shift()!, headers: { 'retry-after': '2' } }),
      );
    expect((await fetchPolitely('https://www.paylocity.com/pricing/', {})).status).toBe(200);
    expect(waits).toEqual([2_000, 2_000]);
    // Still refused after two more tries: the last answer is returned as it is.
    fetchMock.mockImplementation(async () => new Response('', { status: 429 }));
    expect((await fetchPolitely('https://www.paylocity.com/pricing/', {})).status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
});

describe('reading the source once', () => {
  it('reuses a source page read, reads the new site fresh, and never keeps a bot check', async () => {
    const server = new BrowserToolServer({
      policy: () => ({ allowedHosts: ['www.paylocity.com', 'paylocity-editing.vercel.app'] }),
      blobs: {} as never,
      browser: {} as never,
      sourceHosts: () => ['www.paylocity.com', 'paylocity.com'],
    });
    let body: unknown = { title: 'Pricing', content: ['Plans'] };
    const fresh = vi
      .spyOn(server as unknown as { callFresh: () => Promise<unknown> }, 'callFresh')
      .mockImplementation(async () => ({ code: 200, body, summary: 'Snapshot of pricing' }));
    const ctx = { projectId: 'p1' };
    const pricing = { url: 'https://www.paylocity.com/pricing/' };
    expect((await server.call('snapshot', pricing, ctx)).code).toBe(200);
    const again = await server.call('snapshot', pricing, ctx);
    expect(again.summary).toContain('read earlier, not re-read');
    expect(fresh).toHaveBeenCalledTimes(1);
    // The new site is always read fresh.
    await server.call('snapshot', { url: 'https://paylocity-editing.vercel.app/pricing' }, ctx);
    await server.call('snapshot', { url: 'https://paylocity-editing.vercel.app/pricing' }, ctx);
    expect(fresh).toHaveBeenCalledTimes(3);
    // Paylocity's Cloudflare check: not the page, and not kept.
    body = { title: 'Just a moment...', content: ['Verify you are human'] };
    const check = await server.call(
      'snapshot',
      { url: 'https://www.paylocity.com/benefits/' },
      ctx,
    );
    expect(check.code).toBe(422);
    expect(check.summary).toContain('bot check');
    expect(looksLikeBotCheck({ title: 'Benefits' })).toBe(false);
    await server.call('snapshot', { url: 'https://www.paylocity.com/benefits/' }, ctx);
    expect(fresh).toHaveBeenCalledTimes(5);
  });

  it('marks a component the layout service could not fill', () => {
    const push = (v: unknown) =>
      `<script>self.__next_f.push([1,${JSON.stringify(JSON.stringify(v))}])</script>`;
    const html =
      push({
        uid: '11111111-1111-1111-1111-111111111111',
        componentName: 'SiteHeader',
        dataSource: '{A}',
        isContentResolved: true,
        fields: { title: { value: 'x' } },
      }) +
      push({
        uid: '22222222-2222-2222-2222-222222222222',
        componentName: 'SiteFooter',
        dataSource: '{B}',
        isContentResolved: false,
      });
    const comps = layoutData(html);
    expect(comps.find((c) => c.name === 'SiteHeader')?.contentResolved).toBeUndefined();
    expect(comps.find((c) => c.name === 'SiteFooter')?.contentResolved).toBe(false);
  });
});

describe('naming a downloaded file', () => {
  afterEach(() => vi.restoreAllMocks());
  it('names an extensionless image by what the server sent, and warns about AVIF', async () => {
    expect(sniffExt(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
    expect(sniffExt(new TextEncoder().encode('<?xml version="1.0"?><svg></svg>'))).toBe('svg');
    expect(sniffExt(new Uint8Array([1, 2, 3]))).toBeNull();
    const keys: string[] = [];
    const server = new BrowserToolServer({
      policy: () => ({ allowedHosts: ['127.0.0.1'], allowPrivateNetworks: true }),
      blobs: { put: async (_p: string, k: string) => (keys.push(k), `blob://p1/${k}`) } as never,
      browser: {} as never,
    });
    let type = 'image/png';
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': type } }),
    );
    // Microsoft's Scene7 images: no extension in the URL.
    const url = 'http://127.0.0.1/is/image/microsoftcorp/Promo-Card-Vertical-Xbox-Series-S-White';
    const png = await server.call('fetch.asset', { url }, { projectId: 'p1' });
    expect(keys.at(-1)).toMatch(/\.png$/);
    expect(png.summary).toContain('png');
    type = 'image/avif';
    const avif = await server.call('fetch.asset', { url }, { projectId: 'p1' });
    expect(keys.at(-1)).toMatch(/\.avif$/);
    expect(avif.summary).toContain('fmt=png-alpha');
  });
});
