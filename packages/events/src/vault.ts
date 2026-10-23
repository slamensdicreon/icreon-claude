import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { SqlClient } from './postgres';

/** A sealed secret's handle: what the event log stores in place of the value. */
export interface SealedRef {
  /** "vault:<uuid>" */
  reference: string;
  /** The last four characters, for people to recognise which value is stored. */
  hint: string;
}

/**
 * Project credentials, sealed at rest. The API seals what the New Project wizard collects; the
 * worker opens a secret at the moment a tool server needs it, and the value never reaches an
 * agent's context or the event log.
 */
export interface SecretVault {
  seal(projectId: string, name: string, value: string): Promise<SealedRef>;
  open(reference: string): Promise<string>;
}

/**
 * The master key: 32 bytes, base64, from CREDENTIALS_KEY. Its id is a short hash, stored with each
 * secret, so a rotated key can sit beside the old one while secrets are resealed.
 */
export function masterKey(base64: string): { id: string; key: Buffer } {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32) throw new Error('CREDENTIALS_KEY must be 32 bytes, base64-encoded.');
  return { id: createHash('sha256').update(key).digest('hex').slice(0, 12), key };
}

const hintOf = (value: string) => (value.length > 8 ? value.slice(-4) : '');

// The secret's id, project and name are authenticated with it: a row copied under another project
// or name fails to open.
const aad = (id: string, projectId: string, name: string) =>
  Buffer.from(`${id}\u0000${projectId}\u0000${name}`);

function seal(key: Buffer, id: string, projectId: string, name: string, value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(id, projectId, name));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { iv, ciphertext, tag: cipher.getAuthTag() };
}

function open(
  key: Buffer,
  row: {
    id: string;
    project_id: string;
    name: string;
    iv: Buffer;
    ciphertext: Buffer;
    tag: Buffer;
  },
): string {
  const decipher = createDecipheriv('aes-256-gcm', key, row.iv);
  decipher.setAAD(aad(row.id, row.project_id, row.name));
  decipher.setAuthTag(row.tag);
  return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
}

const idOf = (reference: string) => {
  const m = /^vault:([0-9a-f-]{36})$/.exec(reference);
  if (!m) throw new Error(`Not a vault reference: ${reference}`);
  return m[1]!;
};

export class PostgresVault implements SecretVault {
  private readonly keys: Map<string, Buffer>;
  private readonly current: { id: string; key: Buffer };

  /** `keys`: the current master key first, then any older ones still needed to open secrets. */
  constructor(
    private readonly sql: SqlClient,
    keys: { id: string; key: Buffer }[],
  ) {
    if (!keys.length) throw new Error('PostgresVault needs a master key (CREDENTIALS_KEY).');
    this.current = keys[0]!;
    this.keys = new Map(keys.map((k) => [k.id, k.key]));
  }

  async seal(projectId: string, name: string, value: string): Promise<SealedRef> {
    const id = randomUUID();
    const { iv, ciphertext, tag } = seal(this.current.key, id, projectId, name, value);
    await this.sql.query(
      `INSERT INTO lw_secrets (id, project_id, name, key_id, iv, ciphertext, tag)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, projectId, name, this.current.id, iv, ciphertext, tag],
    );
    return { reference: `vault:${id}`, hint: hintOf(value) };
  }

  async open(reference: string): Promise<string> {
    const { rows } = await this.sql.query<{
      id: string;
      project_id: string;
      name: string;
      key_id: string;
      iv: Buffer;
      ciphertext: Buffer;
      tag: Buffer;
    }>('SELECT id, project_id, name, key_id, iv, ciphertext, tag FROM lw_secrets WHERE id = $1', [
      idOf(reference),
    ]);
    const row = rows[0];
    if (!row) throw new Error(`No secret at ${reference}`);
    const key = this.keys.get(row.key_id);
    if (!key)
      throw new Error(`The key that sealed ${reference} (${row.key_id}) is not configured.`);
    return open(key, {
      ...row,
      iv: Buffer.from(row.iv),
      ciphertext: Buffer.from(row.ciphertext),
      tag: Buffer.from(row.tag),
    });
  }
}

/** Sealed in memory: tests, and local runs on the memory store. Lost on restart. */
export class MemoryVault implements SecretVault {
  private readonly rows = new Map<
    string,
    { id: string; project_id: string; name: string; iv: Buffer; ciphertext: Buffer; tag: Buffer }
  >();
  private readonly key = randomBytes(32);

  async seal(projectId: string, name: string, value: string): Promise<SealedRef> {
    const id = randomUUID();
    this.rows.set(id, {
      id,
      project_id: projectId,
      name,
      ...seal(this.key, id, projectId, name, value),
    });
    return { reference: `vault:${id}`, hint: hintOf(value) };
  }

  async open(reference: string): Promise<string> {
    const row = this.rows.get(idOf(reference));
    if (!row) throw new Error(`No secret at ${reference}`);
    return open(this.key, row);
  }
}
