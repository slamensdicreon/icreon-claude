import type { LwEvent } from '@lw/contracts';
import { applyEvent, createProjectState, type ProjectState } from '@lw/domain';
import type { EventStore } from './store';

export interface ProjectionOptions {
  /**
   * Replay every project at start. Long-running processes do; a request-driven API on paused,
   * short-lived instances doesn't, and folds each project on first use instead.
   */
  eager?: boolean;
}

/**
 * Keeps one ProjectState per project, folded from the store. Two ways in, both safe together:
 *
 * - the live tail (the store's subscription), which keeps a long-running process current, and
 * - `catchUp`, which reads whatever the store has past the state's seq. A request-driven API calls
 *   it before answering, so a paused instance that missed notifications still answers from the
 *   head of the log.
 *
 * Events apply strictly in seq order. One that arrives ahead of a gap triggers a catch-up instead.
 * Snapshots read from here; each carries the seq it reflects.
 */
export class Projections {
  private readonly states = new Map<string, ProjectState>();
  /** Id of each project's seq-1 event: a different one means the log was reset and rewritten. */
  private readonly firstIds = new Map<string, string>();
  private readonly chains = new Map<string, Promise<void>>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly store: EventStore) {}

  async start(opts: ProjectionOptions = {}): Promise<void> {
    this.unsubscribe = this.store.subscribe((e) => this.onLive(e));
    if (opts.eager ?? true) await this.catchUpAll();
  }

  stop(): void {
    this.unsubscribe?.();
  }

  /**
   * Brings one project up to the head of its log. Concurrent calls for a project share one read.
   * If the log is behind the state (a demo project reseeded), the state is rebuilt from scratch.
   */
  catchUp(projectId: string): Promise<void> {
    const prev = this.chains.get(projectId) ?? Promise.resolve();
    const next = prev.then(() => this.fold(projectId));
    this.chains.set(
      projectId,
      next.catch(() => {}),
    );
    return next;
  }

  /** Catches up every project the store knows, including ones created elsewhere. */
  async catchUpAll(): Promise<void> {
    const ids = await this.store.projectIds();
    // A project whose log was deleted (a retired demo) leaves every instance's list too.
    const live = new Set(ids);
    for (const id of this.states.keys()) if (!live.has(id)) this.states.delete(id);
    await Promise.all(ids.map((id) => this.catchUp(id)));
  }

  /**
   * Resolves once the project's read model has caught up to `seq`. Commands await this before
   * answering, so a snapshot fetched right after a command always reflects it.
   */
  async waitFor(projectId: string, seq: number, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while ((this.states.get(projectId)?.seq ?? 0) < seq) {
      if (Date.now() > deadline)
        throw new Error(`Read model for ${projectId} stuck below seq ${seq}`);
      await this.catchUp(projectId);
      if ((this.states.get(projectId)?.seq ?? 0) >= seq) return;
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  get(projectId: string): ProjectState | undefined {
    return this.states.get(projectId);
  }

  all(): ProjectState[] {
    return [...this.states.values()];
  }

  private async fold(projectId: string): Promise<void> {
    const head = await this.store.head(projectId);
    let s = this.states.get(projectId);
    if (s && head < s.seq) {
      this.states.delete(projectId);
      s = undefined;
    }
    if (!head || (s && s.seq >= head)) return;
    if (s) {
      // A log reset and rewritten past where this read model stopped: start over from seq 1.
      const [first] = await this.store.read(projectId, { after: 0, before: 2 });
      if (first && first.id !== this.firstIds.get(projectId)) {
        this.states.delete(projectId);
        s = undefined;
      }
    }
    for (const e of await this.store.read(projectId, { after: s?.seq ?? 0 })) this.apply(e);
  }

  private onLive(e: LwEvent): void {
    // The live tail can run ahead of a catch-up in flight; never apply across a gap.
    if (!this.apply(e)) void this.catchUp(e.projectId).catch(() => {});
  }

  /** Applies the next event in sequence. False when `e` is ahead of a gap. */
  private apply(e: LwEvent): boolean {
    let s = this.states.get(e.projectId);
    if (s && e.seq === 1 && this.firstIds.get(e.projectId) !== e.id) {
      this.states.delete(e.projectId);
      s = undefined;
    }
    if (!s) {
      if (e.seq !== 1) return false;
      s = createProjectState(e.projectId);
      this.states.set(e.projectId, s);
      this.firstIds.set(e.projectId, e.id);
    }
    if (e.seq <= s.seq) return true; // already applied
    if (e.seq !== s.seq + 1) return false;
    applyEvent(s, e);
    return true;
  }
}
