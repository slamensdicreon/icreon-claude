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
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/graphql/v1/')) {
      const { query } = JSON.parse(String(init!.body)) as { query: string };
      if (/uploadMedia\(/.test(query))
        return Response.json({
          data: { uploadMedia: { presignedUploadUrl: 'https://up.example/x' } },
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
  };
}

describe('media.upload', () => {
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

  it('uploads a file whose media type has no Alt field, without alt text', async () => {
    const { s, uploads } = setup();
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
    expect(r).toMatchObject({ code: 200, body: { alt: null } });
    expect(r.summary).toContain('no Alt field on this media type');
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
