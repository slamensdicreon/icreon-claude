/**
 * One writer per item: while a task's session changes an item, no other task may change it. Locks
 * are released when the session ends (or its result is accepted), and lapse after a while without
 * writes, so a task that stalled or escalated doesn't hold others up.
 */
export interface WriteLocks {
  /** Takes (or renews) the paths for the task, or says which task holds one of them. */
  acquire(
    projectId: string,
    taskId: string,
    paths: string[],
  ): Promise<{ ok: true } | { ok: false; path: string; heldBy: string }>;
  /** Everything the task holds, when its session ends. */
  release(projectId: string, taskId: string): Promise<void>;
  /**
   * The paths for one call only, for a write that merges into what is stored at that moment (an
   * ID added to a list): it can't drop another task's change, so it needs no session-long lock.
   * Fails like `acquire` while another task's session holds a path; `brief` says another task's
   * one-call lock holds it, which frees within seconds. The returned function releases the paths.
   */
  acquireBrief?(
    projectId: string,
    taskId: string,
    paths: string[],
  ): Promise<
    { ok: true; release: () => void } | { ok: false; path: string; heldBy: string; brief: boolean }
  >;
}

/** A one-call lock's holder: never a task's own session. */
const BRIEF = '\u0001brief:';

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
        return { ok: false as const, path: paths[i]!, heldBy: holder(h.taskId) };
    }
    for (const key of keys) this.held.set(key, { taskId, until: t + this.ttlMs });
    return { ok: true as const };
  }

  async acquireBrief(projectId: string, taskId: string, paths: string[]) {
    const t = this.now();
    const keys = paths.map((p) => `${projectId}\u0000${p.toLowerCase().replace(/\/+$/, '')}`);
    for (const [i, key] of keys.entries()) {
      const h = this.held.get(key);
      if (h && h.taskId !== taskId && h.taskId !== `${BRIEF}${taskId}` && h.until > t)
        return {
          ok: false as const,
          path: paths[i]!,
          heldBy: holder(h.taskId),
          brief: h.taskId.startsWith(BRIEF),
        };
    }
    // The task's own session lock on a path stays as it is; the rest are held for this call.
    const mine = keys.filter(
      (k) => this.held.get(k)?.taskId !== taskId || this.held.get(k)!.until <= t,
    );
    const brief = { taskId: `${BRIEF}${taskId}`, until: t + 2 * 60_000 };
    for (const key of mine) this.held.set(key, brief);
    return {
      ok: true as const,
      release: () => {
        for (const key of mine) if (this.held.get(key) === brief) this.held.delete(key);
      },
    };
  }

  async release(projectId: string, taskId: string) {
    for (const [key, h] of this.held)
      if (h.taskId === taskId && key.startsWith(`${projectId}\u0000`)) this.held.delete(key);
  }
}

const holder = (id: string) => (id.startsWith(BRIEF) ? id.slice(BRIEF.length) : id);
