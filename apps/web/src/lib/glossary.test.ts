import { describe, expect, it } from 'vitest';
import { baseGlossary, termPattern } from './glossary';

const terms = (platformId?: string | null) => baseGlossary(platformId).map((t) => t.term);

describe('baseGlossary', () => {
  it("gives a project its platform's terms and the shared ones", () => {
    expect(terms('sitecoreai')).toEqual(
      expect.arrayContaining(['Page builder', 'Experience Edge', 'SXA', 'parity', 'pull request']),
    );
    expect(terms('optimizely')).toEqual(
      expect.arrayContaining(['Visual Builder', 'Optimizely Graph', 'display template', 'parity']),
    );
  });

  it("never gives a project another platform's words", () => {
    const optimizely = JSON.stringify(baseGlossary('optimizely'));
    expect(optimizely).not.toMatch(/Sitecore|Page builder|Experience Edge|SXA/);
    expect(JSON.stringify(baseGlossary('sitecoreai'))).not.toMatch(/Optimizely|Visual Builder/);
    for (const id of [undefined, null, 'some-other-cms'])
      expect(JSON.stringify(baseGlossary(id))).not.toMatch(/Sitecore|Optimizely/);
  });

  it('defines each term once per platform', () => {
    for (const id of ['sitecoreai', 'optimizely']) {
      const keys = terms(id).map((t) => t.toLowerCase());
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe('termPattern', () => {
  it('finds a term in any case, with a plural', () => {
    expect(termPattern({ term: 'display template', meaning: '' }).test('Display templates')).toBe(
      true,
    );
  });

  it("leaves the project's Blueprint alone when defining the CMS's blueprints", () => {
    const blueprint = baseGlossary('optimizely').find((t) => t.term === 'blueprint')!;
    expect(termPattern(blueprint).test('one of the blueprints editors start from')).toBe(true);
    expect(termPattern(blueprint).test('the approved Blueprint keeps 40 pages')).toBe(false);
  });
});
