import { describe, expect, it } from 'vitest';
import { afterEach, vi } from 'vitest';
import { fetchPolitely, hostAllowed, pause, retryDelayMs, siteOf, withSibling } from '../src';

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
