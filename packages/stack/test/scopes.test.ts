import { fileURLToPath } from 'node:url';
import { loadPlaybook } from '@lw/playbook-sdk';
import { inScope } from '@lw/tool-gateway';
import { describe, expect, it } from 'vitest';
import { sitecoreBindings } from '@lw/platforms';

const PLAYBOOK = fileURLToPath(new URL('../../../playbooks/sitecoreai-migration', import.meta.url));
// Ansco shares the Brands collection with another team's site, new-brand.
const ansco = sitecoreBindings({ siteCollection: 'Brands', site: 'ansco' });

describe('write scopes in a shared collection', () => {
  it("reach only the project's own site and folders, never a neighbouring site's", async () => {
    const pb = await loadPlaybook(PLAYBOOK);
    const paths = (role: string) =>
      Object.values(pb.roles.find((r) => r.role === role)!.tools).flatMap(
        (g) => g.scope?.paths ?? [],
      );
    const can = (role: string, path: string) => inScope(path, paths(role), ansco);

    expect(can('deployment-engineer', '/sitecore/content/Brands/ansco/Home')).toBe(true);
    expect(can('deployment-engineer', '/sitecore/content/Brands/new-brand/Home')).toBe(false);
    expect(can('deployment-engineer', '/sitecore/templates/Project/Brands')).toBe(true);
    expect(can('deployment-engineer', '/sitecore/templates/Project/Brands/new-brand/Page')).toBe(
      false,
    );
    expect(can('rendering-registrar', '/sitecore/templates/Project/Brands/ansco/Page')).toBe(true);
    expect(can('rendering-registrar', '/sitecore/templates/Project/Brands/Hero')).toBe(false);
    expect(
      can('rendering-registrar', '/sitecore/layout/Renderings/Project/Brands/ansco/Hero'),
    ).toBe(true);
    expect(can('rendering-registrar', '/sitecore/layout/Renderings/Project/Brands/Hero')).toBe(
      false,
    );
    expect(can('media-migrator', '/sitecore/media library/Project/Brands/ansco/hero.jpg')).toBe(
      true,
    );
    expect(can('media-migrator', '/sitecore/media library/Project/Brands/new-brand/hero.jpg')).toBe(
      false,
    );
    expect(can('content-migrator', '/sitecore/content/Brands/new-brand/Data/Hero')).toBe(false);
  });
});
