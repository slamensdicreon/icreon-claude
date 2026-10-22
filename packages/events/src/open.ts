import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { listenWithPglite, migrate, PostgresEventStore, type Listen } from './postgres';
import { InMemoryEventStore, type EventStore } from './store';

export type StoreKind = 'memory' | 'pglite' | 'postgres';

/**
 * Pins TLS to full verification. node-postgres already treats `sslmode=require` (what Neon's URLs
 * carry) as verify-full and warns that a future major version will weaken it; saying so explicitly
 * keeps the stronger check and the logs quiet.
 */
export function verifiedTls(url: string): string {
  return url.replace(/([?&]sslmode=)(prefer|require|verify-ca)\b/, '$1verify-full');
}

export interface OpenedStore {
  store: EventStore;
  /** The Postgres client behind the store, for the command bus. Null for the memory store. */
  sql: pg.Pool | null;
  /** LISTEN on the store's connection, where it has one (postgres with `listen`). */
  listen: Listen | null;
  close(): Promise<void>;
}

export interface OpenStoreOptions {
  dataDir: string;
  /** Pooled connections for reads and appends. */
  databaseUrl?: string;
  /**
   * A direct (unpooled) connection for LISTEN, which a transaction-mode pooler such as Neon's
   * can't carry. Defaults to `databaseUrl`.
   */
  listenUrl?: string;
  /**
   * Follow the live tail with LISTEN. Long-running processes do. A request-driven API on paused
   * instances reads from the log instead (`Projections.catchUp`, the stream's poll), so an idle
   * socket can't fail between requests.
   */
  listen?: boolean;
  log?: (msg: string, err?: unknown) => void;
}

/**
 * memory: lost on restart, fine for the simulator. pglite: real Postgres in-process, persisted to
 * a local folder, one process only. postgres: the shared database every service uses.
 */
export async function openStore(kind: StoreKind, opts: OpenStoreOptions): Promise<OpenedStore> {
  const log = opts.log ?? ((msg, err) => console.error(msg, err ?? ''));
  if (kind === 'memory') {
    return { store: new InMemoryEventStore(), sql: null, listen: null, close: async () => {} };
  }

  if (kind === 'pglite') {
    // Loaded on demand: its WebAssembly payload is only needed for local, single-process runs.
    const { PGlite } = await import('@electric-sql/pglite');
    await mkdir(opts.dataDir, { recursive: true });
    const db = new PGlite(join(opts.dataDir, 'pglite'));
    await migrate(db);
    const store = await PostgresEventStore.connect(db, listenWithPglite(db));
    return {
      store,
      sql: null,
      listen: null,
      close: async () => {
        await store.close();
        await db.close();
      },
    };
  }

  if (!opts.databaseUrl) throw new Error('STORE=postgres needs DATABASE_URL');
  const pool = new pg.Pool({ connectionString: verifiedTls(opts.databaseUrl), max: 5 });
  // An idle client that the server or pooler closes emits here; without a handler it crashes the
  // process. The pool replaces the client on next use.
  pool.on('error', (err) => log('Postgres pool client error', err));
  await migrate(pool);

  if (opts.listen === false) {
    const store = await PostgresEventStore.connect(pool, async () => async () => {});
    return {
      store,
      sql: pool,
      listen: null,
      close: async () => {
        await store.close();
        await pool.end();
      },
    };
  }

  const tail = new ListenConnection(opts.listenUrl ?? opts.databaseUrl, log);
  const store = await PostgresEventStore.connect(pool, tail.listen);
  tail.onReconnect = () => store.resync();
  return {
    store,
    sql: pool,
    listen: tail.listen,
    close: async () => {
      await store.close();
      await tail.end();
      await pool.end();
    },
  };
}

/**
 * One LISTEN connection, outside the pool, that reconnects when it drops. Notifications sent while
 * it was down are lost, so after reconnecting the store re-reads every project's head.
 */
class ListenConnection {
  private client: pg.Client | null = null;
  private channels = new Map<string, (payload: string) => void>();
  private ended = false;
  private retry: NodeJS.Timeout | null = null;
  onReconnect: (() => Promise<void>) | null = null;

  constructor(
    private readonly url: string,
    private readonly log: (msg: string, err?: unknown) => void,
  ) {}

  readonly listen: Listen = async (channel, onPayload) => {
    this.channels.set(channel, onPayload);
    if (!this.client) await this.connect();
    else await this.client.query(`LISTEN ${channel}`);
    return async () => {
      this.channels.delete(channel);
      await this.client?.query(`UNLISTEN ${channel}`).catch(() => {});
    };
  };

  async end(): Promise<void> {
    this.ended = true;
    if (this.retry) clearTimeout(this.retry);
    await this.client?.end().catch(() => {});
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({ connectionString: verifiedTls(this.url) });
    client.on('notification', (msg) => {
      if (msg.payload) this.channels.get(msg.channel)?.(msg.payload);
    });
    const lost = (err?: unknown) => {
      if (this.client !== client || this.ended) return;
      this.log('Postgres LISTEN connection lost; reconnecting', err);
      this.client = null;
      void client.end().catch(() => {});
      this.schedule(1000);
    };
    client.on('error', lost);
    client.on('end', () => lost());
    await client.connect();
    for (const channel of this.channels.keys()) await client.query(`LISTEN ${channel}`);
    this.client = client;
  }

  private schedule(ms: number) {
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect()
        .then(() => this.onReconnect?.())
        .catch((err) => {
          this.log('Postgres LISTEN reconnect failed', err);
          this.schedule(Math.min(ms * 2, 30_000));
        });
    }, ms);
  }
}
