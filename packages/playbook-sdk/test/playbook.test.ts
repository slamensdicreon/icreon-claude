import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  loadCatalog,
  loadPlaybook,
  loadRolePrompts,
  roster,
  validatePlaybook,
  versionOf,
  type Playbook,
} from '../src';

const DIR = fileURLToPath(new URL('../../../playbooks/sitecoreai-migration', import.meta.url));
// The playbook's platform pack holds the platform knowledge its roles list.
const PLATFORM_KNOWLEDGE = fileURLToPath(
  new URL('../../../platforms/sitecoreai/knowledge', import.meta.url),
);
const ROOT = fileURLToPath(new URL('../../../playbooks', import.meta.url));
const OPTIMIZELY_KNOWLEDGE = fileURLToPath(
  new URL('../../../platforms/optimizely/knowledge', import.meta.url),
);

/** Tool operations a role's prompt names (`server.op`) that the role is not granted. */
async function ungranted(dir: string, pb: Playbook): Promise<string[]> {
  const servers = new Set(pb.roles.flatMap((r) => Object.keys(r.tools)));
  const missing: string[] = [];
  for (const role of pb.roles) {
    let prompt: string;
    try {
      prompt = await readFile(join(dir, 'prompts', `${role.role}.md`), 'utf8');
    } catch {
      continue;
    }
    // Tool operations are written `server.op` in prompts.
    for (const [, server, op] of prompt.matchAll(/`([a-z][a-z-]*)\.([a-z][a-z.-]*[a-z])`/g)) {
      if (servers.has(server!) && !role.tools[server!]?.ops.includes(op!))
        missing.push(`${role.role}: ${server}.${op}`);
    }
  }
  return missing;
}

describe('sitecoreai-migration playbook', () => {
  it('loads and passes bundle validation', async () => {
    const pb = await loadPlaybook(DIR);
    expect(pb.manifest.phases).toHaveLength(10);
    expect(pb.manifest.phases.filter((p) => p.gate === 'director').map((p) => p.number)).toEqual([
      2, 9,
    ]);
    const r = roster(pb);
    expect(
      r
        .filter((a) => a.tier === 'lead')
        .map((a) => a.workstream)
        .sort(),
    ).toEqual(['content', 'discovery', 'engineering', 'quality']);
    expect(r.find((a) => a.agentId === 'chief-of-staff')?.activePhases).toHaveLength(10);
  });

  it('grants every tool a role prompt tells the agent to use', async () => {
    expect(await ungranted(DIR, await loadPlaybook(DIR))).toEqual([]);
  });

  it('catches broken reporting lines and unknown phases', async () => {
    const pb = await loadPlaybook(DIR);
    const broken = structuredClone(pb);
    const migrator = broken.roles.find((r) => r.role === 'content-migrator')!;
    migrator.reportsTo = 'nobody';
    broken.roles.find((r) => r.role === 'parity-auditor')!.activePhases = [42];
    const problems = validatePlaybook(broken);
    expect(problems).toContain(
      'content-migrator: reportsTo "nobody" is not a role in this playbook',
    );
    expect(problems).toContain('parity-auditor: active in unknown phase 42');
  });

  it('ships autonomy defaults, and refuses handing releases or scope to anyone but the Director', async () => {
    const pb = await loadPlaybook(DIR);
    expect(pb.manifest.defaults.autonomy).toMatchObject({ media: 'lead', release: 'ask' });
    const loose = structuredClone(pb);
    loose.manifest.defaults.autonomy = { release: 'lead', scope: 'shadow' };
    expect(validatePlaybook(loose)).toEqual(
      expect.arrayContaining([
        "defaults.autonomy.release must be ask: it is always the Director's",
        "defaults.autonomy.scope must be ask: it is always the Director's",
      ]),
    );
  });
});

describe('role prompts', () => {
  it('loads one per prompted role, naming the artifacts later roles depend on', async () => {
    const pb = await loadPlaybook(DIR);
    const prompts = await loadRolePrompts(DIR, pb, [PLATFORM_KNOWLEDGE]);
    // Prompted roles, and roles that consult a knowledge document (known pitfalls, the DoD).
    expect(Object.keys(prompts).sort()).toEqual([
      'component-engineer',
      'content-analyst',
      'content-migrator',
      'deployment-engineer',
      'editor-experience-qa',
      'experience-enabler',
      'handover-writer',
      'head-integrator',
      'media-migrator',
      'parity-auditor',
      'perf-a11y-qa',
      'quality-lead',
      'rendering-registrar',
      'repo-analyst',
      'research-agent',
      'solution-architect',
      'structural-validator',
    ]);
    // The Deployment Engineer carries the tenant work since 0.7.0, and the Modeler the layouts.
    expect(prompts['deployment-engineer']).toMatch(
      /own folders[\s\S]*Reference: known SitecoreAI pitfalls/,
    );
    expect(prompts['rendering-registrar']).toContain('Page templates and designs');
    expect(prompts['editor-experience-qa']).toContain('Reference: Definition of Done');
    expect(prompts['content-analyst']).not.toContain('Reference:');
    expect(prompts['repo-analyst']).toContain('`repo-inventory`');
    expect(prompts['research-agent']).toContain('`platform-notes`');
    expect(prompts['solution-architect']).toContain('`repo-inventory`');
    expect(prompts['content-analyst']).toContain('`page-inventory`');
    expect(prompts['content-analyst']).toContain('`parity-inventory`');
    expect(prompts['solution-architect']).toContain('`page-inventory`');
    expect(prompts['handover-writer']).toContain('`handover-pack`');
  });

  it('refuses a knowledge document that does not exist', async () => {
    const pb = await loadPlaybook(DIR);
    const dir = await mkdtemp(join(tmpdir(), 'lw-pb-'));
    await mkdir(join(dir, 'prompts'));
    await expect(loadRolePrompts(dir, pb)).rejects.toThrow(
      'knowledge/known-pitfalls.md does not exist',
    );
  });

  it('loads the catalog: every playbook folder, with a platform and a charter', async () => {
    const catalog = await loadCatalog(
      fileURLToPath(new URL('../../../playbooks', import.meta.url)),
    );
    const pb = catalog.get('sitecoreai-migration')!.playbook;
    expect(pb.manifest).toMatchObject({
      platform: 'sitecoreai',
      name: 'Build a SitecoreAI website',
    });
    expect(pb.manifest.charter.outcomes.length).toBeGreaterThanOrEqual(3);
  });

  it('keeps the versions projects are pinned to, and finds a project its own', async () => {
    const catalog = await loadCatalog(
      fileURLToPath(new URL('../../../playbooks', import.meta.url)),
    );
    const entry = catalog.get('sitecoreai-migration')!;
    // Lambert's Cable runs 0.5.1 and Star LLC 0.6.3, Paylocity 0.11.0 (0.12.0 to 0.20.0 kept too): their teams stay as they were.
    expect(entry.older?.map((o) => o.playbook.manifest.version)).toEqual([
      '0.20.0',
      '0.19.0',
      '0.17.0',
      '0.16.0',
      '0.15.0',
      '0.14.0',
      '0.13.0',
      '0.12.0',
      '0.11.0',
      '0.6.3',
      '0.5.1',
    ]);
    const lambert = versionOf(entry, '0.5.1');
    expect(lambert.playbook.manifest.version).toBe('0.5.1');
    expect(lambert.playbook.roles.map((r) => r.role)).toContain('layout-engineer');
    expect(entry.playbook.roles.map((r) => r.role)).not.toContain('layout-engineer');
    // A version that isn't kept, or none: the current one.
    expect(versionOf(entry, '0.4.0')).toBe(entry);
    expect(versionOf(entry, null)).toBe(entry);
  });

  it('refuses an archived version filed under the wrong name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lw-cat-'));
    await cp(DIR, join(root, 'sitecoreai-migration'), { recursive: true });
    await cp(DIR, join(root, '.versions', 'sitecoreai-migration', '0.0.1'), { recursive: true });
    await expect(loadCatalog(root)).rejects.toThrow(
      /\.versions\/sitecoreai-migration\/0\.0\.1 holds/,
    );
  });

  it('refuses a prompt for a role the playbook does not have', async () => {
    const pb = await loadPlaybook(DIR);
    const dir = await mkdtemp(join(tmpdir(), 'lw-pb-'));
    await mkdir(join(dir, 'prompts'));
    await writeFile(join(dir, 'prompts', 'nobody.md'), 'Hi');
    await expect(loadRolePrompts(dir, pb)).rejects.toThrow(
      'prompts/nobody.md: no role with this id',
    );
    expect(await loadRolePrompts(tmpdir() + '/does-not-exist', pb)).toEqual({});
  });
});

describe('sitecoreai-customer-portal playbook', () => {
  const PORTAL = fileURLToPath(
    new URL('../../../playbooks/sitecoreai-customer-portal', import.meta.url),
  );

  it('loads and passes bundle validation, with the Blueprint and acceptance gates', async () => {
    const pb = await loadPlaybook(PORTAL);
    expect(pb.manifest.platform).toBe('sitecoreai');
    expect(pb.manifest.phases).toHaveLength(8);
    expect(pb.manifest.phases.filter((p) => p.gate === 'director').map((p) => p.number)).toEqual([
      2, 7,
    ]);
    // It closes on the Director's UAT on production: each persona walked, then Page builder.
    expect(pb.plan.templates.find((t) => t.id === 'director-uat')).toMatchObject({
      phase: 7,
      dependsOn: ['walk-*'],
      manual: expect.stringContaining('Page builder'),
    });
    const walk = pb.plan.templates.find((t) => t.id === 'walk-{key}');
    expect(walk).toMatchObject({ forEach: 'personas', manual: expect.any(String) });
    expect(pb.plan.templates.find((t) => t.id === 'draft-blueprint')?.acceptance).toContain(
      'validator:blueprint.personas',
    );
  });

  it('grants every tool a role prompt tells the agent to use', async () => {
    expect(await ungranted(PORTAL, await loadPlaybook(PORTAL))).toEqual([]);
  });
});

describe.each(['optimizely-saas-migration', 'optimizely-homepage-demo'])('%s playbook', (id) => {
  const OPTIMIZELY = join(ROOT, id);

  it('loads and passes bundle validation', async () => {
    const pb = await loadPlaybook(OPTIMIZELY);
    expect(pb.manifest).toMatchObject({ id, platform: 'optimizely' });
    expect(pb.manifest.phases).toHaveLength(10);
    expect(pb.manifest.phases.filter((p) => p.gate === 'director').map((p) => p.number)).toEqual([
      2, 9,
    ]);
    // The same method as every playbook: one Lead per workstream under the Chief of Staff.
    const r = roster(pb);
    expect(r).toHaveLength(20);
    expect(
      r
        .filter((a) => a.tier === 'lead')
        .map((a) => a.workstream)
        .sort(),
    ).toEqual(['content', 'discovery', 'engineering', 'quality']);
    expect(r.find((a) => a.agentId === 'chief-of-staff')?.activePhases).toHaveLength(10);
    // Every task is given to a role the playbook has, in a phase that role works in.
    for (const t of pb.plan.templates) {
      const role = pb.roles.find((x) => x.role === t.role);
      expect(role, t.id).toBeDefined();
      expect(role!.activePhases === 'all' || role!.activePhases.includes(t.phase), t.id).toBe(true);
    }
  });

  it('grants every tool a role prompt tells the agent to use', async () => {
    expect(await ungranted(OPTIMIZELY, await loadPlaybook(OPTIMIZELY))).toEqual([]);
  });

  it('catches broken reporting lines and unknown phases', async () => {
    const broken = structuredClone(await loadPlaybook(OPTIMIZELY));
    broken.roles.find((r) => r.role === 'content-migrator')!.reportsTo = 'nobody';
    broken.roles.find((r) => r.role === 'parity-auditor')!.activePhases = [42];
    const problems = validatePlaybook(broken);
    expect(problems).toContain(
      'content-migrator: reportsTo "nobody" is not a role in this playbook',
    );
    expect(problems).toContain('parity-auditor: active in unknown phase 42');
  });

  it('ships autonomy defaults, and refuses handing releases or scope to anyone but the Director', async () => {
    const pb = await loadPlaybook(OPTIMIZELY);
    expect(pb.manifest.defaults.autonomy).toMatchObject({ media: 'lead', release: 'ask' });
    const loose = structuredClone(pb);
    loose.manifest.defaults.autonomy = { release: 'lead', scope: 'shadow' };
    expect(validatePlaybook(loose)).toEqual(
      expect.arrayContaining([
        "defaults.autonomy.release must be ask: it is always the Director's",
        "defaults.autonomy.scope must be ask: it is always the Director's",
      ]),
    );
  });

  it('loads one prompt per prompted role, with the knowledge of its own platform pack', async () => {
    const pb = await loadPlaybook(OPTIMIZELY);
    const prompts = await loadRolePrompts(OPTIMIZELY, pb, [OPTIMIZELY_KNOWLEDGE]);
    const prompted = (await readdir(join(OPTIMIZELY, 'prompts'))).map((f) => f.slice(0, -3));
    const consulting = pb.roles.filter((r) => r.knowledge.length).map((r) => r.role);
    expect(Object.keys(prompts).sort()).toEqual([...new Set([...prompted, ...consulting])].sort());
    // The pitfalls are the platform's, found in its pack; the Definition of Done is the playbook's.
    expect(prompts['deployment-engineer']).toContain(
      'Reference: known Optimizely CMS (SaaS) pitfalls',
    );
    expect(prompts['deployment-engineer']).not.toContain('SitecoreAI pitfalls');
    expect(prompts['handover-writer']).toContain('Reference: Definition of Done');
    expect(prompts['research-agent']).toContain('`platform-notes`');
    expect(prompts['handover-writer']).not.toContain('Reference: known Optimizely');
    // Without the pack's folder the platform knowledge is missing, and loading says so.
    await expect(loadRolePrompts(OPTIMIZELY, pb)).rejects.toThrow(
      'knowledge/known-pitfalls.md does not exist',
    );
  });
});

describe('the catalog, across platforms', () => {
  it('loads every playbook folder with a platform pack, a charter and the two Director gates', async () => {
    const catalog = await loadCatalog(ROOT);
    expect([...catalog.keys()].sort()).toEqual([
      'optimizely-homepage-demo',
      'optimizely-saas-migration',
      'sitecoreai-customer-portal',
      'sitecoreai-homepage-demo',
      'sitecoreai-migration',
    ]);
    const packs = await readdir(fileURLToPath(new URL('../../../platforms', import.meta.url)));
    for (const [id, { playbook: pb, dir }] of catalog) {
      expect(dir, id).toBe(join(ROOT, id));
      expect(packs, id).toContain(pb.manifest.platform);
      expect(pb.manifest.charter.mission.length, id).toBeGreaterThan(20);
      expect(pb.manifest.charter.outcomes.length, id).toBeGreaterThanOrEqual(3);
      for (const o of pb.manifest.charter.outcomes)
        expect(o.measure, `${id}: ${o.id}`).toBeTruthy();
      // Gate 1 is the Blueprint's; Gate 2 closes the last phase.
      expect(
        pb.manifest.phases.filter((p) => p.gate === 'director').map((p) => p.number),
        id,
      ).toEqual([2, pb.manifest.phases.length - 1]);
      expect(validatePlaybook(pb), id).toEqual([]);
      expect(await ungranted(dir, pb), id).toEqual([]);
    }
    expect(catalog.get('optimizely-saas-migration')!.playbook.manifest).toMatchObject({
      platform: 'optimizely',
      name: 'Build an Optimizely CMS (SaaS) website',
    });
    expect(catalog.get('optimizely-homepage-demo')!.playbook.manifest).toMatchObject({
      platform: 'optimizely',
      name: 'Optimizely homepage demo',
    });
  });

  it('keeps the Optimizely versions projects are pinned to, and finds a project its own', async () => {
    const catalog = await loadCatalog(ROOT);
    const entry = catalog.get('optimizely-saas-migration')!;
    const kept = entry.older!.map((o) => o.playbook.manifest.version);
    // Newest first, without the current one; the versions before the platform's order (0.5.0).
    expect(kept).toEqual(expect.arrayContaining(['0.4.6', '0.4.5', '0.4.4']));
    expect(kept).not.toContain(entry.playbook.manifest.version);
    const parts = (v: string) => v.split('.').map(Number);
    const newestFirst = [...kept].sort((a, b) => {
      const [x, y] = [parts(a), parts(b)];
      return y[0]! - x[0]! || y[1]! - x[1]! || y[2]! - x[2]!;
    });
    expect(kept).toEqual(newestFirst);
    const pinned = versionOf(entry, '0.4.4');
    expect(pinned.playbook.manifest).toMatchObject({
      id: 'optimizely-saas-migration',
      version: '0.4.4',
      platform: 'optimizely',
    });
    expect(pinned.dir).toBe(join(ROOT, '.versions', 'optimizely-saas-migration', '0.4.4'));
    // A version that isn't kept, or none: the current one.
    expect(versionOf(entry, '0.1.0')).toBe(entry);
    expect(versionOf(entry, null)).toBe(entry);
    // The demo's first version is kept for a project started before the starter's generated
    // registry (0.1.1).
    expect(
      catalog.get('optimizely-homepage-demo')!.older!.map((o) => o.playbook.manifest.version),
    ).toEqual(['0.1.0']);
  });
});
