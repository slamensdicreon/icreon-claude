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
    for (const id of ['sitecoreai-migration', 'optimizely-saas-migration']) {
      const pb = await loadPlaybook(dir(id));
      found[id] = uncheckedValidators(pb, platforms.get(pb.manifest.platform)?.checks ?? {});
    }
    expect(found['sitecoreai-migration']).toEqual(EXPECTED_SITECORE);
    expect(found['optimizely-saas-migration']).toEqual(EXPECTED_OPTIMIZELY);
  });
});

// A change to either list is a decision, not an accident.
// SitecoreAI: both need an agent in Page builder (M7, page-builder.drive).
const EXPECTED_SITECORE = ['editor.component-enabled', 'editor.new-datasource'];
// Optimizely: the platform's checks (entities.md, O4) and its Visual Builder driver (O5).
const EXPECTED_OPTIMIZELY = [
  'editor.element-enabled',
  'editor.new-experience',
  'experience.redirects-resolve',
  'graph.published',
  'head.header-footer',
  'head.pages-render',
  'head.preview-route',
  'hostname.registered',
  'manifest.replays',
  'media.alt-text',
  'parity.page',
  'parity.render',
  'parity.visual',
  'routes.resolve',
  'structural.application',
  'structural.content-types',
  'structural.experiences',
  'structural.templates',
  'types.defined',
  'types.pushed',
];
