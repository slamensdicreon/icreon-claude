import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { validatePlaybook, type Playbook } from './pure';
import { PlanSpec, PlaybookManifest, RoleDef } from './schema';

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

  const planResult = PlanSpec.safeParse(parse(await readFile(join(dir, 'plan.yaml'), 'utf8')));
  if (!planResult.success) problems.push(`plan.yaml: ${planResult.error.message}`);

  if (problems.length || !manifestResult.success || !planResult.success) {
    throw new PlaybookError(problems);
  }
  const playbook = { manifest: manifestResult.data, roles, plan: planResult.data };
  const crossProblems = validatePlaybook(playbook);
  if (crossProblems.length) throw new PlaybookError(crossProblems);
  return playbook;
}
