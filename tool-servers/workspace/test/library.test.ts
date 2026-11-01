import { InMemoryEventStore } from '@lw/events';
import { MemoryBlobStore } from '@lw/tool-gateway';
import { describe, expect, it } from 'vitest';
import { ArtifactLibrary } from '../src';

const doc = (artifactId: string, content: string) => ({
  artifactId,
  kind: 'inventory' as const,
  title: artifactId,
  format: 'json' as const,
  content,
  producer: 'content-analyst',
});

/** Other activity on the log between documents, as a live project has. */
const noise = (store: InMemoryEventStore, n: number) =>
  store.append(
    'p1',
    Array.from({ length: n }, () => ({
      type: 'project.status' as const,
      actor: { kind: 'system' as const, id: 'sys' },
      subject: { kind: 'project' as const, id: 'p1' },
      severity: 'routine' as const,
      data: { status: 'running' as const },
    })),
  );

describe('artifact library index', () => {
  it('reads only what the log added since its last answer, and answers as fresh as a full read', async () => {
    const store = new InMemoryEventStore();
    const reads: (number | undefined)[] = [];
    const read = store.read.bind(store);
    store.read = (id, opts) => (reads.push(opts?.after), read(id, opts));
    const lib = new ArtifactLibrary(store, new MemoryBlobStore());
    await lib.write('p1', doc('page-inventory', '{"v":1}'));
    await noise(store, 50);
    await lib.write('p1', doc('page-inventory', '{"v":2}'));
    await lib.write('p1', doc('blueprint-notes', '{}'));
    expect((await lib.versions('p1', 'page-inventory')).map((v) => v.version)).toEqual([1, 2]);
    expect(await lib.read('p1', 'page-inventory')).toMatchObject({ content: '{"v":2}' });
    expect(await lib.read('p1', 'page-inventory', 1)).toMatchObject({ content: '{"v":1}' });
    // A version written by another process (straight to the log) is seen on the next call.
    await store.append('p1', [
      {
        type: 'artifact.versioned',
        actor: { kind: 'agent', id: 'x' },
        subject: { kind: 'artifact', id: 'page-inventory' },
        severity: 'notable',
        data: {
          artifactId: 'page-inventory',
          kind: 'inventory',
          title: 'page-inventory',
          version: 3,
          ref: null,
          format: 'json',
        },
      },
    ]);
    expect((await lib.latest('p1', 'page-inventory'))?.version).toBe(3);
    // The first call read the log from the start; every later one only past what it had.
    expect(reads[0]).toBe(0);
    expect(reads.slice(1).every((after) => (after ?? 0) > 0)).toBe(true);
    // Callers get copies: changing one can't change the index.
    (await lib.versions('p1', 'page-inventory'))[0]!.title = 'changed';
    expect((await lib.versions('p1', 'page-inventory'))[0]!.title).toBe('page-inventory');
  });

  it('starts over when the log is reset and written again, longer or shorter', async () => {
    const store = new InMemoryEventStore();
    const lib = new ArtifactLibrary(store, new MemoryBlobStore());
    await lib.write('p1', doc('page-inventory', 'a'));
    await lib.write('p1', doc('page-inventory', 'b'));
    expect((await lib.versions('p1', 'page-inventory')).length).toBe(2);
    await store.reset('p1');
    await noise(store, 5);
    await lib.write('p1', doc('blueprint-notes', 'c'));
    expect(await lib.versions('p1', 'page-inventory')).toEqual([]);
    expect((await lib.versions('p1', 'blueprint-notes')).length).toBe(1);
  });

  it('gives concurrent callers one consistent index', async () => {
    const store = new InMemoryEventStore();
    const lib = new ArtifactLibrary(store, new MemoryBlobStore());
    for (let i = 0; i < 5; i++) await lib.write('p1', doc('page-inventory', String(i)));
    const all = await Promise.all(
      Array.from({ length: 20 }, () => lib.versions('p1', 'page-inventory')),
    );
    for (const v of all) expect(v.map((x) => x.version)).toEqual([1, 2, 3, 4, 5]);
  });
});
