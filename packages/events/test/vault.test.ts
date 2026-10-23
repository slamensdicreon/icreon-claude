import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { masterKey, MemoryVault, migrate, PostgresVault } from '../src';

const key = () => masterKey(randomBytes(32).toString('base64'));

describe('PostgresVault', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await migrate(db);
  }, 60_000);
  afterAll(async () => {
    await db.close();
  });

  it('seals a secret that only the vault can open, keeping only a reference and a hint', async () => {
    const vault = new PostgresVault(db, [key()]);
    const ref = await vault.seal('prj-1', 'sitecore.environment', 'client-secret-value-1234');
    expect(ref.reference).toMatch(/^vault:[0-9a-f-]{36}$/);
    expect(ref.hint).toBe('1234');
    const { rows } = await db.query<{ ciphertext: Uint8Array }>(
      'SELECT ciphertext FROM lw_secrets',
    );
    expect(Buffer.from(rows[0]!.ciphertext).toString('utf8')).not.toContain('client-secret');
    await expect(vault.open(ref.reference)).resolves.toBe('client-secret-value-1234');
  });

  it('refuses a row moved to another project, and a key it was not sealed with', async () => {
    const k = key();
    const vault = new PostgresVault(db, [k]);
    const ref = await vault.seal('prj-2', 'edge.preview', 'context-id-abcd');
    await db.query(`UPDATE lw_secrets SET project_id = 'prj-other' WHERE id = $1`, [
      ref.reference.slice(6),
    ]);
    await expect(vault.open(ref.reference)).rejects.toThrow();

    const ref2 = await vault.seal('prj-2', 'edge.live', 'context-id-efgh');
    await expect(new PostgresVault(db, [key()]).open(ref2.reference)).rejects.toThrow(
      /not configured/,
    );
    // After a rotation the old key, listed second, still opens what it sealed.
    await expect(new PostgresVault(db, [key(), k]).open(ref2.reference)).resolves.toBe(
      'context-id-efgh',
    );
  });

  it('rejects a master key of the wrong length', () => {
    expect(() => masterKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('MemoryVault', () => {
  it('round-trips, and gives short values no hint', async () => {
    const vault = new MemoryVault();
    const ref = await vault.seal('p', 'x', 'short');
    expect(ref.hint).toBe('');
    await expect(vault.open(ref.reference)).resolves.toBe('short');
    await expect(vault.open('vault:00000000-0000-0000-0000-000000000000')).rejects.toThrow();
  });
});
