import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PhaseDef, RosterEntry } from '@lw/contracts';
import { parse } from 'yaml';
import { PlaybookManifest, RoleDef } from './schema';

export interface Playbook {
  manifest: PlaybookManifest;
  roles: RoleDef[];
}

export class PlaybookError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid playbook:\n- ${problems.join('\n- ')}`);
  }
}

/** Loads `playbook.yaml` and `roles/*.yaml` from a directory, then validates the whole bundle. */
export async function loadPlaybook(dir: string): Promise<Playbook> {
  const problems: string[] = [];
  const manifestResult = PlaybookManifest.safeParse(
    parse(await readFile(join(dir, 'playbook.yaml'), 'utf8')),
  );
  if (!manifestResult.success) problems.push(`playbook.yaml: ${manifestResult.error.message}`);

  const roles: RoleDef[] = [];
  const files = (await readdir(join(dir, 'roles'))).filter((f) => f.endsWith('.yaml')).sort();
  for (const f of files) {
    const r = RoleDef.safeParse(parse(await readFile(join(dir, 'roles', f), 'utf8')));
    if (!r.success) problems.push(`roles/${f}: ${r.error.message}`);
    else if (`${r.data.role}.yaml` !== f) problems.push(`roles/${f}: role id must match file name`);
    else roles.push(r.data);
  }

  if (problems.length || !manifestResult.success) throw new PlaybookError(problems);
  const playbook = { manifest: manifestResult.data, roles };
  const crossProblems = validatePlaybook(playbook);
  if (crossProblems.length) throw new PlaybookError(crossProblems);
  return playbook;
}

/** Bundle-level rules the per-file schemas cannot express. */
export function validatePlaybook({ manifest, roles }: Playbook): string[] {
  const problems: string[] = [];
  const byId = new Map(roles.map((r) => [r.role, r]));
  const phaseNumbers = new Set(manifest.phases.map((p) => p.number));

  const chiefs = roles.filter((r) => r.tier === 'chief_of_staff');
  if (chiefs.length !== 1)
    problems.push(`exactly one chief_of_staff required, found ${chiefs.length}`);

  const sorted = [...manifest.phases].map((p) => p.number).sort((a, b) => a - b);
  sorted.forEach((n, i) => {
    if (n !== i) problems.push(`phases must be numbered 0..${sorted.length - 1} without gaps`);
  });

  for (const p of manifest.phases) {
    for (const d of p.dependsOn ?? []) {
      if (d >= p.number) problems.push(`phase ${p.number} depends on later or same phase ${d}`);
      if (!phaseNumbers.has(d)) problems.push(`phase ${p.number} depends on unknown phase ${d}`);
    }
  }

  const leadWorkstreams = new Set<string>();
  for (const r of roles) {
    if (r.tier === 'chief_of_staff') {
      if (r.reportsTo !== null)
        problems.push(`${r.role}: chief_of_staff reports to the Director only`);
      continue;
    }
    const manager = r.reportsTo ? byId.get(r.reportsTo) : undefined;
    if (!manager) {
      problems.push(`${r.role}: reportsTo "${r.reportsTo}" is not a role in this playbook`);
      continue;
    }
    if (r.tier === 'lead') {
      if (manager.tier !== 'chief_of_staff')
        problems.push(`${r.role}: leads report to the chief of staff`);
      if (!r.workstream) problems.push(`${r.role}: a lead needs a workstream`);
      else if (leadWorkstreams.has(r.workstream))
        problems.push(`${r.role}: duplicate lead for ${r.workstream}`);
      else leadWorkstreams.add(r.workstream);
    }
    if (r.tier === 'specialist') {
      if (manager.tier === 'specialist')
        problems.push(`${r.role}: specialists report to a lead or the chief of staff`);
      if (manager.tier === 'lead' && manager.workstream !== r.workstream) {
        problems.push(
          `${r.role}: workstream ${r.workstream} differs from its lead's (${manager.workstream})`,
        );
      }
      if (r.activePhases === 'all')
        problems.push(`${r.role}: specialists activate per phase, not 'all'`);
    }
    if (Array.isArray(r.activePhases)) {
      for (const n of r.activePhases) {
        if (!phaseNumbers.has(n)) problems.push(`${r.role}: active in unknown phase ${n}`);
      }
    }
  }
  return problems;
}

export function phaseDefs({ manifest }: Playbook): PhaseDef[] {
  return manifest.phases.map(({ number, name, gate, exitCriteria }) => ({
    number,
    name,
    gate,
    exitCriteria,
  }));
}

const TIER_ORDER = { chief_of_staff: 0, lead: 1, specialist: 2 } as const;
const WORKSTREAM_ORDER = { discovery: 0, engineering: 1, content: 2, quality: 3 } as const;

/**
 * The org chart a project starts with, in display order: Chief of Staff, Leads by workstream, then
 * specialists by workstream and first active phase. Agent ids are role ids (one instance per role).
 */
export function roster({ manifest, roles }: Playbook): RosterEntry[] {
  const allPhases = manifest.phases.map((p) => p.number);
  const firstPhase = (r: RoleDef) => (r.activePhases === 'all' ? -1 : Math.min(...r.activePhases));
  const ws = (r: RoleDef) => (r.workstream ? WORKSTREAM_ORDER[r.workstream] : 9);
  const ordered = [...roles].sort(
    (a, b) =>
      TIER_ORDER[a.tier] - TIER_ORDER[b.tier] ||
      ws(a) - ws(b) ||
      firstPhase(a) - firstPhase(b) ||
      a.role.localeCompare(b.role),
  );
  return ordered.map((r) => ({
    agentId: r.role,
    role: r.role,
    name: r.name,
    tier: r.tier,
    reportsTo: r.reportsTo,
    workstream: r.workstream,
    activePhases: r.activePhases === 'all' ? allPhases : r.activePhases,
    model: r.model.id,
  }));
}
