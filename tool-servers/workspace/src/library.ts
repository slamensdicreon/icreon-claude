import type { LwEvent } from '@lw/contracts';
import type { EventStore } from '@lw/events';
import type { BlobStore } from '@lw/tool-gateway';

export type ArtifactKind = Extract<LwEvent, { type: 'artifact.versioned' }>['data']['kind'];

export interface StoredVersion {
  artifactId: string;
  kind: ArtifactKind;
  title: string;
  version: number;
  ref: string | null;
  format: 'markdown' | 'json' | 'png' | 'binary' | null;
}

/** A project's document versions as announced on its log, up to `seq`. */
interface Index {
  seq: number;
  /** The log's first event: a different one means the log was reset and rewritten. */
  firstId: string | null;
  byArtifact: Map<string, StoredVersion[]>;
}

const newest = (all: StoredVersion[]) =>
  all.reduce<StoredVersion | null>((a, v) => (!a || v.version > a.version ? v : a), null);

/**
 * Versioned project documents (Blueprint, inventories, Platform Notes, reports). Content lives in
 * the blob store; each version is announced on the event log, which is also where versions are
 * counted from, so every process agrees on the next number.
 *
 * The versions are indexed from the log as it grows: every call reads the log's tip and only the
 * events after what it has seen, so a project's long history is read once, not on every call,
 * and every answer is as fresh as the log.
 */
export class ArtifactLibrary {
  private readonly indexes = new Map<string, Index>();
  /** One catch-up per project at a time. */
  private readonly chains = new Map<string, Promise<Index>>();

  constructor(
    private readonly store: EventStore,
    private readonly blobs: BlobStore,
  ) {}

  async versions(projectId: string, artifactId: string): Promise<StoredVersion[]> {
    const ix = await this.index(projectId);
    return (ix.byArtifact.get(artifactId) ?? []).map((v) => ({ ...v }));
  }

  async latest(projectId: string, artifactId: string): Promise<StoredVersion | null> {
    return newest(await this.versions(projectId, artifactId));
  }

  private index(projectId: string): Promise<Index> {
    const prev = this.chains.get(projectId);
    const next = (prev ? prev.catch(() => null) : Promise.resolve(null)).then(() =>
      this.catchUp(projectId),
    );
    this.chains.set(projectId, next);
    void next
      .finally(() => {
        if (this.chains.get(projectId) === next) this.chains.delete(projectId);
      })
      .catch(() => {});
    return next;
  }

  private async catchUp(projectId: string): Promise<Index> {
    const { head, firstId } = await this.store.tip(projectId);
    let ix = this.indexes.get(projectId);
    // A log reset and rewritten, to any length: start over from seq 1.
    if (!ix || head < ix.seq || (ix.seq > 0 && firstId !== ix.firstId)) {
      ix = { seq: 0, firstId, byArtifact: new Map() };
      this.indexes.set(projectId, ix);
    }
    if (head > ix.seq) {
      for (const e of await this.store.read(projectId, { after: ix.seq })) {
        if (e.seq <= ix.seq) continue;
        if (e.type === 'artifact.versioned') {
          const list = ix.byArtifact.get(e.data.artifactId) ?? [];
          list.push({ ...e.data });
          ix.byArtifact.set(e.data.artifactId, list);
        }
        ix.seq = e.seq;
      }
    }
    ix.firstId = firstId;
    return ix;
  }

  async write(
    projectId: string,
    a: {
      artifactId: string;
      kind: ArtifactKind;
      title: string;
      format: 'markdown' | 'json';
      content: string;
      producer: string;
    },
  ): Promise<StoredVersion> {
    const version = ((await this.latest(projectId, a.artifactId))?.version ?? 0) + 1;
    const ext = a.format === 'json' ? 'json' : 'md';
    const ref = await this.blobs.put(
      projectId,
      `artifacts/${a.artifactId}/v${version}.${ext}`,
      new TextEncoder().encode(a.content),
      a.format === 'json' ? 'application/json' : 'text/markdown',
    );
    await this.store.append(projectId, [
      {
        type: 'artifact.versioned',
        actor: { kind: 'agent', id: a.producer },
        subject: { kind: 'artifact', id: a.artifactId },
        severity: 'notable',
        data: {
          artifactId: a.artifactId,
          kind: a.kind,
          title: a.title,
          version,
          ref,
          format: a.format,
        },
      },
    ]);
    return {
      artifactId: a.artifactId,
      kind: a.kind,
      title: a.title,
      version,
      ref,
      format: a.format,
    };
  }

  /** Content of a version (latest by default), or null if it has none stored. */
  async read(
    projectId: string,
    artifactId: string,
    version?: number,
  ): Promise<{ meta: StoredVersion; content: string } | null> {
    const all = await this.versions(projectId, artifactId);
    const meta = version ? all.find((v) => v.version === version) : newest(all);
    if (!meta?.ref) return null;
    return { meta, content: new TextDecoder().decode(await this.blobs.get(meta.ref)) };
  }
}
