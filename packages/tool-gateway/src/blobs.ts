import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { del as delBlobs, get as getBlob, list as listBlobs, put as putBlob } from '@vercel/blob';

/**
 * Binary and document storage for tool servers (screenshots, assets, artifacts), addressed as
 * `blob://<project>/<key>`. A local folder in development; a private Vercel Blob store when deployed.
 */
export interface BlobStore {
  put(projectId: string, key: string, bytes: Uint8Array, contentType: string): Promise<string>;
  get(ref: string): Promise<Uint8Array>;
  /** Deletes everything stored for a project (a project reset). */
  deleteProject(projectId: string): Promise<void>;
}

export class LocalBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  async put(projectId: string, key: string, bytes: Uint8Array) {
    const path = this.path(projectId, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    return `blob://${projectId}/${key}`;
  }

  async get(ref: string) {
    const m = /^blob:\/\/([^/]+)\/(.+)$/.exec(ref);
    if (!m) throw new Error(`Not a blob reference: ${ref}`);
    return new Uint8Array(await readFile(this.path(m[1]!, m[2]!)));
  }

  async deleteProject(projectId: string) {
    // path() refuses an empty or relative project id, so this stays inside the root.
    await rm(dirname(this.path(projectId, 'x')), { recursive: true, force: true });
  }

  private path(projectId: string, key: string) {
    if ([projectId, ...key.split('/')].some((s) => !s || s === '.' || s === '..')) {
      throw new Error(`Refusing blob key ${projectId}/${key}`);
    }
    return join(this.root, projectId, key);
  }
}

/** Blobs in memory: tests and the demo projects. */
export class MemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();

  async put(projectId: string, key: string, bytes: Uint8Array) {
    const ref = `blob://${projectId}/${key}`;
    this.blobs.set(ref, bytes);
    return ref;
  }

  async get(ref: string) {
    const b = this.blobs.get(ref);
    if (!b) throw new Error(`No blob at ${ref}`);
    return b;
  }

  async deleteProject(projectId: string) {
    for (const ref of [...this.blobs.keys()]) {
      if (ref.startsWith(`blob://${projectId}/`)) this.blobs.delete(ref);
    }
  }
}

/**
 * A private Vercel Blob store, shared by the API, the worker and the demo runner. Nothing in it is
 * reachable without credentials: the API streams blobs to signed-in operators.
 *
 * Credentials, first found wins: `BLOB_READ_WRITE_TOKEN`; the daemon's OIDC token file
 * (`VERCEL_OIDC_TOKEN_FILE`, refreshed by Vercel, so read on each call) with `BLOB_STORE_ID`; or
 * the SDK's own lookup (`VERCEL_OIDC_TOKEN` in a Function).
 */
export class VercelBlobStore implements BlobStore {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async put(projectId: string, key: string, bytes: Uint8Array, contentType: string) {
    const ref = `blob://${projectId}/${key}`;
    await putBlob(this.pathname(projectId, key), Buffer.from(bytes), {
      access: 'private',
      contentType,
      addRandomSuffix: false,
      allowOverwrite: true,
      ...(await this.auth()),
    });
    return ref;
  }

  async get(ref: string) {
    const m = /^blob:\/\/([^/]+)\/(.+)$/.exec(ref);
    if (!m) throw new Error(`Not a blob reference: ${ref}`);
    const res = await getBlob(this.pathname(m[1]!, m[2]!), {
      access: 'private',
      ...(await this.auth()),
    });
    if (res?.statusCode !== 200) throw new Error(`No blob at ${ref}`);
    return new Uint8Array(await new Response(res.stream).arrayBuffer());
  }

  async deleteProject(projectId: string) {
    this.pathname(projectId, 'x');
    let cursor: string | undefined;
    do {
      const page = await listBlobs({
        prefix: `${projectId}/`,
        cursor,
        limit: 1000,
        ...(await this.auth()),
      });
      if (page.blobs.length)
        await delBlobs(
          page.blobs.map((b) => b.url),
          await this.auth(),
        );
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
  }

  private pathname(projectId: string, key: string) {
    if ([projectId, ...key.split('/')].some((s) => !s || s === '.' || s === '..')) {
      throw new Error(`Refusing blob key ${projectId}/${key}`);
    }
    return `${projectId}/${key}`;
  }

  private async auth(): Promise<{ token?: string; oidcToken?: string; storeId?: string }> {
    if (this.env.BLOB_READ_WRITE_TOKEN) return { token: this.env.BLOB_READ_WRITE_TOKEN };
    if (this.env.VERCEL_OIDC_TOKEN_FILE && this.env.BLOB_STORE_ID) {
      const oidcToken = (await readFile(this.env.VERCEL_OIDC_TOKEN_FILE, 'utf8')).trim();
      return { oidcToken, storeId: this.env.BLOB_STORE_ID };
    }
    return {};
  }
}

export type BlobStoreKind = 'memory' | 'local' | 'vercel';

/** The blob store a process was configured with. */
export function openBlobStore(kind: BlobStoreKind, dataDir: string): BlobStore {
  if (kind === 'memory') return new MemoryBlobStore();
  if (kind === 'vercel') return new VercelBlobStore();
  return new LocalBlobStore(join(dataDir, 'blobs'));
}
