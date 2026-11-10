import { SITECORE_DEFAULTS } from '@lw/connectors';
import { describe, expect, it } from 'vitest';
import { createPlatforms } from '../src';

const check = createPlatforms({ sitecore: SITECORE_DEFAULTS }).get('sitecoreai')!.checks![
  'site.thumbnail'
]!;
const target = {
  cmHost: 'xmc.sitecorecloud.io',
  siteCollection: 'brands',
  site: 'acme',
  languages: ['en'],
};
const SITE = '/sitecore/content/brands/acme';
const SYSTEM = '/sitecore/media library/Project/brands/acme/System';

/** The tenant: the site's thumbnail field, and what its System media folder holds. */
const ctx = (thumbnail: string, media: { name: string; id: string; width?: number }[] = []) => ({
  projectId: 'p',
  target,
  scope: { collection: null, items: [] },
  blueprint: null,
  credential: async () => null,
  document: async () => null,
  read: async (_s: string, _op: string, a: Record<string, unknown>) => {
    if (a.path === SITE)
      return {
        code: 200,
        body: { fields: { nodes: [{ name: '__Thumbnail', value: thumbnail }] } },
      };
    if (a.path === SYSTEM)
      return {
        code: 200,
        body: {
          children: {
            nodes: media.map((m) => ({ name: m.name, itemId: m.id, path: `${SYSTEM}/${m.name}` })),
          },
        },
      };
    const m = media.find((x) => a.path === `${SYSTEM}/${x.name}`);
    if (m)
      return {
        code: 200,
        body: {
          itemId: m.id,
          fields: {
            nodes: [
              { name: 'Width', value: String(m.width) },
              { name: 'Height', value: '640' },
            ],
          },
        },
      };
    return { code: 404, body: {} };
  },
});

describe('the site thumbnail check', () => {
  it('fails a site the dashboard shows as a screenshot', async () => {
    const r = await check(ctx(''));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(
      /no thumbnail of its own.*browser\.brand\.thumbnail.*sitecore-authoring\.site\.thumbnail/,
    );
  });

  it('passes its brand thumbnail at full size, in either ID spelling', async () => {
    const media = [
      { name: 'site-thumbnail-58f5e4a97ea8', id: '6BDDA87BF8D449169E378A3E18A67C66', width: 1200 },
    ];
    for (const id of [
      '6bdda87b-f8d4-4916-9e37-8a3e18a67c66',
      '{6BDDA87B-F8D4-4916-9E37-8A3E18A67C66}',
    ])
      expect(await check(ctx(`<image mediaid='${id}' />`, media))).toEqual({
        status: 'pass',
        detail: `The site's thumbnail is its brand image (${SYSTEM}/site-thumbnail-58f5e4a97ea8, 1200×640).`,
      });
  });

  it('fails a small one, and accepts one the Director set by hand', async () => {
    const small = [
      { name: 'site-thumbnail-abc', id: '11111111222233334444555555555555', width: 600 },
    ];
    expect(
      (await check(ctx(`<image mediaid='11111111-2222-3333-4444-555555555555' />`, small))).detail,
    ).toMatch(/600×640: make it again/);
    expect(
      await check(ctx(`<image mediaid='99999999-2222-3333-4444-555555555555' />`, small)),
    ).toEqual({
      status: 'pass',
      detail: 'The site has a thumbnail of its own in the Sites dashboard (set there by hand).',
    });
  });
});
