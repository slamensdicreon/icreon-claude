import { randomUUID } from 'node:crypto';
import { LwEvent, type NewEvent } from '@lw/contracts';

export interface ReadOptions {
  /** Exclusive lower bound on seq. */
  after?: number;
  /** Exclusive upper bound on seq. */
  before?: number;
  limit?: number;
  order?: 'asc' | 'desc';
}

export type Listener = (e: LwEvent) => void;

/**
 * The append-only, per-project event log. In M0 it lives in memory; the Postgres implementation
 * (transactional outbox + Redis Streams fan-out) keeps this interface.
 */
export interface EventStore {
  /** Assigns id, seq and ts; validates every event against the contract. Atomic per call. */
  append(projectId: string, events: NewEvent[]): Promise<LwEvent[]>;
  read(projectId: string, opts?: ReadOptions): Promise<LwEvent[]>;
  head(projectId: string): Promise<number>;
  projectIds(): Promise<string[]>;
  /** Live tail of every project, in append order. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class InMemoryEventStore implements EventStore {
  private readonly logs = new Map<string, LwEvent[]>();
  private readonly listeners = new Set<Listener>();

  constructor(private readonly clock: Clock = systemClock) {}

  async append(projectId: string, events: NewEvent[]): Promise<LwEvent[]> {
    const log = this.logs.get(projectId) ?? [];
    const ts = this.clock.now().toISOString();
    // Validate the whole batch before committing any of it.
    const stored = events.map((e, i) =>
      LwEvent.parse({ ...e, id: randomUUID(), projectId, seq: log.length + i + 1, ts }),
    ) as LwEvent[];
    log.push(...stored);
    this.logs.set(projectId, log);
    for (const e of stored) for (const l of this.listeners) l(e);
    return stored;
  }

  async read(projectId: string, opts: ReadOptions = {}): Promise<LwEvent[]> {
    const { after = 0, before = Infinity, limit = Infinity, order = 'asc' } = opts;
    const log = this.logs.get(projectId) ?? [];
    // seq n lives at index n-1.
    const slice = log.slice(after, Math.min(log.length, before - 1));
    const ordered = order === 'asc' ? slice : slice.reverse();
    return ordered.slice(0, limit);
  }

  async head(projectId: string): Promise<number> {
    return this.logs.get(projectId)?.length ?? 0;
  }

  async projectIds(): Promise<string[]> {
    return [...this.logs.keys()];
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
