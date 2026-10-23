import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, PostgresIntegrationStore } from '../src';

describe('PostgresIntegrationStore', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await migrate(db);
  }, 60_000);
  afterAll(async () => {
    await db.close();
  });

  it('stores, replaces and deletes a named config', async () => {
    const store = new PostgresIntegrationStore(db);
    expect(await store.get('github.app')).toBeNull();
    await store.put('github.app', { appId: 1, privateKeyRef: 'vault:x' });
    await store.put('github.app', { appId: 2, privateKeyRef: 'vault:y' });
    expect(await store.get('github.app')).toEqual({ appId: 2, privateKeyRef: 'vault:y' });
    await store.delete('github.app');
    expect(await store.get('github.app')).toBeNull();
  });
});
