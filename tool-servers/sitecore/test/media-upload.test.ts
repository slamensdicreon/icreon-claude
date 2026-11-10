import { describe, expect, it } from 'vitest';
import { SitecoreAuthoringToolServer } from '../src';

const facts = {
  cmHost: 'xmc-acme.sitecorecloud.io',
  siteCollection: 'Brands',
  site: 'ansco',
  languages: ['en'],
  sourceHosts: ['anscollc.com', 'www.anscollc.com'],
};
const ctx = { projectId: 'p1', token: 'jwt', role: 'media-migrator', taskId: 't' };

function setup() {
  const uploads: { url: string; name: string; type: string; size: number }[] = [];
  const queries: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/graphql/v1/')) {
      const { query } = JSON.parse(String(init!.body)) as { query: string };
      queries.push(query);
      if (/deleteItem\(/.test(query))
        return Response.json({ data: { deleteItem: { successful: true } } });
      if (/item\(where/.test(query) && /wrong-upload/.test(query))
        return Response.json({ data: { item: { itemId: 'abc', children: { nodes: [] } } } });
      if (/uploadMedia\(/.test(query))
        return Response.json({
          data: { uploadMedia: { presignedUploadUrl: 'https://up.example/x' } },
        });
      // A file's Title reads back as written.
      if (/item\(where/.test(query) && /code-of-conduct/.test(query) && /"Title"/.test(query))
        return Response.json({
          data: {
            item: {
              itemId: 'pdf1',
              path: '/sitecore/media library/Project/Brands/ansco/files/code-of-conduct',
              f0: { value: 'Supplier Code of Conduct' },
            },
          },
        });
      // A file's template (Pdf, File) has no Alt field.
      if (/updateItem\(/.test(query) && /name: "Alt"/.test(query))
        return Response.json({ errors: [{ message: 'Cannot find a field with the name Alt.' }] });
      return Response.json({ data: { item: null } });
    }
    if (url === 'https://up.example/x') {
      const file = (init!.body as FormData).get('file') as File;
      uploads.push({ url, name: file.name, type: file.type, size: file.size });
      return new Response('{}', { status: 200 });
    }
    return new Response('nope', { status: 404 });
  }) as typeof globalThis.fetch;
  const stored = new Map([
    ['blob://p1/assets/abc123.png', new Uint8Array([137, 80, 78, 71, 1, 2])],
    ['blob://p1/files/file-1a2b3c4d-paylocity-logo.svg', new TextEncoder().encode('<svg/>')],
    // Stored before the type was known: an image server's URL with no extension.
    ['blob://p1/assets/def456.bin', new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
    [
      'blob://p1/assets/avif789.bin',
      new Uint8Array([0, 0, 0, 28, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66]),
    ],
  ]);
  const blobs = {
    put: async () => '',
    get: async (ref: string) => {
      const b = stored.get(ref);
      if (!b) throw new Error('missing');
      return b;
    },
    deleteProject: async () => undefined,
  };
  return {
    s: new SitecoreAuthoringToolServer({ facts: async () => facts, fetch, blobs }),
    uploads,
    queries,
  };
}

describe('media.upload', () => {
  it('replaces a wrong upload when asked, putting the old item in the recycle bin first', async () => {
    const { s, uploads, queries } = setup();
    const r = await s.call(
      'media.upload',
      {
        itemPath: '/sitecore/media library/Project/Brands/ansco/Home/wrong-upload',
        ref: 'blob://p1/assets/def456.bin',
        replace: true,
      },
      ctx,
    );
    expect(r.code).toBe(200);
    expect(queries.some((q) => /deleteItem\(.*permanently: false/.test(q))).toBe(true);
    expect(uploads.at(-1)).toMatchObject({ name: 'wrong-upload.png', type: 'image/png' });
  });

  it('files a stored file by what its bytes are, and turns AVIF away with the way round', async () => {
    const { s, uploads } = setup();
    // Microsoft's Xbox promo: a Scene7 URL with no extension, stored as .bin, went in as a File.
    const r = await s.call(
      'media.upload',
      {
        itemPath: '/sitecore/media library/Project/Brands/ansco/Home/xbox',
        ref: 'blob://p1/assets/def456.bin',
        fileName: 'xbox.bin',
      },
      ctx,
    );
    expect(r.code).toBe(200);
    expect(uploads.at(-1)).toMatchObject({ name: 'xbox.png', type: 'image/png' });
    const avif = await s.call(
      'media.upload',
      {
        itemPath: '/sitecore/media library/Project/Brands/ansco/Home/xbox',
        ref: 'blob://p1/assets/avif789.bin',
      },
      ctx,
    );
    expect(avif.code).toBe(422);
    expect(JSON.stringify(avif.body)).toContain('fmt=png-alpha');
  });

  it('uploads a file the browser already downloaded, by its ref', async () => {
    const { s, uploads } = setup();
    const r = await s.call(
      'media.upload',
      {
        itemPath: '/sitecore/media library/Project/Brands/ansco/Benefits/hsa',
        ref: 'blob://p1/assets/abc123.png',
        fileName: 'hsa.png',
      },
      ctx,
    );
    expect(r).toMatchObject({ code: 200, body: { bytes: 6 } });
    expect(uploads).toEqual([
      { url: 'https://up.example/x', name: 'hsa.png', type: 'image/png', size: 6 },
    ]);
  });

  it('uploads a file the Director gave the team, by its ref', async () => {
    const { s, uploads } = setup();
    const r = await s.call(
      'media.upload',
      {
        itemPath: '/sitecore/media library/Project/Brands/ansco/Shared/logo',
        ref: 'blob://p1/files/file-1a2b3c4d-paylocity-logo.svg',
        fileName: 'logo.svg',
      },
      ctx,
    );
    expect(r.code).toBe(200);
    expect(uploads).toEqual([
      { url: 'https://up.example/x', name: 'logo.svg', type: 'image/svg+xml', size: 6 },
    ]);
    // Anything else stored for the project isn't for the media library.
    expect(
      (
        await s.call(
          'media.upload',
          { itemPath: '/sitecore/media library/x', ref: 'blob://p1/sessions/t1.json' },
          ctx,
        )
      ).code,
    ).toBe(422);
  });

  it('takes the media library path in any casing, as Sitecore does', async () => {
    const { s, uploads } = setup();
    const r = await s.call(
      'media.upload',
      {
        itemPath: '/sitecore/Media Library/Project/Brands/ansco/Benefits/hsa',
        ref: 'blob://p1/assets/abc123.png',
        fileName: 'hsa.png',
      },
      ctx,
    );
    expect(r.code).toBe(200);
    expect(uploads).toHaveLength(1);
  });

  it('uploads a file whose media type has no Alt field, its description in Title', async () => {
    const { s, uploads, queries } = setup();
    const r = await s.call(
      'media.upload',
      {
        itemPath: '/sitecore/media library/Project/Brands/ansco/files/code-of-conduct',
        ref: 'blob://p1/assets/abc123.png',
        fileName: 'code-of-conduct.pdf',
        alt: 'Supplier Code of Conduct',
      },
      ctx,
    );
    expect(r).toMatchObject({ code: 200, body: { alt: null, title: 'Supplier Code of Conduct' } });
    expect(r.summary).toContain(
      'no Alt field on this media type, so its description went in Title',
    );
    expect(queries.some((q) => /updateItem\(/.test(q) && /name: "Title"/.test(q))).toBe(true);
    expect(uploads).toHaveLength(1);
  });

  it("refuses another project's file, and points a CDN URL at the download step", async () => {
    const { s } = setup();
    const path = '/sitecore/media library/Project/Brands/ansco/x';
    expect(
      (await s.call('media.upload', { itemPath: path, ref: 'blob://p2/assets/abc123.png' }, ctx))
        .code,
    ).toBe(422);
    const cdn = await s.call(
      'media.upload',
      {
        itemPath: path,
        sourceUrl: 'https://eadn-wc03-3197147.nxedge.io/wp-content/uploads/hsa.png',
      },
      ctx,
    );
    expect(cdn).toMatchObject({ code: 422 });
    expect(JSON.stringify(cdn.body)).toContain('browser.fetch.asset');
    expect((await s.call('media.upload', { itemPath: path }, ctx)).code).toBe(422);
  });
});

describe('site.thumbnail', () => {
  it("sets only this project's site, and only from a thumbnail the browser made", async () => {
    const { s, uploads } = setup();
    const other = await s.call(
      'site.thumbnail',
      {
        sitePath: '/sitecore/content/Brands/icreon',
        ref: 'blob://p1/assets/site-thumbnail-0123456789abcdef.png',
      },
      ctx,
    );
    expect(other).toMatchObject({ code: 422 });
    expect((other.body as { error: string }).error).toBe(
      "/sitecore/content/Brands/icreon isn't this project's site: give /sitecore/content/Brands/ansco.",
    );
    const notPng = await s.call(
      'site.thumbnail',
      { sitePath: '/sitecore/content/Brands/ansco', ref: 'blob://p1/assets/report.pdf' },
      ctx,
    );
    expect((notPng.body as { error: string }).error).toMatch(
      /Give the PNG browser\.brand\.thumbnail made/,
    );
    expect(uploads).toEqual([]);
  });
});
