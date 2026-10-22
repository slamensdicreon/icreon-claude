import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { listenWithPg, listenWithPglite, migrate, PostgresEventStore } from './postgres';
import { InMemoryEventStore, type EventStore } from './store';
import pg from 'pg';

export type StoreKind = 'memory' | 'pglite' | 'postgres';

export interface OpenedStore {
  store: EventStore;
  close(): Promise<void>;
}

/**
 * memory: lost on restart, fine for the simulator. pglite: real Postgres in-process, persisted to
 * a local folder, one process only. postgres: the shared database every service uses.
 */
export async function openStore(
  kind: StoreKind,
  opts: { dataDir: string; databaseUrl?: string },
): Promise<OpenedStore> {
  if (kind === 'memory') return { store: new InMemoryEventStore(), close: async () => {} };

  if (kind === 'pglite') {
    await mkdir(opts.dataDir, { recursive: true });
    const db = new PGlite(join(opts.dataDir, 'pglite'));
    await migrate(db);
    const store = await PostgresEventStore.connect(db, listenWithPglite(db));
    return {
      store,
      close: async () => {
        await store.close();
        await db.close();
      },
    };
  }

  if (!opts.databaseUrl) throw new Error('STORE=postgres needs DATABASE_URL');
  const pool = new pg.Pool({ connectionString: opts.databaseUrl });
  await migrate(pool);
  // LISTEN needs a connection of its own, outside the pool.
  const listener = new pg.Client({ connectionString: opts.databaseUrl });
  await listener.connect();
  const store = await PostgresEventStore.connect(pool, listenWithPg(listener));
  return {
    store,
    close: async () => {
      await store.close();
      await listener.end();
      await pool.end();
    },
  };
}
