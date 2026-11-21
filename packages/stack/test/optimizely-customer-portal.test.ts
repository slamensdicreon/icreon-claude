import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPTIMIZELY_DEFAULTS, SITECORE_DEFAULTS } from '@lw/connectors';
import { loadFixtures } from '@lw/orchestrator';
import { compilePlan } from '@lw/plan';
import { createPlatforms, intakeSpec } from '@lw/platforms';
import { loadPlaybook, loadRolePrompts } from '@lw/playbook-sdk';
import { describe, expect, it } from 'vitest';
import { CHECKS } from '../src';

const dir = (id: string) => fileURLToPath(new URL(`../../../playbooks/${id}`, import.meta.url));
const PORTAL = dir('optimizely-customer-portal');
const PLATFORM_KNOWLEDGE = fileURLToPath(
  new URL('../../../platforms/optimizely/knowledge', import.meta.url),
);
const pack = createPlatforms({ sitecore: SITECORE_DEFAULTS, optimizely: OPTIMIZELY_DEFAULTS }).get(
  'optimizely',
)!;

describe('optimizely-customer-portal playbook', () => {
  it('loads, with the Blueprint gate and the UAT gate, and the same portal the other platform builds', async () => {
    const pb = await loadPlaybook(PORTAL);
    expect(pb.manifest).toMatchObject({ platform: 'optimizely', version: '0.1.2' });
    expect(pb.manifest.phases).toHaveLength(8);
    expect(pb.manifest.phases.filter((p) => p.gate === 'director').map((p) => p.number)).toEqual([
      2, 7,
    ]);
    // The customer portal's outcomes, phases and brief, whatever the platform.
    const other = await loadPlaybook(dir('sitecoreai-customer-portal'));
    expect(pb.manifest.charter.outcomes.map((o) => o.id)).toEqual(
      other.manifest.charter.outcomes.map((o) => o.id),
    );
    expect(pb.manifest.phases.map((p) => p.shortName)).toEqual(
      other.manifest.phases.map((p) => p.shortName),
    );
    expect(pb.manifest.intake.brief.map((q) => q.key)).toEqual(
      other.manifest.intake.brief.map((q) => q.key),
    );
    expect(pb.manifest.intake.brief.find((q) => q.key === 'personalization')).toMatchObject({
      kind: 'yesno',
      feature: 'personalization',
    });
    // The Optimizely team's intake: the instance, the application, its prefix, Graph, hosting.
    const spec = intakeSpec(pb, pack);
    expect(spec.steps.flatMap((s) => s.fields.map((f) => f.key))).toEqual([
      'cmsUrl',
      'application',
      'typePrefix',
      'languages',
      'hostingProject',
    ]);
    expect(spec.steps.flatMap((s) => s.credentials.map((c) => c.credentialId))).toEqual([
      'cms-api-client',
      'graph-single-key',
      'graph-hmac',
    ]);
  });

  it('asks the Director for what is theirs: content rights, the application, the two releases, the walks and the UAT', async () => {
    const pb = await loadPlaybook(PORTAL);
    const template = (id: string) => pb.plan.templates.find((t) => t.id === id)!;
    // The API key's content rights are confirmed before Gate 1, unless the key's earlier content
    // proves them (the platform reads that as the project starts): as the website playbooks do.
    const website = await loadPlaybook(dir('optimizely-homepage-demo'));
    expect(template('confirm-content-rights')).toMatchObject({
      phase: 0,
      unless: 'content-rights-proven',
      manual: expect.stringContaining('Set Access Rights'),
    });
    expect(template('confirm-content-rights').role).toBe(
      website.plan.templates.find((t) => t.id === 'confirm-content-rights')!.role,
    );
    // The head shows published content only: the tasks judged on it publish what they wrote, on
    // the portal's own application and the project's own hosts. Approved once, here.
    for (const id of ['prepare-hosting', 'compose-pilot', 'compose-{key}'])
      expect(template(id).release?.standing, id).toBe(true);
    expect(
      pb.roles.find((r) => r.role === 'content-migrator')!.tools['optimizely-cms']!.ops,
    ).toContain('content.publish');
    // The first write on the instance and the releases of phase 6 ask.
    for (const id of ['provision-application', 'deploy-code', 'publish-site']) {
      expect(template(id).release, id).toBeDefined();
      expect(template(id).release?.standing, id).toBeUndefined();
    }
    // Visual Builder and a signed-in walk have no driver: a person's steps, and nothing else is.
    expect(
      pb.plan.templates
        .filter((t) => t.manual)
        .map((t) => t.id)
        .sort(),
    ).toEqual(['confirm-content-rights', 'director-uat', 'walk-{key}']);
    expect(template('walk-{key}')).toMatchObject({ forEach: 'personas', phase: 7 });
    expect(template('director-uat')).toMatchObject({
      phase: 7,
      dependsOn: ['walk-*'],
      manual: expect.stringContaining('Shown to'),
    });
  });

  it('plans the example Blueprint in the order the platform sets, the pilot first', async () => {
    const pb = await loadPlaybook(PORTAL);
    const { blueprint } = await loadFixtures(PORTAL);
    const plan = compilePlan(pb, blueprint, {
      skipMerged: true,
      features: ['source-repo', 'personalization'],
    });
    const keys = (prefix: string) =>
      plan.tasks
        .filter((t) => t.taskId.startsWith(prefix))
        .map((t) => t.taskId.slice(prefix.length));
    expect(keys('port-')).toEqual([
      'welcome',
      'page-header',
      'claims-table',
      'next-steps',
      'claim-report',
      'financial-account',
      'promo',
      'sign-in',
    ]);
    expect(keys('define-type-')).toEqual(['portal-page']);
    expect(keys('compose-').sort()).toEqual(
      ['billing', 'claims', 'overview', 'pilot', 'report', 'sign-in'].sort(),
    );
    expect(keys('upload-media-')).toEqual(['campus-sunset', 'campus']);
    expect(keys('walk-')).toEqual(['business-manager', 'finance-contact']);
    expect(plan.tasks.at(-1)?.taskId).toBe('director-uat');

    const task = (id: string) => plan.tasks.find((t) => t.taskId === id)!;
    const order = plan.tasks.map((t) => t.taskId);
    const before = (a: string, b: string) => order.indexOf(a) < order.indexOf(b);
    // The shell is built once, before any component, and reaches the editing host with the head.
    for (const id of ['port-welcome', 'define-type-portal-page', 'integrate-head'])
      expect(task(id).dependsOn, id).toContain('portal-shell');
    // The page type refers to no shared block: it waits on no component.
    expect(task('push-type-portal-page').dependsOn.sort()).toEqual([
      'define-type-portal-page',
      'integrate-head',
    ]);
    // An application can't exist without its start page, of the type just pushed.
    expect(task('approve-provision-application').dependsOn).toEqual(['push-type-portal-page']);
    // Everything that reads the application, its hosts, Graph or the signed-in head comes after.
    const needApplication =
      /^validator:(structural\.(application|experiences)|hostname\.|head\.preview-route|graph\.|media\.|portal\.)/;
    for (const t of plan.tasks)
      if (t.acceptance.some((a) => needApplication.test(a)))
        expect(
          t.taskId === 'provision-application' || before('provision-application', t.taskId),
          t.taskId,
        ).toBe(true);

    // The pilot: its three components, composed on the start page, published and read as a
    // signed-in persona before the rest is built.
    const checkpoint = task('pilot-checkpoint');
    expect(checkpoint.itemKeys.sort()).toEqual(['claims-table', 'page-header', 'welcome']);
    expect(checkpoint.dependsOn).toEqual(
      expect.arrayContaining(['compose-pilot', 'prove-pilot-slice', 'integrate-welcome']),
    );
    expect(task('prove-pilot-slice').itemKeys.sort()).toEqual(checkpoint.itemKeys.sort());
    expect(task('prove-pilot-slice').acceptance).toEqual(
      expect.arrayContaining(['validator:portal.sign-in', 'validator:portal.pilot-page']),
    );
    expect(task('port-promo').dependsOn).toContain('pilot-checkpoint');
    expect(task('port-welcome').dependsOn).not.toContain('pilot-checkpoint');

    // Pages publish as they are composed (a standing release each); role content is proven after.
    expect(task('approve-compose-overview')).toMatchObject({ standing: true });
    expect(task('compose-overview').acceptance).toEqual([
      'validator:structural.experiences',
      'validator:portal.pages-render',
    ]);
    expect(task('role-content').dependsOn).toEqual(['validate-pages']);
    expect(task('publish-site').acceptance).toEqual([
      'validator:graph.published',
      'validator:portal.production',
    ]);
    expect(task('walk-finance-contact').dependsOn).toEqual(['handover-pack']);
    expect(task('director-uat').dependsOn.sort()).toEqual([
      'walk-business-manager',
      'walk-finance-contact',
    ]);
  });

  it('leaves out what the brief and the instance say it does not need', async () => {
    const pb = await loadPlaybook(PORTAL);
    const { blueprint } = await loadFixtures(PORTAL);
    const ids = (features: string[]) =>
      compilePlan(pb, blueprint, { skipMerged: true, features }).tasks.map((t) => t.taskId);
    // No content by role: nothing to prove, and no step by hand either way.
    expect(ids(['personalization'])).toContain('role-content');
    expect(ids([])).not.toContain('role-content');
    // A repository, or the running prototype alone.
    expect(ids(['source-repo'])).toContain('inventory-prototype');
    expect(ids(['source-repo'])).not.toContain('inventory-prototype-live');
    expect(ids([])).toContain('inventory-prototype-live');
    // A key whose earlier content proves its rights is not asked.
    expect(ids([])).toContain('confirm-content-rights');
    expect(ids(['content-rights-proven'])).not.toContain('confirm-content-rights');
  });

  it('names only checks that exist, and none that reads a page signed out or another contract', async () => {
    const pb = await loadPlaybook(PORTAL);
    const named = [
      ...new Set(pb.plan.templates.flatMap((t) => t.acceptance.map((a) => a.slice(10)))),
    ].sort();
    for (const id of named) expect(id in CHECKS || id in (pack.checks ?? {}), id).toBe(true);
    // The portal's own, in the pack; blueprint.personas is the shared one both portals use.
    expect(named.filter((id) => id.startsWith('portal.') || id.startsWith('blueprint.'))).toEqual([
      'blueprint.personas',
      'blueprint.portal',
      'portal.pages-render',
      'portal.pilot-page',
      'portal.production',
      'portal.role-content',
      'portal.sign-in',
    ]);
    for (const id of named.filter((x) => x.startsWith('portal.') || x === 'blueprint.portal'))
      expect(id in (pack.checks ?? {}), id).toBe(true);
    expect('blueprint.personas' in CHECKS).toBe(true);
    // A portal page answers a signed-out reader with the sign-in screen: the website playbooks'
    // checks of what a visitor reads, and the checks of another platform's contract, are out.
    for (const id of [
      'blueprint.coverage',
      'component-map.registered',
      'editing-host.responds',
      'head.editing-scripts',
      'head.header-footer',
      'head.pages-render',
      'head.sections',
      'parity.page',
      'parity.render',
      'parity.visual',
      'routes.resolve',
    ])
      expect(named, id).not.toContain(id);
  });

  it('passes its own Blueprint checks on the example Blueprint', async () => {
    const { blueprint } = await loadFixtures(PORTAL);
    const personas = await CHECKS['blueprint.personas']!({
      projectId: 'p1',
      state: { playbook: { id: 'optimizely-customer-portal', version: '0.1.0' } },
      library: {
        read: async (_p: string, id: string) =>
          id === 'blueprint' ? { content: JSON.stringify(blueprint) } : null,
      },
    } as never);
    expect(personas).toMatchObject({
      status: 'pass',
      detail:
        '2 personas, each with a demo account, a role, an audience, navigation and a presentation path.',
    });
    const portal = await pack.checks!['blueprint.portal']!({
      projectId: 'p1',
      target: { application: 'Acme Portal', typePrefix: 'Acme', languages: ['en'] },
      scope: { collection: null, items: [] },
      blueprint: JSON.parse(JSON.stringify(blueprint)),
      read: async () => ({ code: 404, body: null }),
      credential: async () => null,
      document: async (id) =>
        id === 'page-inventory'
          ? { pages: ['/', '/claims', '/report', '/billing', '/sign-in'].map((path) => ({ path })) }
          : null,
    });
    expect(portal).toMatchObject({
      status: 'pass',
      detail:
        '5 pages on 1 page type and 8 components, each a Acme content type with a default display template of its own; 4 sections are shown to one role.',
    });
  });

  it('grants every tool a role prompt tells the agent to use, and finds its knowledge', async () => {
    const pb = await loadPlaybook(PORTAL);
    const prompts = await loadRolePrompts(PORTAL, pb, [PLATFORM_KNOWLEDGE]);
    expect(prompts['handover-writer']).toContain('`handover-pack`');
    expect(prompts['handover-writer']).toContain('Definition of Done (customer portal)');
    expect(prompts['component-engineer']).toContain('a customer portal on Optimizely CMS (SaaS)');
    // The shell and the checks share one contract: both sides name the same endpoint and marks.
    for (const said of ['POST /api/session', '/sign-in?next=<path>', 'data-audience'])
      for (const role of ['component-engineer', 'content-migrator'])
        expect(prompts[role], `${role}: ${said}`).toContain(said);
    const servers = new Set(pb.roles.flatMap((r) => Object.keys(r.tools)));
    const missing: string[] = [];
    for (const role of pb.roles) {
      let prompt: string;
      try {
        prompt = await readFile(join(PORTAL, 'prompts', `${role.role}.md`), 'utf8');
      } catch {
        continue;
      }
      for (const [, server, op] of prompt.matchAll(/`([a-z][a-z-]*)\.([a-z][a-z.-]*[a-z])`/g)) {
        if (servers.has(server!) && !role.tools[server!]?.ops.includes(op!))
          missing.push(`${role.role}: ${server}.${op}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('names no other platform', async () => {
    const found: string[] = [];
    for (const folder of ['.', 'roles', 'prompts', 'knowledge', 'fixtures'])
      for (const f of await readdir(join(PORTAL, folder), { withFileTypes: true })) {
        if (!f.isFile()) continue;
        const text = await readFile(join(PORTAL, folder, f.name), 'utf8');
        const m = /sitecore|page builder|experience edge|partial design|datasource/i.exec(text);
        if (m) found.push(`${folder}/${f.name}: ${m[0]}`);
      }
    expect(found).toEqual([]);
  });
});
