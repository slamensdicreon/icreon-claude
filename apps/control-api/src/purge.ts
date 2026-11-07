import type { NewEvent } from '@lw/contracts';
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
  now?: () => number;
}

/** The steps, in order. Each is idempotent: running one twice removes nothing more. */
export const PURGE_STEPS = [
  'workflow',
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

async function run(deps: PurgeDeps, id: string, step: PurgeStep): Promise<Record<string, unknown>> {
  switch (step) {
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

/**
 * Purges one project. It must be archived with a deletion requested (or be a purge resumed: its
 * log may already be partly gone). `by` is who ran it: "vercel-cron" for the daily run.
 */
export async function purgeProject(
  deps: PurgeDeps,
  s: ProjectState,
  by: string,
): Promise<Tombstone> {
  const id = s.projectId;
  const existing = await deps.tombstones.get(id);
  if (!existing) {
    if (s.status !== 'archived' || !s.deletion)
      throw new Error(`${id} is not an archived project scheduled for deletion.`);
  }
  const tombstone =
    existing ??
    (await deps.tombstones.begin({
      projectId: id,
      name: s.name,
      client: s.client,
      requestedBy: s.deletion!.requestedBy,
      requestedAt: new Date(deps.now?.() ?? Date.now()).toISOString(),
    }));
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
    const result = await run(deps, id, step);
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
