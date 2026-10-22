import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserToolServer, GuardedBrowser } from '@lw/tool-browser';
import { LocalBlobStore } from '@lw/tool-gateway';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ValidatorsToolServer } from '../src';

const page = (body: string, title = 'Acme') =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title></head><body style="margin:0;font:16px sans-serif">${body}</body></html>`;

const PAGES: Record<string, string> = {
  '/': page('<main><h1>Welcome</h1><p>Hello from Acme.</p></main>'),
  '/same': page('<main><h1>Welcome</h1><p>Hello from Acme.</p></main>'),
  '/changed': page(
    '<main><h1 style="background:#c00;color:#fff">Welcome!</h1><p>Hello from Acme.</p></main>',
  ),
  '/taller': page(
    '<main><h1>Welcome</h1><p>Hello from Acme.</p><div style="height:1400px"></div></main>',
  ),
  '/bad': page(
    '<main><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="40" height="40"><button></button><p style="color:#ccc;background:#fff">Low contrast</p></main>',
  ),
};

let http: Server;
let origin: string;
let guarded: GuardedBrowser;
let browser: BrowserToolServer;
let validators: ValidatorsToolServer;
const ctx = (projectId = 'p1') => ({ projectId, token: 't', role: 'visual-qa', taskId: 't1' });

beforeAll(async () => {
  http = createServer((req, res) => {
    const body = PAGES[new URL(req.url!, 'http://x').pathname];
    if (!body) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html' }).end(body);
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const a = http.address();
  origin = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  const blobs = new LocalBlobStore(await mkdtemp(join(tmpdir(), 'lw-val-')));
  const policy = () => ({ allowedHosts: ['127.0.0.1'], allowPrivateNetworks: true });
  guarded = new GuardedBrowser({ allowPrivateNetworks: true });
  browser = new BrowserToolServer({ policy, blobs, browser: guarded });
  validators = new ValidatorsToolServer({ policy, blobs, browser: guarded });
});

afterAll(async () => {
  await guarded.close();
  await new Promise((r) => http.close(r));
});

const shot = async (path: string, projectId = 'p1') => {
  const r = await browser.call(
    'screenshot',
    { url: origin + path, breakpoints: ['desktop'] },
    ctx(projectId),
  );
  return (r.body as { shots: { ref: string }[] }).shots[0]!.ref;
};

describe('axe', () => {
  it('reports violations by rule, worst first, with example selectors', async () => {
    const r = await validators.call('axe.run', { url: `${origin}/bad` }, ctx());
    expect(r.code).toBe(200);
    const body = r.body as {
      violations: { rule: string; impact: string; elements: number; examples: string[] }[];
    };
    const rules = body.violations.map((v) => v.rule);
    expect(rules).toEqual(expect.arrayContaining(['image-alt', 'button-name', 'color-contrast']));
    expect(body.violations[0]!.impact).toBe('critical');
    expect(body.violations.find((v) => v.rule === 'image-alt')).toMatchObject({
      elements: 1,
      examples: ['img'],
    });
    expect(r.summary).toMatch(/^axe wcag22aa on \/bad: \d+ rules violated/);
  });

  it('passes a clean page', async () => {
    const r = await validators.call('axe.run', { url: `${origin}/`, standard: 'wcag21aa' }, ctx());
    expect(r).toMatchObject({ code: 200, body: { violations: [] } });
  });
});

describe('visual diff', () => {
  it('matches identical renders and flags changed and resized ones', async () => {
    const [home, same, changed, taller] = await Promise.all(
      ['/', '/same', '/changed', '/taller'].map((p) => shot(p)),
    );
    const identical = await validators.call(
      'visual.diff',
      { baseline: home, candidate: same },
      ctx(),
    );
    expect(identical).toMatchObject({ code: 200, body: { mismatchPercent: 0, pass: true } });

    const diff = await validators.call(
      'visual.diff',
      { baseline: home, candidate: changed },
      ctx(),
    );
    expect(diff.body).toMatchObject({
      pass: false,
      diffRef: expect.stringMatching(/^blob:\/\/p1\/diffs\//),
    });
    expect((diff.body as { mismatchPercent: number }).mismatchPercent).toBeGreaterThan(0.5);

    // A page that grew can't pass on its shared region alone.
    const grown = await validators.call(
      'visual.diff',
      { baseline: home, candidate: taller },
      ctx(),
    );
    expect((grown.body as { mismatchPercent: number }).mismatchPercent).toBeGreaterThan(30);
  });

  it("refuses another project's screenshots and non-images", async () => {
    const theirs = await shot('/', 'p2');
    const mine = await shot('/');
    expect(
      (await validators.call('visual.diff', { baseline: mine, candidate: theirs }, ctx())).code,
    ).toBe(403);
    expect(
      (
        await validators.call(
          'visual.diff',
          { baseline: mine, candidate: 'blob://p1/nope.png' },
          ctx(),
        )
      ).code,
    ).toBe(404);
  });
});

describe('lighthouse', () => {
  it('scores a page through the egress proxy', async () => {
    const r = await validators.call('lighthouse.run', { url: `${origin}/bad` }, ctx());
    expect(r.code).toBe(200);
    const body = r.body as {
      scores: Record<string, number>;
      failing: { id: string }[];
      metrics: { lcpMs: number };
    };
    expect(body.scores.accessibility).toBeLessThan(100);
    expect(body.failing.map((f) => f.id)).toContain('image-alt');
    expect(body.metrics.lcpMs).toBeGreaterThan(0);
    expect(r.summary).toMatch(/^Lighthouse mobile \/bad: performance \d+/);
  });

  it('only checks the project’s hosts', async () => {
    const r = await validators.call('lighthouse.run', { url: 'https://elsewhere.example/' }, ctx());
    expect(r.code).toBe(403);
  });
});
