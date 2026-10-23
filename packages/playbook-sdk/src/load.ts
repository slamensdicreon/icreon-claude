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

/**
 * Role prompts from `prompts/<role>.md`: how a role does its work, on top of its mandate, followed
 * by the `knowledge/<id>.md` documents the role lists. Loaded
 * apart from the playbook because the playbook travels as workflow input and prompts don't need
 * to. A role without a file runs on its mandate alone.
 */
export async function loadRolePrompts(
  dir: string,
  playbook: Playbook,
  /** More folders to find knowledge documents in, after the playbook's own (its platform pack). */
  knowledgeDirs: string[] = [],
): Promise<Record<string, string>> {
  let files: string[];
  try {
    files = (await readdir(join(dir, 'prompts'))).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return {};
  }
  const roles = new Set(playbook.roles.map((r) => r.role));
  const unknown = files.filter((f) => !roles.has(f.slice(0, -3)));
  if (unknown.length) {
    throw new PlaybookError(unknown.map((f) => `prompts/${f}: no role with this id`));
  }
  const prompts: Record<string, string> = {};
  for (const f of files)
    prompts[f.slice(0, -3)] = (await readFile(join(dir, 'prompts', f), 'utf8')).trim();

  // Reference documents a role consults (known pitfalls, the Definition of Done) follow its prompt.
  const knowledge = new Map<string, string>();
  const missing: string[] = [];
  for (const r of playbook.roles) {
    for (const k of r.knowledge) {
      if (!knowledge.has(k)) {
        const text = await firstFile(
          [join(dir, 'knowledge'), ...knowledgeDirs].map((d) => join(d, `${k}.md`)),
        );
        if (text === null) {
          missing.push(`roles/${r.role}.yaml: knowledge/${k}.md does not exist`);
          continue;
        }
        knowledge.set(k, text.trim());
      }
      prompts[r.role] = [prompts[r.role], knowledge.get(k)].filter(Boolean).join('\n\n');
    }
  }
  if (missing.length) throw new PlaybookError(missing);
  return prompts;
}

async function firstFile(paths: string[]): Promise<string | null> {
  for (const p of paths) {
    try {
      return await readFile(p, 'utf8');
    } catch {
      /* try the next */
    }
  }
  return null;
}

/** A playbook in the catalog, with the folder it was loaded from. */
export interface CatalogEntry {
  playbook: Playbook;
  dir: string;
}

/**
 * Every playbook under a folder: each subfolder holding a `playbook.yaml`. Ids must be unique; a
 * project records the id and version it was created with.
 */
export async function loadCatalog(root: string): Promise<Map<string, CatalogEntry>> {
  const catalog = new Map<string, CatalogEntry>();
  const dirs = (await readdir(root, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => join(root, d.name))
    .sort();
  for (const dir of dirs) {
    try {
      await readFile(join(dir, 'playbook.yaml'));
    } catch {
      continue;
    }
    const playbook = await loadPlaybook(dir);
    const id = playbook.manifest.id;
    if (catalog.has(id)) throw new PlaybookError([`two playbooks have the id ${id}`]);
    catalog.set(id, { playbook, dir });
  }
  if (!catalog.size) throw new PlaybookError([`no playbooks under ${root}`]);
  return catalog;
}
