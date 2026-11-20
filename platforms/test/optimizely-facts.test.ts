import { describe, expect, it } from 'vitest';
import { optimizelyFacts } from '../optimizely/facts';

const bindings = {
  application: 'Acme_Site',
  contentRoot: '/content/Acme_Site',
  sharedRoot: '/shared/Acme_Site',
  mediaRoot: '/media/Acme_Site',
};
const cms = (op: string, args: Record<string, unknown> = {}) => ({
  server: 'optimizely-cms',
  op,
  args,
});

describe('Optimizely facts', () => {
  it('records the application with where its start page is', () => {
    expect(
      optimizelyFacts(
        cms('application.create', { entryType: 'AcmeExperience' }),
        { key: 'Acme_Site', startPage: { key: 'abc' }, assetsRoot: 'def' },
        bindings,
      ),
    ).toEqual([
      expect.objectContaining({
        kind: 'application',
        key: 'Acme_Site',
        value: {
          key: 'Acme_Site',
          startPage: '/content/Acme_Site',
          startPageKey: 'abc',
          assetsRoot: 'def',
        },
      }),
    ]);
  });

  it('records a page by its route and a shared block by its name, with their state', () => {
    const page = {
      path: '/content/Acme_Site/about/team',
      key: 'k1',
      ref: 'cms://content/k1',
      contentType: 'AcmeExperience',
      status: 'draft',
    };
    expect(optimizelyFacts(cms('content.create'), page, bindings)[0]).toMatchObject({
      kind: 'page',
      key: '/about/team',
      value: { path: page.path, key: 'k1', status: 'draft' },
    });
    expect(
      optimizelyFacts(
        cms('content.publish'),
        { path: '/content/Acme_Site', key: 'k0' },
        bindings,
      )[0],
    ).toMatchObject({
      kind: 'page',
      key: '/',
      value: { status: 'published', ref: 'cms://content/k0' },
    });
    expect(
      optimizelyFacts(
        cms('content.create', { contentType: 'AcmeSiteHeader' }),
        { path: '/shared/Acme_Site/Site Header', key: 'k2' },
        bindings,
      )[0],
    ).toMatchObject({
      kind: 'shared-block',
      key: 'Site Header',
      value: { contentType: 'AcmeSiteHeader' },
    });
  });

  it('records what a page is composed of', () => {
    expect(
      optimizelyFacts(
        cms('composition.write'),
        {
          path: '/content/Acme_Site',
          sections: [
            { name: 'Hero', contentType: 'AcmeHero' },
            { name: 'Cards', contentType: 'AcmeCardGrid' },
          ],
        },
        bindings,
      ),
    ).toEqual([
      expect.objectContaining({
        kind: 'layout',
        key: '/',
        value: { components: 'AcmeHero, AcmeCardGrid', count: 2 },
      }),
    ]);
  });

  it('records media by where it came from, so the next task finds it from the source', () => {
    const body = {
      path: '/media/Acme_Site/Home/hero.webp',
      key: 'm1',
      ref: 'cms://content/m1',
      alt: 'A hero',
    };
    expect(
      optimizelyFacts(cms('media.upload', { ref: 'blob://p/assets/hero.webp' }), body, bindings)[0],
    ).toMatchObject({
      kind: 'media',
      key: 'blob://p/assets/hero.webp',
      value: { path: body.path, ref: 'cms://content/m1', alt: 'A hero' },
    });
  });

  it('records the host and the pushed content model, and nothing for a dry run or a refusal', () => {
    expect(
      optimizelyFacts(
        cms('hostname.add', { host: 'acme.vercel.app' }),
        { hosts: [{ host: 'acme.vercel.app', type: 'primary' }] },
        bindings,
      )[0],
    ).toMatchObject({
      kind: 'host',
      value: { url: 'https://acme.vercel.app' },
    });
    const cli = (body: unknown) =>
      optimizelyFacts(
        { server: 'sandbox', op: 'exec.optimizely-cli', args: { command: 'push' } },
        body,
        bindings,
      );
    expect(
      cli({ sent: true, contentTypes: ['AcmeHero'], displayTemplates: ['AcmeHeroDefault'] })[0],
    ).toMatchObject({ kind: 'content-model', value: { count: 1 } });
    expect(cli({ sent: false, contentTypes: ['AcmeHero'] })).toEqual([]);
    expect(optimizelyFacts(cms('content.create'), { error: 'refused' }, bindings)).toEqual([]);
    expect(
      optimizelyFacts(
        { server: 'sitecore-authoring', op: 'item.create', args: {} },
        { path: '/x', key: 'k' },
        bindings,
      ),
    ).toEqual([]);
  });
});
