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

/**
 * Versioned project documents (Blueprint, inventories, Platform Notes, reports). Content lives in
 * the blob store; each version is announced on the event log, which is also where versions are
 * counted from, so every process agrees on the next number.
 */
export class ArtifactLibrary {
  constructor(
    private readonly store: EventStore,
    private readonly blobs: BlobStore,
  ) {}

  async versions(projectId: string, artifactId: string): Promise<StoredVersion[]> {
    const events = await this.store.read(projectId);
    return events
      .filter(
        (e): e is Extract<LwEvent, { type: 'artifact.versioned' }> =>
          e.type === 'artifact.versioned' && e.data.artifactId === artifactId,
      )
      .map((e) => ({ ...e.data }));
  }

  async latest(projectId: string, artifactId: string): Promise<StoredVersion | null> {
    const all = await this.versions(projectId, artifactId);
    return all.reduce<StoredVersion | null>((a, v) => (!a || v.version > a.version ? v : a), null);
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
    const meta = version
      ? all.find((v) => v.version === version)
      : all.reduce<StoredVersion | undefined>(
          (a, v) => (!a || v.version > a.version ? v : a),
          undefined,
        );
    if (!meta?.ref) return null;
    return { meta, content: new TextDecoder().decode(await this.blobs.get(meta.ref)) };
  }
}
