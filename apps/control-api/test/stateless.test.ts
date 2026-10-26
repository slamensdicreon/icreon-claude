import type { NewEvent } from '@lw/contracts';
import { InMemoryEventStore, Projections } from '@lw/events';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';

/**
 * The API as it runs on a request-driven platform: no live tail from the store (another process
 * writes the log), projections folded on demand, streams that poll and end on schedule.
 */

const status = (s: 'running' | 'paused'): NewEvent => ({
  type: 'project.status',
  actor: { kind: 'system', id: 't' },
  subject: { kind: 'project', id: 'p' },
  severity: 'routine',
  data: { status: s },
});

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function start() {
  // The writer's store; the API sees the same log through a view with no live tail.
  const store = new InMemoryEventStore();
  const view = Object.create(store) as InMemoryEventStore;
  view.subscribe = () => () => {};
  const projections = new Projections(view);
  await projections.start({ eager: false });
  app = await buildApp({
    store: view,
    projections,
    commands: () => undefined,
    corsOrigin: '*',
    stream: { pollMs: 30, maxMs: 400 },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  return { store, base };
}

/** Reads raw SSE frames until the server ends the stream (or `ms` passes). */
async function frames(url: string, ms = 2_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const out: { event: string; id?: string; data?: string }[] = [];
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const lines = buf.slice(0, i).split('\n');
        buf = buf.slice(i + 2);
        const field = (k: string) => lines.find((l) => l.startsWith(`${k}: `))?.slice(k.length + 2);
        const event = field('event');
        if (event) out.push({ event, id: field('id'), data: field('data') });
      }
    }
  } catch (err) {
    if (!ctrl.signal.aborted) throw err;
  } finally {
    clearTimeout(timer);
  }
  return out;
}

describe('control-api on paused, short-lived instances', () => {
  it('lists and serves projects written by another process', async () => {
    const { store, base } = await start();
    expect(await (await fetch(`${base}/projects`)).json()).toEqual([]);
    await store.append('p', [status('running'), status('paused')]);
    const list = (await (await fetch(`${base}/projects`)).json()) as { id: string }[];
    expect(list.map((p) => p.id)).toEqual(['p']);
    const mc = (await (await fetch(`${base}/projects/p/mission-control`)).json()) as {
      seq: number;
    };
    expect(mc.seq).toBe(2);
  });

  it('streams by reading the log, then ends with bye on schedule', async () => {
    const { store, base } = await start();
    await store.append('p', [status('running')]);
    setTimeout(() => void store.append('p', [status('paused'), status('running')]), 100);
    const got = await frames(`${base}/projects/p/stream?after=0`);
    expect(got.filter((f) => f.event === 'lw').map((f) => f.id)).toEqual(['1', '2', '3']);
    expect(got.at(-1)?.event).toBe('bye');
  });

  it('tells an open stream to reset when the log is rewritten to the same length', async () => {
    const { store, base } = await start();
    await store.append('p', [status('running'), status('paused')]);
    setTimeout(() => {
      void (async () => {
        await store.reset('p');
        await store.append('p', [status('paused'), status('running')]);
      })();
    }, 100);
    const got = await frames(`${base}/projects/p/stream?after=2`);
    expect(got).toEqual([{ event: 'reset', data: JSON.stringify({ head: 2 }) }]);
  });

  it('tells a client ahead of a reseeded log to reset', async () => {
    const { store, base } = await start();
    await store.append('p', [status('running'), status('paused'), status('running')]);
    await store.reset('p');
    await store.append('p', [status('paused')]);
    const got = await frames(`${base}/projects/p/stream?after=3`);
    expect(got).toEqual([{ event: 'reset', data: JSON.stringify({ head: 1 }) }]);
  });
});
