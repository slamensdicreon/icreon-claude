import { fileURLToPath } from 'node:url';
import { optimizelyBindings } from '@lw/platforms';
import { loadPlaybook } from '@lw/playbook-sdk';
import { inScope } from '@lw/tool-gateway';
import { OptimizelyCmsToolServer, OptimizelyGraphToolServer } from '@lw/tool-optimizely';
import { describe, expect, it } from 'vitest';
import { CHECKS } from '../src';

const dir = (id: string) => fileURLToPath(new URL(`../../../playbooks/${id}`, import.meta.url));
const PLAYBOOKS = ['optimizely-saas-migration', 'optimizely-homepage-demo'];
// Two projects on one instance: content types, templates and Graph are shared between them.
const acme = optimizelyBindings({ application: 'Acme Site', typePrefix: 'Acme' });

describe('Optimizely playbooks and the servers they call', () => {
  const catalogs: Record<string, Record<string, unknown>> = {
    'optimizely-cms': new OptimizelyCmsToolServer({ facts: async () => null }).catalog,
    'optimizely-graph': new OptimizelyGraphToolServer({ facts: async () => null }).catalog,
  };

  it.each(PLAYBOOKS)('%s grants only operations that exist', async (id) => {
    const pb = await loadPlaybook(dir(id));
    const unknown = pb.roles.flatMap((r) =>
      Object.entries(r.tools)
        .filter(([server]) => server in catalogs)
        .flatMap(([server, grant]) =>
          grant.ops
            .filter((op) => !(op in catalogs[server]!))
            .map((op) => `${r.role}: ${server}.${op}`),
        ),
    );
    expect(unknown).toEqual([]);
  });

  it.each(PLAYBOOKS)("%s writes only inside the project's own application", async (id) => {
    const pb = await loadPlaybook(dir(id));
    const paths = (role: string) =>
      Object.values(pb.roles.find((r) => r.role === role)!.tools).flatMap(
        (g) => g.scope?.paths ?? [],
      );
    const can = (role: string, path: string) => inScope(path, paths(role), acme);

    expect(can('content-migrator', '/content/Acme_Site')).toBe(true);
    expect(can('content-migrator', '/content/Acme_Site/about')).toBe(true);
    expect(can('content-migrator', '/shared/Acme_Site/Site Header')).toBe(true);
    expect(can('content-migrator', '/content/Globex_Site/about')).toBe(false);
    expect(can('content-migrator', '/shared/Globex_Site/Site Header')).toBe(false);
    expect(can('media-migrator', '/media/Acme_Site/Home/hero.webp')).toBe(true);
    expect(can('media-migrator', '/media/Globex_Site/Home/hero.webp')).toBe(false);
    // Nobody is granted the whole tree to write.
    for (const role of pb.roles)
      for (const grant of Object.values(role.tools))
        for (const p of grant.scope?.paths ?? [])
          expect(/^\/(content|shared|media)\/\*\*/.test(p), `${role.role}: ${p}`).toBe(false);
  });
});

describe('Optimizely content-model checks from the task’s own steps', () => {
  let n = 0;
  const step = (toolServer: string, operation: string, summary: string, resultCode = 200) =>
    ({
      type: 'step.recorded',
      data: { stepId: `s${++n}`, toolServer, operation, summary, resultCode },
    }) as never;
  const run = (id: string, steps: unknown[]) => CHECKS[id]!({ steps } as never);
  const dry = (types = 3, templates = 2) =>
    step(
      'sandbox',
      'exec.optimizely-cli',
      `Content model valid: ${types} content types, ${templates} display templates (dry run, nothing sent)`,
    );

  it('types.defined wants a clean dry run with nothing written after it', async () => {
    expect(await run('types.defined', [])).toMatchObject({ status: 'fail' });
    expect(
      await run('types.defined', [step('sandbox', 'fs.write', 'Wrote Hero.model.ts'), dry()]),
    ).toMatchObject({ status: 'pass' });
    expect(
      await run('types.defined', [dry(), step('sandbox', 'fs.write', 'Wrote Hero.model.ts')]),
    ).toMatchObject({ status: 'fail' });
    const refused = step(
      'sandbox',
      'exec.optimizely-cli',
      "These keys don't start with the project's prefix Acme: Hero",
      422,
    );
    expect(await run('types.defined', [refused])).toMatchObject({ status: 'fail' });
  });

  it('manifest.replays wants the repository to build what the CMS holds', async () => {
    const exported = (types = 3, templates = 2) =>
      step(
        'optimizely-cms',
        'manifest.export',
        `Manifest: ${types} content types and ${templates} display templates with the prefix Acme`,
      );
    expect(await run('manifest.replays', [exported(), dry()])).toMatchObject({ status: 'pass' });
    const drifted = await run('manifest.replays', [exported(4, 2), dry(3, 2)]);
    expect(drifted).toMatchObject({ status: 'fail' });
    expect(drifted.detail).toContain('drifted');
    expect(await run('manifest.replays', [dry()])).toMatchObject({ status: 'fail' });
    expect(await run('manifest.replays', [exported()])).toMatchObject({ status: 'fail' });
  });
});
