import { PGlite } from '@electric-sql/pglite';
import type { NewEvent } from '@lw/contracts';
import { CommandError } from '@lw/domain';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CommandBus,
  InMemoryEventStore,
  listenWithPglite,
  migrate,
  PostgresEventStore,
  Projections,
} from '../src';

const status = (s: 'running' | 'paused'): NewEvent => ({
  type: 'project.status',
  actor: { kind: 'system', id: 't' },
  subject: { kind: 'project', id: 'p' },
  severity: 'routine',
  data: { status: s },
});

describe('Projections without a live tail', () => {
  it('folds a project on first catch-up and follows later appends', async () => {
    const store = new InMemoryEventStore();
    await store.append('p', [status('running'), status('paused')]);
    // Another process's view of the same log: nothing arrives on its subscription.
    const projections = new Projections(withoutTail(store));
    await projections.start({ eager: false });
    expect(projections.get('p')).toBeUndefined();

    await projections.catchUp('p');
    expect(projections.get('p')?.seq).toBe(2);
    expect(projections.get('p')?.status).toBe('paused');

    await store.append('p', [status('running')]);
    expect(projections.get('p')?.seq).toBe(2);
    await projections.waitFor('p', 3);
    expect(projections.get('p')?.status).toBe('running');
  });

  it('starts over when a log is reset and rewritten past where it stopped', async () => {
    const store = new InMemoryEventStore();
    const at = (s: 'running' | 'paused', ts: string) => ({ ...status(s), at: ts });
    await store.append('p', [
      at('running', '2026-01-01T00:00:00.000Z'),
      at('paused', '2026-01-02T00:00:00.000Z'),
    ]);
    const projections = new Projections(withoutTail(store));
    await projections.start({ eager: false });
    await projections.catchUp('p');
    expect(projections.get('p')?.startedAt).toBe('2026-01-01T00:00:00.000Z');

    await store.reset('p');
    await store.append('p', [
      at('paused', '2026-02-01T00:00:00.000Z'),
      at('paused', '2026-02-02T00:00:00.000Z'),
      at('running', '2026-02-03T00:00:00.000Z'),
    ]);
    await projections.catchUp('p');
    // Folding only seq 3 onto the old state would keep the old start date.
    expect(projections.get('p')).toMatchObject({ seq: 3, startedAt: '2026-02-03T00:00:00.000Z' });
  });

  it('drops a project whose log was deleted from the list', async () => {
    const store = new InMemoryEventStore();
    await store.append('p', [status('running')]);
    await store.append('q', [status('running')]);
    const projections = new Projections(withoutTail(store));
    await projections.start({ eager: false });
    await projections.catchUpAll();
    expect(
      projections
        .all()
        .map((s) => s.projectId)
        .sort(),
    ).toEqual(['p', 'q']);

    await store.reset('q');
    await projections.catchUpAll();
    expect(projections.all().map((s) => s.projectId)).toEqual(['p']);
  });

  it('discovers projects created elsewhere', async () => {
    const store = new InMemoryEventStore();
    const projections = new Projections(withoutTail(store));
    await projections.start({ eager: false });
    await store.append('a', [status('running')]);
    await store.append('b', [status('running')]);
    await projections.catchUpAll();
    expect(
      projections
        .all()
        .map((s) => s.projectId)
        .sort(),
    ).toEqual(['a', 'b']);
  });

  it('rebuilds when the log is reset and written again', async () => {
    const store = new InMemoryEventStore();
    await store.append('p', [status('running'), status('paused'), status('running')]);
    const projections = new Projections(withoutTail(store));
    await projections.start();
    expect(projections.get('p')?.seq).toBe(3);

    await store.reset('p');
    await store.append('p', [status('paused')]);
    await projections.catchUp('p');
    expect(projections.get('p')?.seq).toBe(1);
    expect(projections.get('p')?.status).toBe('paused');
  });

  it('never applies a live event across a gap', async () => {
    const store = new InMemoryEventStore();
    const projections = new Projections(store);
    await projections.start();
    await store.append('p', [status('running')]);
    expect(projections.get('p')?.seq).toBe(1);

    // Two appends this projection's tail misses, then one it sees: it must fetch the two first.
    const tail = withoutTail(store);
    await tail.append('p', [status('paused'), status('running')]);
    await store.append('p', [status('paused')]);
    await projections.waitFor('p', 4);
    expect(projections.get('p')?.seq).toBe(4);
    expect(projections.get('p')?.status).toBe('paused');
  });
});

/**
 * The same log with its live tail cut, as a request-driven instance sees it: appends through the
 * view notify nobody, and subscribing to it hears nothing.
 */
function withoutTail(store: InMemoryEventStore): InMemoryEventStore {
  const view = Object.create(store) as InMemoryEventStore;
  Object.defineProperty(view, 'listeners', { value: new Set() });
  view.subscribe = () => () => {};
  return view;
}

describe('Postgres reset and the command bus', () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await migrate(db);
  }, 60_000);
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.exec('TRUNCATE lw_events, lw_project_heads, lw_commands');
  });

  it('reset empties a project so it can be written from seq 1 again', async () => {
    const store = await PostgresEventStore.connect(db, listenWithPglite(db));
    await store.append('p', [status('running'), status('paused')]);
    await store.reset('p');
    expect(await store.head('p')).toBe(0);
    expect(await store.projectIds()).toEqual([]);
    const [e] = await store.append('p', [status('running')]);
    expect(e!.seq).toBe(1);
    await store.close();
  });

  it('runs a command in the runner and returns its result', async () => {
    const bus = new CommandBus(db);
    const stop = new AbortController();
    const seen: string[] = [];
    const serving = bus.serve(
      async (req) => {
        seen.push(`${req.projectId}.${req.method}(${JSON.stringify(req.args)})`);
        return { ok: req.args[0] };
      },
      { signal: stop.signal, listen: listenWithPglite(db), pollMs: 50 },
    );
    await expect(bus.send('p', 'resolve', ['E-1', 'A'])).resolves.toEqual({ ok: 'E-1' });
    expect(seen).toEqual(['p.resolve(["E-1","A"])']);
    stop.abort();
    await serving;
  });

  it('passes a refusal back as the same CommandError', async () => {
    const bus = new CommandBus(db);
    const stop = new AbortController();
    const serving = bus.serve(
      async () => {
        throw new CommandError(409, 'already_resolved', 'E-1 is already resolved.');
      },
      { signal: stop.signal, pollMs: 20 },
    );
    const err = await bus.send('p', 'resolve', []).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandError);
    expect(err).toMatchObject({ status: 409, code: 'already_resolved' });
    stop.abort();
    await serving;
  });

  it('withdraws a command nobody picks up, so it never runs late', async () => {
    const bus = new CommandBus(db, { timeoutMs: 100 });
    const err = await bus.send('p', 'resolve', []).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 503, code: 'runner_unavailable' });

    const ran: string[] = [];
    const stop = new AbortController();
    const serving = bus.serve(async (req) => void ran.push(req.method), {
      signal: stop.signal,
      pollMs: 20,
    });
    await new Promise((r) => setTimeout(r, 150));
    stop.abort();
    await serving;
    expect(ran).toEqual([]);
  });
});
