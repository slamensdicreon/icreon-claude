import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadPlaybook, loadRolePrompts, roster, validatePlaybook } from '../src';

const DIR = fileURLToPath(new URL('../../../playbooks/sitecoreai-migration', import.meta.url));

describe('sitecoreai-migration playbook', () => {
  it('loads and passes bundle validation', async () => {
    const pb = await loadPlaybook(DIR);
    expect(pb.manifest.phases).toHaveLength(11);
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
    expect(r.find((a) => a.agentId === 'chief-of-staff')?.activePhases).toHaveLength(11);
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
});

describe('role prompts', () => {
  it('loads one per prompted role, naming the artifacts later roles depend on', async () => {
    const pb = await loadPlaybook(DIR);
    const prompts = await loadRolePrompts(DIR, pb);
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
      'perf-a11y-qa',
      'quality-lead',
      'rendering-registrar',
      'repo-analyst',
      'research-agent',
      'solution-architect',
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
