// Workflow-safe half of the SDK: no Node built-ins, so Temporal workflows can import it.
import type { PhaseDef, RosterEntry } from '@lw/contracts';
import type { PlanSpec, PlaybookManifest, RoleDef } from './schema';

export interface Playbook {
  manifest: PlaybookManifest;
  roles: RoleDef[];
  plan: PlanSpec;
}

/** Bundle-level rules the per-file schemas cannot express. */
export function validatePlaybook({ manifest, roles, plan }: Playbook): string[] {
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

  const templateIds = new Set<string>();
  for (const t of plan.templates) {
    if (templateIds.has(t.id)) problems.push(`plan: duplicate template id ${t.id}`);
    templateIds.add(t.id);
    const role = byId.get(t.role);
    if (!phaseNumbers.has(t.phase)) problems.push(`plan: ${t.id} is in unknown phase ${t.phase}`);
    if (!role) problems.push(`plan: ${t.id} uses unknown role ${t.role}`);
    else if (Array.isArray(role.activePhases) && !role.activePhases.includes(t.phase)) {
      problems.push(`plan: ${t.id} runs in phase ${t.phase}, where ${t.role} is not active`);
    }
    if (t.id.includes('{key}') !== Boolean(t.forEach)) {
      problems.push(`plan: ${t.id} must use {key} exactly when it has forEach`);
    }
    if (t.batchSize && !t.forEach) problems.push(`plan: ${t.id} has batchSize without forEach`);
    if (t.canary !== undefined && !t.forEach)
      problems.push(`plan: ${t.id} has canary without forEach`);
  }
  if (plan.pilot) {
    if (!phaseNumbers.has(plan.pilot.phase))
      problems.push(`plan: pilot in unknown phase ${plan.pilot.phase}`);
    const phase = manifest.phases.find((p) => p.number === plan.pilot!.phase);
    if (plan.pilot.optionalGate && !phase?.optionalGates.includes(plan.pilot.optionalGate)) {
      problems.push(
        `plan: pilot gate ${plan.pilot.optionalGate} is not an optional gate of phase ${plan.pilot.phase}`,
      );
    }
    for (const id of plan.pilot.verify) {
      const t = plan.templates.find((x) => x.id === id);
      if (!t) problems.push(`plan: pilot verify template ${id} does not exist`);
      else if (t.forEach || t.phase !== plan.pilot.phase)
        problems.push(`plan: pilot verify template ${id} must be a single task in the pilot phase`);
    }
  }
  return problems;
}

export function phaseDefs({ manifest }: Playbook): PhaseDef[] {
  return manifest.phases.map(({ number, name, shortName, gate, gateLabel, exitCriteria }) => ({
    number,
    name,
    shortName: shortName ?? null,
    gate,
    gateLabel: gateLabel ?? null,
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
    persona: r.persona ?? null,
    description: r.description ?? r.mandate,
  }));
}
