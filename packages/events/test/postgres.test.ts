import { PGlite } from '@electric-sql/pglite';
import type { LwEvent, NewEvent } from '@lw/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listenWithPglite, migrate, PostgresEventStore, Projections } from '../src';

const status = (s: 'running' | 'paused'): NewEvent => ({
  type: 'project.status',
  actor: { kind: 'system', id: 't' },
  subject: { kind: 'project', id: 'p' },
  severity: 'routine',
  data: { status: s },
});

async function until(fn: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

// One in-process Postgres per file (starting one takes seconds); each test starts from empty tables.
let db: PGlite;
let store: PostgresEventStore;

beforeAll(async () => {
  db = new PGlite();
  await migrate(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec('TRUNCATE lw_events, lw_project_heads');
  store = await PostgresEventStore.connect(db, listenWithPglite(db));
});

afterEach(async () => {
  await store.close();
});

describe('PostgresEventStore', () => {
  it('migrates idempotently', async () => {
    await migrate(db);
    await migrate(db);
    expect(await store.projectIds()).toEqual([]);
  });

  it('allocates gap-free seqs per project, even for concurrent appends', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.append('a', [status(i % 2 ? 'paused' : 'running'), status('running')]),
      ),
    );
    await store.append('b', [status('running')]);
    const a = await store.read('a');
    expect(a.map((e) => e.seq)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(await store.head('a')).toBe(40);
    expect(await store.head('b')).toBe(1);
    expect(await store.projectIds()).toEqual(['a', 'b']);
  });

  it('reads with bounds, order and limit, and round-trips the event shape', async () => {
    const [first] = await store.append('a', [
      status('running'),
      status('paused'),
      status('running'),
    ]);
    expect((await store.read('a', { after: 1 })).map((e) => e.seq)).toEqual([2, 3]);
    expect((await store.read('a', { before: 3, order: 'desc' })).map((e) => e.seq)).toEqual([2, 1]);
    expect((await store.read('a', { order: 'desc', limit: 1 })).map((e) => e.seq)).toEqual([3]);
    const [back] = await store.read('a', { limit: 1 });
    expect(back).toEqual(first);
  });

  it('commits nothing when any event in a batch is invalid', async () => {
    const bad = { ...status('running'), data: { status: 'exploded' } } as unknown as NewEvent;
    await expect(store.append('a', [status('running'), bad])).rejects.toThrow();
    expect(await store.head('a')).toBe(0);
  });

  it('delivers the live tail in order to a store in another process', async () => {
    // A second store on the same database stands in for another service (API vs worker).
    const other = await PostgresEventStore.connect(db, listenWithPglite(db));
    const seen: LwEvent[] = [];
    other.subscribe((e) => seen.push(e));
    for (let i = 0; i < 5; i++) await store.append('a', [status('running'), status('paused')]);
    await store.append('b', [status('running')]);
    await until(() => seen.length === 11);
    expect(seen.filter((e) => e.projectId === 'a').map((e) => e.seq)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    await other.close();
  });

  it('feeds projections that rebuild from history and then follow, with read-your-writes', async () => {
    await store.append('a', [status('running')]);
    const projections = new Projections(store);
    await projections.start();
    expect(projections.get('a')?.seq).toBe(1);
    const [e] = await store.append('a', [status('paused')]);
    await projections.waitFor('a', e!.seq);
    expect(projections.get('a')).toMatchObject({ seq: 2, status: 'paused' });
    projections.stop();
  });
});
