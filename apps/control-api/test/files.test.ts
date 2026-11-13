import { InMemoryEventStore, Projections } from '@lw/events';
import type { FastifyInstance } from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { buildApp } from '../src/app';

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function start(
  putFile?: (p: string, k: string, b: Uint8Array, t: string) => Promise<string>,
) {
  const store = new InMemoryEventStore();
  await store.append('p1', [
    {
      type: 'project.created',
      actor: { kind: 'system', id: 'sys' },
      subject: { kind: 'project', id: 'p1' },
      severity: 'routine',
      data: {
        name: 'Paylocity',
        client: 'Star LLC',
        playbook: { id: 'sitecoreai-migration', version: '0.11.0' },
        budgets: { tokens: 1, usd: 1, hours: 1 },
        phases: [{ number: 6, name: 'Migration', gate: 'none', exitCriteria: '' }],
        roster: [],
      },
    },
  ]);
  const projections = new Projections(store);
  await projections.start();
  app = await buildApp({ store, projections, commands: () => undefined, putFile });
  return { store, projections };
}

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="44"/>';
const body = (over: Record<string, unknown> = {}) => ({
  name: 'Paylocity logo.svg',
  contentType: 'image/svg+xml',
  dataBase64: Buffer.from(svg).toString('base64'),
  note: 'The footer logo the Media Migrator asked for',
  about: 'esc-c9788769',
  ...over,
});

it('keeps a file the Director gives the team, and shows it in the conversation and the project', async () => {
  const kept: { key: string; bytes: string; type: string }[] = [];
  const { projections } = await start(async (p, key, bytes, type) => {
    kept.push({ key, bytes: Buffer.from(bytes).toString(), type });
    return `blob://${p}/${key}`;
  });
  const r = await app!.inject({ method: 'POST', url: '/projects/p1/files', payload: body() });
  expect(r.statusCode).toBe(201);
  const { fileId, ref } = r.json() as { fileId: string; ref: string };
  // Stored under the project's files, with a name that keeps its extension.
  expect(kept).toEqual([
    { key: `files/${fileId}-Paylocity-logo.svg`, bytes: svg, type: 'image/svg+xml' },
  ]);
  expect(ref).toBe(`blob://p1/files/${fileId}-Paylocity-logo.svg`);
  await projections.catchUp('p1');
  const s = projections.get('p1')!;
  expect(s.files).toEqual([
    expect.objectContaining({
      fileId,
      name: 'Paylocity logo.svg',
      ref,
      about: 'esc-c9788769',
      note: 'The footer logo the Media Migrator asked for',
    }),
  ]);
  expect(s.conversation.at(-1)).toMatchObject({
    from: 'director',
    body: 'Attached Paylocity logo.svg (image/svg+xml, 1 KB): The footer logo the Media Migrator asked for',
  });
});

it('refuses empty and oversized files, and says so where nothing can keep them', async () => {
  await start(async (p, k) => `blob://${p}/${k}`);
  const empty = await app!.inject({
    method: 'POST',
    url: '/projects/p1/files',
    payload: body({ dataBase64: '' }),
  });
  expect(empty.statusCode).toBe(400);
  const big = Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64');
  const tooBig = await app!.inject({
    method: 'POST',
    url: '/projects/p1/files',
    payload: body({ dataBase64: big }),
  });
  expect(tooBig.statusCode).toBe(413);
  await app!.close();
  await start();
  const none = await app!.inject({ method: 'POST', url: '/projects/p1/files', payload: body() });
  expect(none.statusCode).toBe(501);
});

/**
 * Liberty Mutual's homepage was saved before scrolling: its lazy images were blank in the copy,
 * and the team asked for each one by hand. A saved page is checked when it's attached, and Cypher
 * names the blank images and how to save the page again.
 */
it('checks a saved page for images that never loaded, and tells the Director which', async () => {
  const { projections } = await start(async (p, key) => `blob://${p}/${key}`);
  const html =
    '<html><body><img src="https://cdn.example/hero.jpg" alt="Hero"><img src="" loading="lazy" alt="Man with a laptop"><img data-src="https://cdn.example/couple.png" src="data:image/gif;base64,R0lGOD" alt="Couple at a table"></body></html>';
  const mhtml = [
    'From: <Saved by Blink>',
    'Snapshot-Content-Location: https://www.example.com/',
    'Subject: Example',
    'MIME-Version: 1.0',
    'Content-Type: multipart/related; type="text/html"; boundary="B"',
    '',
    '--B',
    'Content-Type: text/html',
    'Content-Location: https://www.example.com/',
    '',
    html,
    '--B',
    'Content-Type: image/jpeg',
    'Content-Transfer-Encoding: base64',
    'Content-Location: https://cdn.example/hero.jpg',
    '',
    Buffer.from('jpegbytes').toString('base64'),
    '--B--',
  ].join('\r\n');
  const r = await app!.inject({
    method: 'POST',
    url: '/projects/p1/files',
    payload: body({
      name: 'Example homepage.mhtml',
      contentType: 'multipart/related',
      dataBase64: Buffer.from(mhtml).toString('base64'),
      about: undefined,
    }),
  });
  expect(r.statusCode).toBe(201);
  expect((r.json() as { missingImages: unknown[] }).missingImages).toEqual([
    { alt: 'Man with a laptop', hint: null },
    { alt: 'Couple at a table', hint: 'https://cdn.example/couple.png' },
  ]);
  await projections.catchUp('p1');
  const said = projections.get('p1')!.conversation.at(-1)!;
  expect(said).toMatchObject({
    from: 'chief_of_staff',
    title: 'Your saved copy is missing 2 images',
  });
  expect(said.body).toContain('scroll slowly to the bottom');
  expect(said.bullets).toEqual([
    'Man with a laptop',
    'Couple at a table (https://cdn.example/couple.png)',
  ]);
});
