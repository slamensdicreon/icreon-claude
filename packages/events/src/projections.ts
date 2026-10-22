import type { LwEvent } from '@lw/contracts';
import { applyEvent, createProjectState, type ProjectState } from '@lw/domain';
import type { EventStore } from './store';

/**
 * Keeps one ProjectState per project, folded from the store. Rebuilds from the log on start, then
 * follows the live tail. Snapshots read from here; each carries the seq it reflects.
 */
export class Projections {
  private readonly states = new Map<string, ProjectState>();
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly store: EventStore) {}

  async start(): Promise<void> {
    // Subscribe first and buffer, so nothing appended during the rebuild is lost.
    const buffered: LwEvent[] = [];
    let rebuilding = true;
    this.unsubscribe = this.store.subscribe((e) => (rebuilding ? buffered.push(e) : this.apply(e)));
    for (const id of await this.store.projectIds()) {
      for (const e of await this.store.read(id)) this.apply(e);
    }
    rebuilding = false;
    for (const e of buffered) this.apply(e);
  }

  stop(): void {
    this.unsubscribe?.();
  }

  get(projectId: string): ProjectState | undefined {
    return this.states.get(projectId);
  }

  all(): ProjectState[] {
    return [...this.states.values()];
  }

  private apply(e: LwEvent): void {
    let s = this.states.get(e.projectId);
    if (!s) {
      s = createProjectState(e.projectId);
      this.states.set(e.projectId, s);
    }
    if (e.seq <= s.seq) return; // already applied during rebuild
    applyEvent(s, e);
  }
}
