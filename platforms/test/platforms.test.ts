import { fileURLToPath } from 'node:url';
import { IntakeFacts } from '@lw/contracts';
import { SITECORE_DEFAULTS } from '@lw/connectors';
import { loadCatalog } from '@lw/playbook-sdk';
import { describe, expect, it } from 'vitest';
import { createPlatforms, IntakeError, intakeSpec, sitecoreTarget, validateTarget } from '../src';

const PLAYBOOKS = fileURLToPath(new URL('../../playbooks', import.meta.url));
const platforms = createPlatforms({ sitecore: SITECORE_DEFAULTS });

describe('platform packs', () => {
  it('give every playbook in the catalog its intake fields and credentials', async () => {
    const catalog = await loadCatalog(PLAYBOOKS);
    for (const { playbook } of catalog.values()) {
      const pack = platforms.get(playbook.manifest.platform);
      expect(pack, `${playbook.manifest.id} names a platform pack`).toBeDefined();
      expect(() => intakeSpec(playbook, pack!)).not.toThrow();
    }
  });

  it('check target values against the intake the playbook declares', async () => {
    const catalog = await loadCatalog(PLAYBOOKS);
    const pack = platforms.get('sitecoreai')!;
    const spec = intakeSpec(catalog.get('sitecoreai-migration')!.playbook, pack);
    const target = pack.normalize(
      validateTarget(spec, {
        cmHost: 'https://xmc-globex.sitecorecloud.io/',
        siteCollection: 'Brands',
        site: 'globex',
        languages: 'en, es-US',
        hostingProject: 'globex-site',
        stray: 'ignored',
      }),
    );
    expect(target).toEqual({
      cmHost: 'xmc-globex.sitecorecloud.io',
      siteCollection: 'Brands',
      site: 'globex',
      languages: ['en', 'es-US'],
      hostingProject: 'globex-site',
    });
    expect(pack.bindings(target)).toMatchObject({
      sitePath: '/sitecore/content/Brands/globex',
      project: 'Brands/globex',
    });
    expect(pack.toolCredential('sitecore-authoring')?.credentialId).toBe('sitecore-environment');
    expect(pack.toolCredential('github')).toBeUndefined();
    expect(() =>
      validateTarget(spec, { cmHost: 'x', site: 'globex', hostingProject: 'Bad Name' }),
    ).toThrow(IntakeError);
  });

  it('read intake recorded before playbooks declared their own as SitecoreAI targets', () => {
    const legacy = IntakeFacts.parse({
      repo: 'slamensdicreon/dycom-ansco-associates',
      branch: 'main',
      cmHost: 'xmc-example.sitecorecloud.io',
      siteCollection: 'Brands',
      site: 'ansco',
      languages: ['en'],
      hosting: { provider: 'vercel', project: 'dycom-ansco-associates' },
    });
    expect(legacy).toMatchObject({
      platform: 'sitecoreai',
      repo: 'slamensdicreon/dycom-ansco-associates',
    });
    expect(sitecoreTarget(legacy)).toEqual({
      cmHost: 'xmc-example.sitecorecloud.io',
      siteCollection: 'Brands',
      site: 'ansco',
      languages: ['en'],
      hostingProject: 'dycom-ansco-associates',
    });
  });
});
