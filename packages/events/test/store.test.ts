import type { NewEvent } from '@lw/contracts';
import { describe, expect, it } from 'vitest';
import { InMemoryEventStore, Projections } from '../src';

const status = (s: 'running' | 'paused'): NewEvent => ({
  type: 'project.status',
  actor: { kind: 'system', id: 't' },
  subject: { kind: 'project', id: 'p' },
  severity: 'routine',
  data: { status: s },
});

describe('InMemoryEventStore', () => {
  it('assigns gap-free seqs per project and reads both directions with bounds', async () => {
    const store = new InMemoryEventStore();
    await store.append('a', [status('running'), status('paused'), status('running')]);
    await store.append('b', [status('running')]);
    expect((await store.read('a')).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect((await store.read('b')).map((e) => e.seq)).toEqual([1]);
    expect((await store.read('a', { after: 1 })).map((e) => e.seq)).toEqual([2, 3]);
    expect((await store.read('a', { before: 3, order: 'desc' })).map((e) => e.seq)).toEqual([2, 1]);
    expect((await store.read('a', { order: 'desc', limit: 1 })).map((e) => e.seq)).toEqual([3]);
  });

  it('rejects an invalid batch without committing any of it', async () => {
    const store = new InMemoryEventStore();
    const bad = { ...status('running'), data: { status: 'exploded' } } as unknown as NewEvent;
    await expect(store.append('a', [status('running'), bad])).rejects.toThrow();
    expect(await store.head('a')).toBe(0);
  });
});

describe('Projections', () => {
  it('rebuilds from the log, then follows the live tail', async () => {
    const store = new InMemoryEventStore();
    await store.append('a', [status('running')]);
    const projections = new Projections(store);
    await projections.start();
    expect(projections.get('a')?.seq).toBe(1);
    await store.append('a', [status('paused')]);
    expect(projections.get('a')).toMatchObject({ seq: 2, status: 'paused' });
    projections.stop();
  });
});
