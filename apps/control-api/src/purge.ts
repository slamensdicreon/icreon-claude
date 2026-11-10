import type { BuildRepo, NewEvent } from '@lw/contracts';
import type { CleanupResult, ReadinessCheck } from '@lw/connectors';
import type {
  EventStore,
  IntegrationStore,
  KnowledgeStore,
  RuleStore,
  SecretVault,
  Tombstone,
  TombstoneStore,
} from '@lw/events';
import type { ProjectState } from '@lw/domain';

/**
 * Deleting a project for good. An archived project asked to be deleted waits out its grace period
 * (`project.deletion requested`); the daily purge then removes everything we hold for it, one
 * recorded step at a time, and leaves only its tombstone. A purge cut off part way resumes from
 * the first step it hasn't recorded. The event log goes last, so a project whose purge failed is
 * still there to see.
 */
export interface PurgeDeps {
  store: EventStore;
  tombstones: TombstoneStore;
  /** Ends the project's workflow if one is left (usually ended at archive). */
  stop?: (projectId: string) => Promise<void>;
  blobs?: { deleteProject(projectId: string): Promise<void> };
  vault?: SecretVault;
  integrations?: IntegrationStore | null;
  rules?: RuleStore;
  knowledge?: KnowledgeStore;
  commands?: { forget(projectId: string): Promise<number> } | null;
  /** Deletes the build repository in our GitHub organization (`buildOrg`). */
  github?: {
    deleteBuildRepo(org: string, repo: BuildRepo): Promise<CleanupResult>;
    canDeleteRepos?(org: string): Promise<ReadinessCheck>;
  } | null;
  buildOrg?: string | null;
  /** Deletes the hosting project in our Vercel team. */
  hosting?: {
    deleteProject(name: string): Promise<CleanupResult>;
    canDelete?(): Promise<ReadinessCheck>;
  } | null;
  /** Every project: what another project still uses is left alone. */
  projects?: () => ProjectState[];
  now?: () => number;
}

/**
 * Whether deleting a project would also get its build repository and hosting project, asked of
 * GitHub and Vercel without deleting anything. Shown before anyone deletes, so a missing
 * permission is fixed first rather than found as "Refused" afterwards.
 */
export async function deletionReadiness(
  deps: PurgeDeps,
): Promise<{ repository: ReadinessCheck; hosting: ReadinessCheck; checkedAt: string }> {
  const repository: ReadinessCheck = !deps.github
    ? { state: 'off', detail: 'No GitHub App is connected here.' }
    : !deps.buildOrg
      ? { state: 'off', detail: 'No build organization is set (GITHUB_BUILD_ORG).' }
      : deps.github.canDeleteRepos
        ? await deps.github.canDeleteRepos(deps.buildOrg)
        : { state: 'unknown', detail: 'This GitHub connection can’t be checked.' };
  const hosting: ReadinessCheck = !deps.hosting
    ? { state: 'off', detail: 'No Vercel token is connected here.' }
    : deps.hosting.canDelete
      ? await deps.hosting.canDelete()
      : { state: 'unknown', detail: 'This Vercel connection can’t be checked.' };
  return { repository, hosting, checkedAt: new Date(deps.now?.() ?? Date.now()).toISOString() };
}

/** The steps, in order. Each is idempotent: running one twice removes nothing more. */
export const PURGE_STEPS = [
  'workflow',
  'repository',
  'hosting',
  'connection',
  'blobs',
  'secrets',
  'integrations',
  'rules',
  'knowledge',
  'commands',
  'events',
] as const;
export type PurgeStep = (typeof PURGE_STEPS)[number];

/** Saved connections remember the project they were first entered on. */
interface SavedConnection {
  createdFrom?: { projectId: string; name: string } | null;
}

/** Other projects, not counting ones whose own purge is under way. */
const others = (deps: PurgeDeps, s: ProjectState) =>
  (deps.projects?.() ?? []).filter((p) => p.projectId !== s.projectId && !p.deletion?.purging);

async function run(
  deps: PurgeDeps,
  s: ProjectState,
  step: PurgeStep,
): Promise<Record<string, unknown>> {
  const id = s.projectId;
  switch (step) {
    case 'repository': {
      const repo = s.buildRepo;
      if (!repo) return { outcome: 'skipped', detail: 'No build repository.' };
      const sharer = others(deps, s).find(
        (p) => p.buildRepo?.repo.toLowerCase() === repo.repo.toLowerCase(),
      );
      if (sharer)
        return { outcome: 'skipped', detail: `${repo.repo} is also ${sharer.name}'s: left.` };
      if (!deps.github || !deps.buildOrg)
        return {
          outcome: 'refused',
          detail: `No GitHub App or build organization is connected here, so ${repo.repo} was left.`,
        };
      return { ...(await deps.github.deleteBuildRepo(deps.buildOrg, repo)) };
    }
    case 'hosting': {
      const name = s.hosting?.project;
      if (!name) return { outcome: 'skipped', detail: 'No hosting project.' };
      const sharer = others(deps, s).find((p) => p.hosting?.project === name);
      if (sharer) return { outcome: 'skipped', detail: `${name} is also ${sharer.name}'s: left.` };
      if (!deps.hosting)
        return {
          outcome: 'refused',
          detail: `No Vercel token is connected here, so ${name} was left.`,
        };
      return { ...(await deps.hosting.deleteProject(name)) };
    }
    case 'connection': {
      const cid = s.intake?.connectionId;
      if (!cid) return { outcome: 'skipped', detail: 'No saved connection.' };
      const sharer = others(deps, s).find((p) => p.intake?.connectionId === cid);
      if (sharer)
        return {
          outcome: 'skipped',
          detail: `The saved connection is also ${sharer.name}'s: kept.`,
        };
      await deps.integrations?.delete(`connection:${cid}`);
      const secrets = deps.vault ? await deps.vault.deleteProject(`connection:${cid}`) : 0;
      return { outcome: 'deleted', detail: `Saved connection removed, with ${secrets} secret(s).` };
    }
    case 'workflow':
      if (!deps.stop) return { skipped: 'no orchestrator connected' };
      await deps.stop(id);
      return { stopped: true };
    case 'blobs':
      if (!deps.blobs) return { skipped: 'no blob store' };
      await deps.blobs.deleteProject(id);
      return { deleted: true };
    case 'secrets':
      return { deleted: deps.vault ? await deps.vault.deleteProject(id) : 0 };
    case 'integrations': {
      const store = deps.integrations;
      if (!store) return { skipped: 'no integration store' };
      await store.delete(`triage-replay:${id}`);
      let connections = 0;
      for (const { name, config } of await store.list<SavedConnection>('connection:')) {
        if (config.createdFrom?.projectId !== id) continue;
        await store.put(name, { ...config, createdFrom: null });
        connections++;
      }
      return { triageReplay: 'deleted', connectionsForgotten: connections };
    }
    case 'rules':
      return deps.rules ? await deps.rules.forgetProject(id) : { skipped: 'no rule store' };
    case 'knowledge':
      return deps.knowledge
        ? await deps.knowledge.forgetProject(id)
        : { skipped: 'no knowledge store' };
    case 'commands':
      return { deleted: deps.commands ? await deps.commands.forget(id) : 0 };
    case 'events':
      await deps.store.reset(id);
      return { deleted: true };
  }
}

/** How a purge was asked for. */
export interface PurgeOptions {
  /**
   * Deleted now, by an operator: no archive and no grace period needed (the project must not be
   * running). The daily purge never sets this.
   */
  now?: boolean;
  /** Outside resources the operator chose to keep. Recorded before anything runs, so a resumed purge keeps them too. */
  keep?: ('repository' | 'hosting')[];
}

const KEPT: Record<'repository' | 'hosting', string> = {
  repository: 'Kept: the operator chose to keep the build repository.',
  hosting: 'Kept: the operator chose to keep the hosting project.',
};

/**
 * Purges one project. It must be archived with a deletion requested, or be deleted now by an
 * operator (`opts.now`), or be a purge resumed: its log may already be partly gone. `by` is who ran
 * it: "vercel-cron" for the daily run, the operator's login otherwise.
 */
export async function purgeProject(
  deps: PurgeDeps,
  s: ProjectState,
  by: string,
  opts: PurgeOptions = {},
): Promise<Tombstone> {
  const id = s.projectId;
  const existing = await deps.tombstones.get(id);
  if (!existing) {
    if (opts.now) {
      if (s.status === 'running') throw new Error(`${id} is running: pause it before deleting it.`);
    } else if (s.status !== 'archived' || !s.deletion)
      throw new Error(`${id} is not an archived project scheduled for deletion.`);
  }
  const tombstone =
    existing ??
    (await deps.tombstones.begin({
      projectId: id,
      name: s.name,
      client: s.client,
      requestedBy: s.deletion?.requestedBy ?? by,
      requestedAt: new Date(deps.now?.() ?? Date.now()).toISOString(),
    }));
  // What the operator chose to keep is written down first: a purge cut off and resumed by the
  // daily run (which knows nothing of the choice) still keeps it.
  for (const step of opts.keep ?? []) {
    if (tombstone.steps[step]) continue;
    const result = { outcome: 'kept', detail: KEPT[step] };
    await deps.tombstones.step(id, step, result);
    tombstone.steps[step] = { at: new Date(deps.now?.() ?? Date.now()).toISOString(), result };
  }
  // From here on the project answers 410: nothing may write to it while it goes.
  if (!s.deletion?.purging && (await deps.store.head(id)) > 0) {
    const purging: NewEvent = {
      type: 'project.deletion',
      actor: { kind: 'system', id: by },
      subject: { kind: 'project', id },
      severity: 'notable',
      data: { action: 'purging', due: s.deletion?.due ?? null },
    };
    await deps.store.append(id, [purging]);
  }
  for (const step of PURGE_STEPS) {
    if (tombstone.steps[step]) continue;
    const result = await run(deps, s, step);
    await deps.tombstones.step(id, step, result);
  }
  await deps.tombstones.finish(id, by);
  return (await deps.tombstones.get(id))!;
}

/**
 * The daily run: purges every archived project whose deletion is due, and resumes purges a
 * previous run left unfinished. One project failing doesn't stop the others.
 */
export async function purgeDue(
  deps: PurgeDeps,
  projects: ProjectState[],
  by: string,
): Promise<{ purged: string[]; failed: { projectId: string; error: string }[] }> {
  const now = deps.now?.() ?? Date.now();
  const due = projects.filter(
    (s) => s.status === 'archived' && s.deletion && Date.parse(s.deletion.due) <= now,
  );
  // A purge cut off after its log went has no project left to list: finish it from the record.
  const unfinished = (await deps.tombstones.list()).filter(
    (t) => !t.finishedAt && !due.some((s) => s.projectId === t.projectId),
  );
  const purged: string[] = [];
  const failed: { projectId: string; error: string }[] = [];
  const attempt = async (id: string, s: ProjectState) => {
    try {
      await purgeProject(deps, s, by);
      purged.push(id);
    } catch (err) {
      failed.push({ projectId: id, error: (err as Error).message });
    }
  };
  for (const s of due) await attempt(s.projectId, s);
  for (const t of unfinished) {
    const s = projects.find((p) => p.projectId === t.projectId);
    await attempt(t.projectId, s ?? ({ projectId: t.projectId } as ProjectState));
  }
  return { purged, failed };
}
