import { fileURLToPath } from 'node:url';
import { OPTIMIZELY_DEFAULTS, SITECORE_DEFAULTS } from '@lw/connectors';
import { createPlatforms } from '@lw/platforms';
import { loadPlaybook } from '@lw/playbook-sdk';
import { describe, expect, it } from 'vitest';
import { uncheckedValidators } from '../src';

const dir = (id: string) => fileURLToPath(new URL(`../../../playbooks/${id}`, import.meta.url));
const platforms = createPlatforms({ sitecore: SITECORE_DEFAULTS, optimizely: OPTIMIZELY_DEFAULTS });

describe('acceptance check coverage', () => {
  it('names every check a playbook relies on that nothing implements', async () => {
    const found: Record<string, string[]> = {};
    for (const id of [
      'sitecoreai-migration',
      'sitecoreai-homepage-demo',
      'optimizely-saas-migration',
      'optimizely-homepage-demo',
      'optimizely-customer-portal',
    ]) {
      const pb = await loadPlaybook(dir(id));
      found[id] = uncheckedValidators(pb, platforms.get(pb.manifest.platform)?.checks ?? {});
    }
    expect(found['sitecoreai-migration']).toEqual(EXPECTED_SITECORE);
    // The demo uses the website playbook's checks and its own slice check, all implemented.
    expect(found['sitecoreai-homepage-demo']).toEqual([]);
    expect(found['optimizely-saas-migration']).toEqual(EXPECTED_OPTIMIZELY);
    expect(found['optimizely-homepage-demo']).toEqual(EXPECTED_OPTIMIZELY_DEMO);
    // The portal's own checks (its Blueprint, the sign-in, pages read as a persona, content by
    // role, production) are in the Optimizely pack; the rest are the website playbooks'.
    expect(found['optimizely-customer-portal']).toEqual([]);
  });
});

// A change to either list is a decision, not an accident.
// SitecoreAI: every check is implemented (the two Page builder checks read the renderings'
// configuration since the pilot proof was automated; Page builder itself is checked at UAT).
const EXPECTED_SITECORE: string[] = [];
// Optimizely: every check its two playbooks name is implemented.
const EXPECTED_OPTIMIZELY: string[] = [];
const EXPECTED_OPTIMIZELY_DEMO: string[] = [];
