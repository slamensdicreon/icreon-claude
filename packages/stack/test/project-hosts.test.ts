import { describe, expect, it } from 'vitest';
import { hostsNamedIn, projectHosts } from '../src/compose';

describe('projectHosts', () => {
  it("lists the new site's production, editing and provider addresses", () => {
    expect(
      projectHosts({
        project: 'dycom-ansco-associates-sitecoreai-v2',
        url: 'https://dycom-ansco-associates-sitecoreai-v.vercel.app',
      }),
    ).toEqual([
      'dycom-ansco-associates-sitecoreai-v.vercel.app',
      'dycom-ansco-associates-sitecoreai-v2-editing.vercel.app',
      'dycom-ansco-associates-s*.vercel.app',
    ]);
    expect(projectHosts(null)).toEqual([]);
  });
});

describe('hostsNamedIn', () => {
  it('finds media hosts written as URLs, inside encoded URLs, and without a scheme', () => {
    const doc = JSON.stringify({
      origin: 'https://www.acme.com',
      hero: 'https://www.acme.com/_next/image?url=https%3A%2F%2Fcdn.acme-media.net%2Fhero.jpg&w=1920',
      media: { host: 'edge.sitecorecloud.io/acme1234/media/Project/Acme/…' },
      note: 'read the img src at the selector; asset lives under edge.sitecorecloud.io/acme1234/logo',
      tools: 'browser.page.markup and item.read, logo.svg 120x25, steve@acme.com',
    });
    expect(hostsNamedIn(doc).sort()).toEqual([
      'cdn.acme-media.net',
      'edge.sitecorecloud.io',
      'www.acme.com',
    ]);
  });
});
