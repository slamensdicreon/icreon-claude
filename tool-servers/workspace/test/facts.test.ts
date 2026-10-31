import type { FactDraft, FactView } from '@lw/contracts';
import { describe, expect, it } from 'vitest';
import { AcceptanceToolServer, FactsToolServer } from '../src';

const ctx = { projectId: 'p1', token: 't', role: 'content-migrator', taskId: 'page-home' };
const view = (kind: string, key: string, at: string, value = {}): FactView => ({
  kind,
  key,
  value,
  summary: `${kind} ${key}`,
  taskId: 't0',
  by: 'rendering-registrar',
  source: 'tool',
  at,
  version: 1,
  previous: null,
});

describe('facts', () => {
  const facts = [
    view('rendering', 'Hero Banner', '2026-10-01T10:00:00Z', {
      id: 'r1',
      componentName: 'HeroBanner',
    }),
    view('rendering', 'Card Grid', '2026-10-01T11:00:00Z', { id: 'r2' }),
    view('page', '/about-us', '2026-10-01T12:00:00Z', { id: 'p1' }),
  ];
  const published: FactDraft[] = [];
  const s = new FactsToolServer({
    facts: async () => facts,
    publish: async (_p, f) => {
      published.push(f);
    },
  });

  it('finds facts by kind, by key whatever its case, and by search, newest first', async () => {
    const byKind = await s.call('read', { kind: 'rendering' }, ctx);
    expect((byKind.body as { facts: FactView[] }).facts.map((f) => f.key)).toEqual([
      'Card Grid',
      'Hero Banner',
    ]);
    const byKey = await s.call('read', { kind: 'rendering', key: 'hero banner' }, ctx);
    expect(byKey.body).toMatchObject({ total: 1, facts: [{ value: { id: 'r1' } }] });
    const bySearch = await s.call('read', { search: 'herobanner' }, ctx);
    expect(bySearch.body).toMatchObject({ total: 1 });
    const capped = await s.call('read', { limit: 1 }, ctx);
    expect(capped.body).toMatchObject({ total: 3, more: '2 more; narrow the search' });
  });

  it("publishes an agent's fact, and refuses one that isn't valid", async () => {
    const ok = await s.call(
      'publish',
      { kind: 'query', key: 'HeroBanner', value: { name: 'HeroBannerQuery' } },
      ctx,
    );
    expect(ok.code).toBe(200);
    expect(published).toEqual([
      { kind: 'query', key: 'HeroBanner', value: { name: 'HeroBannerQuery' }, summary: '' },
    ]);
    const bad = await s.call('publish', { kind: 'Query Name', key: 'x', value: {} }, ctx);
    expect(bad.code).toBe(422);
    const nested = await s.call('publish', { kind: 'q', key: 'x', value: { a: { b: 1 } } }, ctx);
    expect(nested.code).toBe(422);
  });
});

describe('acceptance', () => {
  it("reports the task's checks, and says when it isn't running here", async () => {
    const s = new AcceptanceToolServer(async (_p, taskId) =>
      taskId === 'page-home'
        ? [
            { id: 'parity.page', status: 'fail', detail: 'The hero is missing.' },
            { id: 'content.fields-filled', status: 'pass', detail: 'All filled.' },
          ]
        : null,
    );
    const r = await s.call('check', {}, ctx);
    expect(r).toMatchObject({ code: 200, body: { passed: false } });
    expect(r.summary).toBe('1 of 2 checks fail: parity.page');
    expect((await s.call('check', {}, { ...ctx, taskId: 'other' })).code).toBe(404);
  });
});
