import { useSyncExternalStore } from 'react';
import { API, get } from './api';

/**
 * Snapshots, kept current by one event stream per open project. Every event bumps the project's
 * version; mounted resources of that project refetch (once per burst). The API answers commands
 * only after its read model has caught up, so a refetch after a command already shows its effect.
 */

export type ConnState =
  { kind: 'live' } | { kind: 'reconnecting' } | { kind: 'catching-up'; n: number };

interface Entry {
  /** Replaced (never mutated) when it changes, so React can compare by identity. */
  snap: { data: unknown; error: Error | null };
  version: number;
  loading: Promise<void> | null;
}

const EMPTY = { data: undefined, error: null };

type Listener = () => void;

class LiveStore {
  private readonly entries = new Map<string, Entry>();
  private readonly versions = new Map<string, number>();
  private readonly listeners = new Set<Listener>();
  private source: EventSource | null = null;
  private sourceProject: string | null = null;
  private lastSeq = 0;
  private flush: number | null = null;
  private pending = new Set<string>();
  conn: ConnState = { kind: 'live' };
  /** Events that arrived since the page last looked (for "n new events"). */
  readonly onEvent = new Set<(projectId: string, type: string) => void>();

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private emit() {
    for (const l of this.listeners) l();
  }

  version(projectId: string) {
    return this.versions.get(projectId) ?? 0;
  }

  /** The current value of a resource; starts a fetch when it is missing or out of date. */
  read<T>(
    projectId: string | null,
    path: string | null,
  ): { data: T | undefined; error: Error | null } {
    if (!path) return EMPTY;
    const v = projectId ? this.version(projectId) : 0;
    let e = this.entries.get(path);
    if (!e) {
      e = { snap: EMPTY, version: -1, loading: null };
      this.entries.set(path, e);
    }
    if (e.version !== v && !e.loading) {
      const entry = e;
      entry.loading = get<T>(path)
        .then((data) => {
          entry.snap = { data, error: null };
        })
        .catch((err: Error) => {
          entry.snap = { data: entry.snap.data, error: err };
        })
        .finally(() => {
          entry.version = v;
          entry.loading = null;
          this.emit();
        });
    }
    return e.snap as { data: T | undefined; error: Error | null };
  }

  /** Refetch one resource now (after a command whose result the page shows at once). */
  refresh(projectId: string) {
    this.versions.set(projectId, this.version(projectId) + 1);
    this.emit();
  }

  invalidate(projectId: string) {
    this.pending.add(projectId);
    if (this.flush !== null) return;
    this.flush = window.setTimeout(() => {
      this.flush = null;
      for (const p of this.pending) this.versions.set(p, this.version(p) + 1);
      this.pending.clear();
      this.emit();
    }, 120);
  }

  /** Streams one project's events. Switching projects closes the previous stream. */
  watch(projectId: string, afterSeq: number) {
    if (this.sourceProject === projectId && this.source) return;
    this.close();
    this.sourceProject = projectId;
    this.lastSeq = afterSeq;
    this.open();
  }

  private open() {
    const projectId = this.sourceProject!;
    const es = new EventSource(`${API}/projects/${projectId}/stream?after=${this.lastSeq}`, {
      withCredentials: true,
    });
    this.source = es;
    let reopening = this.conn.kind === 'reconnecting';
    es.addEventListener('open', () => {
      if (!reopening) return;
      this.conn = { kind: 'catching-up', n: 0 };
      this.emit();
      window.setTimeout(() => {
        this.conn = { kind: 'live' };
        this.emit();
      }, 2500);
      reopening = false;
    });
    es.addEventListener('lw', (m) => {
      const e = JSON.parse((m as MessageEvent<string>).data) as { seq: number; type: string };
      this.lastSeq = Math.max(this.lastSeq, e.seq);
      if (this.conn.kind === 'catching-up') this.conn = { kind: 'catching-up', n: this.conn.n + 1 };
      for (const f of this.onEvent) f(projectId, e.type);
      this.invalidate(projectId);
    });
    // The server ends streams on schedule (before a platform time limit): reopen at once, quietly.
    es.addEventListener('bye', () => {
      if (this.source !== es) return;
      this.close();
      this.open();
    });
    // The log was reseeded below what we've seen (a demo restarted): refetch, then follow on.
    es.addEventListener('reset', (m) => {
      if (this.source !== es) return;
      const { head } = JSON.parse((m as MessageEvent<string>).data) as { head: number };
      this.close();
      this.lastSeq = head;
      this.refresh(projectId);
      this.open();
    });
    es.addEventListener('error', () => {
      if (this.conn.kind !== 'reconnecting') {
        this.conn = { kind: 'reconnecting' };
        this.emit();
      }
      reopening = true;
    });
  }

  close() {
    this.source?.close();
    this.source = null;
  }

  /** Demo control: drop the connection for a while, then resume from the last event seen. */
  simulateDrop(ms = 4000) {
    if (!this.sourceProject) return;
    this.close();
    this.conn = { kind: 'reconnecting' };
    this.emit();
    window.setTimeout(() => this.open(), ms);
  }
}

export const live = new LiveStore();

/** A snapshot from the API, refetched whenever its project changes. */
export function useResource<T>(projectId: string | null, path: string | null) {
  return useSyncExternalStore(
    live.subscribe,
    () => live.read<T>(projectId, path),
    () => live.read<T>(projectId, path),
  );
}

export function useConn(): ConnState {
  return useSyncExternalStore(live.subscribe, () => live.conn);
}
