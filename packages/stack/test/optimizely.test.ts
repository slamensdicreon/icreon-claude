import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixtures } from '@lw/orchestrator';
import { compilePlan } from '@lw/plan';
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

describe('Optimizely website playbook: the order the platform sets', () => {
  const DIR = dir('optimizely-saas-migration');

  it('pushes the page types before the application, and proves the pilot on it', async () => {
    const pb = await loadPlaybook(DIR);
    const { blueprint } = await loadFixtures(DIR);
    const plan = compilePlan(pb, blueprint, { skipMerged: true });
    const task = (id: string) => plan.tasks.find((t) => t.taskId === id)!;
    const order = plan.tasks.map((t) => t.taskId);
    const before = (a: string, b: string) => order.indexOf(a) < order.indexOf(b);

    // An application can't exist without its start page, of a page type already in the CMS.
    expect(task('approve-provision-application').dependsOn.sort()).toEqual(
      blueprint.collections.templates!.map((t) => `push-type-${t.key}`).sort(),
    );
    // A page type refers to the header's and footer's types: it waits on those, not on every
    // component (the example marks none shared, so their names stand for them).
    expect(task('push-type-home').dependsOn.sort()).toEqual([
      'define-type-home',
      'integrate-footer',
      'integrate-head',
      'integrate-header',
      'integrate-navigation',
    ]);
    // Everything that reads the application, its host or Graph comes after it.
    for (const id of [
      'validate-foundation',
      'compose-pilot',
      'prove-pilot-slice',
      'migrate-shared-chrome',
      'migrate-pages-page-1',
      'publish-site',
    ])
      expect(before('provision-application', id), id).toBe(true);
    const needApplication = new Set([
      'structural.application',
      'hostname.registered',
      'head.preview-route',
      'graph.published',
      'head.header-footer',
      'head.pages-render',
      'parity.render',
      'parity.visual',
      'routes.resolve',
    ]);
    for (const t of plan.tasks)
      if (t.acceptance.some((a) => needApplication.has(a.replace('validator:', ''))))
        expect(
          t.taskId === 'provision-application' || before('provision-application', t.taskId),
          t.taskId,
        ).toBe(true);
    // types.pushed wants every component's and page type's content type in the CMS.
    for (const t of pb.plan.templates.filter((t) =>
      t.acceptance.includes('validator:types.pushed'),
    ))
      expect(['prove-pilot-slice', 'validate-components'], t.id).toContain(t.id);

    // The pilot: its components and the shared ones, composed, published and read back before
    // the rest is built.
    const checkpoint = task('pilot-checkpoint');
    expect(checkpoint.itemKeys.sort()).toEqual([
      'footer',
      'header',
      'hero',
      'navigation',
      'promo-card',
      'rich-text',
    ]);
    expect(checkpoint.dependsOn).toEqual(
      expect.arrayContaining(['compose-pilot', 'prove-pilot-slice']),
    );
    expect(task('prove-pilot-slice').itemKeys.sort()).toEqual(checkpoint.itemKeys.sort());
    expect(task('port-card-grid').dependsOn).toContain('pilot-checkpoint');
    expect(order).not.toContain('register-editing-hostname');
  });

  it('publishes where the head is judged, as releases the Director approves', async () => {
    const pb = await loadPlaybook(DIR);
    const template = (id: string) => pb.plan.templates.find((t) => t.id === id)!;
    // The head shows published content only: these tasks publish what they wrote.
    for (const id of ['compose-pilot', 'migrate-shared-chrome', 'migrate-pages-{key}'])
      expect(template(id).release, id).toBeDefined();
    expect(
      pb.roles.find((r) => r.role === 'content-migrator')!.tools['optimizely-cms']!.ops,
    ).toContain('content.publish');
    // A client's instance: no release is approved by the playbook.
    for (const t of pb.plan.templates) expect(t.release?.standing, t.id).toBeUndefined();
    // The API key's content rights are confirmed before Gate 1; Visual Builder has no driver.
    expect(template('confirm-content-rights')).toMatchObject({
      phase: 0,
      manual: expect.stringContaining('Set Access Rights'),
    });
    for (const id of ['smoke-test', 'prove-experimentation'])
      expect(template(id).manual, id).toBeDefined();
    // No check that reads another platform's contract or endpoints.
    const named = pb.plan.templates.flatMap((t) => t.acceptance);
    expect(named).not.toContain('validator:blueprint.coverage');
    expect(named).not.toContain('validator:editing-host.responds');
  });

  it('names in its prompts only tools the role is granted, and only validator runs that exist', async () => {
    const pb = await loadPlaybook(DIR);
    const servers = new Set(pb.roles.flatMap((r) => Object.keys(r.tools)));
    const missing: string[] = [];
    for (const role of pb.roles) {
      let prompt: string;
      try {
        prompt = await readFile(join(DIR, 'prompts', `${role.role}.md`), 'utf8');
      } catch {
        continue;
      }
      for (const [, server, op] of prompt.matchAll(/`([a-z][a-z-]*)\.([a-z][a-z.-]*[a-z])`/g)) {
        if (servers.has(server!) && !role.tools[server!]?.ops.includes(op!))
          missing.push(`${role.role}: ${server}.${op}`);
      }
      // These two roles work from their acceptance checks, which run the platform's checks on
      // the task's own items; the validators server's whole-project runs are for other roles.
      if (['parity-auditor', 'structural-validator'].includes(role.role))
        expect(prompt, role.role).not.toMatch(/validators\.(parity|structural)\.run/);
    }
    expect(missing).toEqual([]);
    // A role granted an operation no server offers doesn't run on a live project.
    expect(pb.roles.find((r) => r.role === 'parity-auditor')!.tools.validators).toBeUndefined();
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
