import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { InMemoryEventStore, Projections } from '@lw/events';
import { loadPlaybook } from '@lw/playbook-sdk';
import { Simulation } from '@lw/simulator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { Favicons, iconLinks } from '../src/favicon';

const PLAYBOOK = fileURLToPath(new URL('../../../playbooks/sitecoreai-migration', import.meta.url));
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

/** A source site: `mode` decides which icons it has. */
function site(mode: { touch?: boolean; ico?: boolean; html?: boolean }) {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(req.url!);
    if (req.url === '/') {
      if (mode.html === false) return res.writeHead(500).end();
      return res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          `<html><head><link rel="mask-icon" href="/mask.svg"><link rel="icon" href="/small.png" sizes="16x16">${mode.touch ? '<link rel="apple-touch-icon" href="/touch.png">' : ''}</head><body>Hi</body></html>`,
        );
    }
    if (req.url === '/touch.png' && mode.touch)
      return res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
    if (req.url === '/favicon.ico' && mode.ico)
      return res.writeHead(200, { 'content-type': 'image/x-icon' }).end(PNG);
    // A missing icon answered with the site's page: not an icon.
    res.writeHead(200, { 'content-type': 'text/html' }).end('<html>Not found</html>');
  });
  return new Promise<{ origin: string; hits: string[]; close: () => Promise<void> }>((r) =>
    server.listen(0, '127.0.0.1', () =>
      r({
        origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        hits,
        close: () => new Promise((c) => server.close(() => c())),
      }),
    ),
  );
}

describe('the source site icon', () => {
  it('reads the icons a page names, best first, leaving out the pinned-tab mask', () => {
    const html = `<link rel="icon" type="image/png" href="/i32.png" sizes="32x32"><link rel="shortcut icon" href="/favicon.ico">
      <link rel="apple-touch-icon" href="/apple.png"><link rel="mask-icon" href="/mask.svg" color="#000"><link rel="icon" href="/i.svg" type="image/svg+xml">
      <link rel="stylesheet" href="/x.css">`;
    expect(iconLinks(html, 'https://acme.example/')).toEqual([
      'https://acme.example/apple.png',
      'https://acme.example/i.svg',
      'https://acme.example/i32.png',
      'https://acme.example/favicon.ico',
    ]);
  });

  it('takes the apple-touch-icon, else /favicon.ico, never a page answering for a missing icon', async () => {
    const touch = await site({ touch: true });
    const ico = await site({ ico: true, html: false });
    const none = await site({});
    const f = new Favicons({ allowPrivateNetworks: true });
    try {
      expect(await f.get(touch.origin)).toMatchObject({ type: 'image/png' });
      expect(touch.hits).toContain('/touch.png');
      expect(await f.get(ico.origin)).toMatchObject({ type: 'image/x-icon' });
      expect(await f.get(none.origin)).toBeNull();
      // Kept: asking again doesn't go back to the site.
      const before = touch.hits.length;
      await f.get(`${touch.origin}/about`);
      expect(touch.hits.length).toBe(before);
    } finally {
      await Promise.all([touch.close(), ico.close(), none.close()]);
    }
  });

  it('never fetches from a private address in production', async () => {
    const s = await site({ touch: true });
    try {
      expect(await new Favicons().get(s.origin)).toBeNull();
      expect(s.hits).toEqual([]);
    } finally {
      await s.close();
    }
  });
});

describe('GET /projects/:id/icon', () => {
  let src: Awaited<ReturnType<typeof site>>;
  let base = '';
  let close: () => Promise<void>;

  beforeAll(async () => {
    src = await site({ touch: true });
    const store = new InMemoryEventStore();
    const projections = new Projections(store);
    await projections.start();
    const playbook = await loadPlaybook(PLAYBOOK);
    for (const [projectId, sourceUrl] of [
      ['p1', src.origin],
      ['p2', undefined],
    ] as const) {
      const sim = new Simulation(store, playbook, {
        projectId,
        name: projectId,
        client: 'Acme',
        speed: 1000,
        sourceUrl,
      });
      await sim.createProject();
    }
    const app = await buildApp({
      store,
      projections,
      commands: () => undefined,
      corsOrigin: '*',
      favicons: new Favicons({ allowPrivateNetworks: true }),
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    close = async () => {
      await app.close();
      await src.close();
    };
  }, 60_000);

  afterAll(() => close());

  it("serves the source site's icon as a picture that can never run as the app", async () => {
    const r = await fetch(`${base}/projects/p1/icon`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(r.headers.get('content-security-policy')).toMatch(/default-src 'none'.*sandbox/);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('cache-control')).toBe('private, max-age=86400');
    expect(Buffer.from(await r.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it('answers 404 for a project without a source site, so the app shows its initials', async () => {
    expect((await fetch(`${base}/projects/p2/icon`)).status).toBe(404);
    expect((await fetch(`${base}/projects/nope/icon`)).status).toBe(404);
  });
});
