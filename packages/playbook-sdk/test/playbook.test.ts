import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadPlaybook, roster, validatePlaybook } from '../src';

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
