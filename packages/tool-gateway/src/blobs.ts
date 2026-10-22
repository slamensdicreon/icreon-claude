import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Binary and document storage for tool servers (screenshots, assets, artifacts), addressed as
 * `blob://<project>/<key>`. A local folder in development; S3 behind the same interface later.
 */
export interface BlobStore {
  put(projectId: string, key: string, bytes: Uint8Array, contentType: string): Promise<string>;
  get(ref: string): Promise<Uint8Array>;
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

  private path(projectId: string, key: string) {
    if ([projectId, ...key.split('/')].some((s) => !s || s === '.' || s === '..')) {
      throw new Error(`Refusing blob key ${projectId}/${key}`);
    }
    return join(this.root, projectId, key);
  }
}
