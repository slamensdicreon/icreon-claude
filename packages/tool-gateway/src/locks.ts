/**
 * One writer per item: while a task changes an item, no other task may change the same item. A
 * task's locks last until its result is accepted, or lapse after a while without writes (a task
 * that stalled doesn't hold others up for ever).
 */
export interface WriteLocks {
  /** Takes (or renews) the paths for the task, or says which task holds one of them. */
  acquire(
    projectId: string,
    taskId: string,
    paths: string[],
  ): Promise<{ ok: true } | { ok: false; path: string; heldBy: string }>;
  /** Everything the task holds, once its result is accepted. */
  release(projectId: string, taskId: string): Promise<void>;
}

/** In the worker's memory: enough for one worker process per project's queue. */
export class MemoryWriteLocks implements WriteLocks {
  private readonly held = new Map<string, { taskId: string; until: number }>();

  constructor(
    private readonly ttlMs = 30 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  async acquire(projectId: string, taskId: string, paths: string[]) {
    const t = this.now();
    const keys = paths.map((p) => `${projectId}\u0000${p.toLowerCase().replace(/\/+$/, '')}`);
    for (const [i, key] of keys.entries()) {
      const h = this.held.get(key);
      if (h && h.taskId !== taskId && h.until > t)
        return { ok: false as const, path: paths[i]!, heldBy: h.taskId };
    }
    for (const key of keys) this.held.set(key, { taskId, until: t + this.ttlMs });
    return { ok: true as const };
  }

  async release(projectId: string, taskId: string) {
    for (const [key, h] of this.held)
      if (h.taskId === taskId && key.startsWith(`${projectId}\u0000`)) this.held.delete(key);
  }
}
