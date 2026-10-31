import { describe, expect, it } from 'vitest';
import { sitecoreFacts } from '../sitecoreai/facts';

const bindings = { sitePath: '/sitecore/content/Brands/lamberts' };
const authoring = (op: string, args: Record<string, unknown>) => ({
  server: 'sitecore-authoring',
  op,
  args,
});

describe('SitecoreAI facts', () => {
  it('records a rendering by name with its ID and component', () => {
    const facts = sitecoreFacts(
      authoring('rendering.create', {
        parentPath: '/sitecore/layout/Renderings/Project/lamberts',
        name: 'Hero Banner',
        componentName: 'HeroBanner',
        datasourceTemplatePath: '/sitecore/templates/Project/lamberts/Hero Banner',
      }),
      { itemId: 'abc', path: '/sitecore/layout/Renderings/Project/lamberts/Hero Banner' },
      bindings,
    );
    expect(facts).toEqual([
      expect.objectContaining({
        kind: 'rendering',
        key: 'Hero Banner',
        value: expect.objectContaining({ id: 'abc', componentName: 'HeroBanner' }),
      }),
    ]);
  });

  it('records items under Home as pages by route, under Data as datasources', () => {
    const page = sitecoreFacts(
      authoring('item.create', {
        parentPath: '/sitecore/content/Brands/lamberts/Home',
        name: 'about-us',
        templatePath: '/sitecore/templates/Project/lamberts/Page',
      }),
      { itemId: 'p1', path: '/sitecore/content/Brands/lamberts/Home/about-us' },
      bindings,
    );
    expect(page[0]).toMatchObject({ kind: 'page', key: '/about-us', value: { id: 'p1' } });
    const home = sitecoreFacts(
      authoring('item.create', { parentPath: '/sitecore/content/Brands/lamberts', name: 'Home' }),
      { itemId: 'h', path: '/sitecore/content/Brands/lamberts/Home', existed: true },
      bindings,
    );
    expect(home[0]).toMatchObject({ kind: 'page', key: '/' });
    const ds = sitecoreFacts(
      authoring('item.create', {
        parentPath: '/sitecore/content/Brands/lamberts/Data/Heroes',
        name: 'Home Hero',
      }),
      { itemId: 'd1', path: '/sitecore/content/Brands/lamberts/Data/Heroes/Home Hero' },
      bindings,
    );
    expect(ds[0]).toMatchObject({ kind: 'datasource', key: 'Heroes/Home Hero' });
  });

  it('records the components a page has, in order', () => {
    const facts = sitecoreFacts(
      authoring('layout.compose', {
        path: '/sitecore/content/Brands/lamberts/Home/about-us',
        renderings: [
          {
            rendering: '/sitecore/layout/Renderings/Project/lamberts/Hero Banner',
            placeholder: 'headless-main',
          },
          { rendering: '{1234}', placeholder: 'headless-main' },
        ],
      }),
      { itemId: 'p1', path: '/sitecore/content/Brands/lamberts/Home/about-us', renderings: 2 },
      bindings,
    );
    expect(facts[0]).toMatchObject({
      kind: 'layout',
      key: '/about-us',
      value: { components: 'Hero Banner, {1234}', placeholders: 'headless-main', count: 2 },
    });
  });

  it('records media by its source, and nothing from failed or other calls', () => {
    const media = sitecoreFacts(
      authoring('media.upload', {
        itemPath: '/sitecore/media library/Project/Brands/lamberts/hero',
        sourceUrl: 'https://lambertscable.com/img/hero.jpg',
      }),
      {
        itemPath: '/sitecore/media library/Project/Brands/lamberts/hero',
        itemId: 'm1',
        bytes: 10,
        alt: null,
      },
      bindings,
    );
    expect(media[0]).toMatchObject({
      kind: 'media',
      key: 'https://lambertscable.com/img/hero.jpg',
      value: { id: 'm1' },
    });
    expect(
      sitecoreFacts(authoring('item.create', { name: 'x' }), { error: 'no' }, bindings),
    ).toEqual([]);
    expect(sitecoreFacts({ server: 'github', op: 'x', args: {} }, {}, bindings)).toEqual([]);
  });
});
