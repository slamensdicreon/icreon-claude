import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCatalog, loadPlaybook, loadRolePrompts, roster, validatePlaybook } from '../src';

const DIR = fileURLToPath(new URL('../../../playbooks/sitecoreai-migration', import.meta.url));
// The playbook's platform pack holds the platform knowledge its roles list.
const PLATFORM_KNOWLEDGE = fileURLToPath(
  new URL('../../../platforms/sitecoreai/knowledge', import.meta.url),
);

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
      // Tool operations are written `server.op` in prompts.
      for (const [, server, op] of prompt.matchAll(/`([a-z][a-z-]*)\.([a-z][a-z.-]*[a-z])`/g)) {
        if (servers.has(server!) && !role.tools[server!]?.ops.includes(op!))
          missing.push(`${role.role}: ${server}.${op}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('catches broken reporting lines and unknown phases', async () => {
    const pb = await loadPlaybook(DIR);
    const broken = structuredClone(pb);
    const migrator = broken.roles.find((r) => r.role === 'content-migrator')!;
    migrator.reportsTo = 'nobody';
    broken.roles.find((r) => r.role === 'visual-qa')!.activePhases = [42];
    const problems = validatePlaybook(broken);
    expect(problems).toContain(
      'content-migrator: reportsTo "nobody" is not a role in this playbook',
    );
    expect(problems).toContain('visual-qa: active in unknown phase 42');
  });

  it('ships autonomy defaults, and refuses handing releases or scope to anyone but the Director', async () => {
    const pb = await loadPlaybook(DIR);
    expect(pb.manifest.defaults.autonomy).toMatchObject({ media: 'shadow', release: 'ask' });
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
      'layout-engineer',
      'media-migrator',
      'parity-auditor',
      'perf-a11y-qa',
      'quality-lead',
      'rendering-registrar',
      'repo-analyst',
      'research-agent',
      'solution-architect',
      'structural-validator',
      'tenant-provisioner',
      'visual-qa',
    ]);
    expect(prompts['tenant-provisioner']).toMatch(
      /own folders[\s\S]*Reference: known SitecoreAI pitfalls/,
    );
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
