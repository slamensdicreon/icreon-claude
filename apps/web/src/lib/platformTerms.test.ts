import { describe, expect, it } from 'vitest';
import { platformTerms } from './platformTerms';

describe('platformTerms', () => {
  it("gives each platform's own nouns by its pack id", () => {
    expect(platformTerms('sitecoreai')).toEqual({
      vendor: 'Sitecore',
      editor: 'Page builder',
      delivery: 'Experience Edge',
    });
    expect(platformTerms('optimizely')).toEqual({
      vendor: 'Optimizely',
      editor: 'Visual Builder',
      delivery: 'Optimizely Graph',
    });
  });

  it("names no platform when the project's is unknown", () => {
    for (const id of [undefined, null, '', 'some-other-cms'])
      expect(JSON.stringify(platformTerms(id))).not.toMatch(/Sitecore|Optimizely|Page builder/);
  });
});
