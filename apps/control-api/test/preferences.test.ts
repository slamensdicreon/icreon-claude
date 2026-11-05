import { createHash } from 'node:crypto';
import { InMemoryEventStore, MemoryIntegrationStore, Projections } from '@lw/events';
import type { FastifyInstance } from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { buildApp } from '../src/app';

const KEY_A = `lwk_${'a'.repeat(40)}`;
const KEY_B = `lwk_${'b'.repeat(40)}`;
const sha = (k: string) => createHash('sha256').update(k).digest('hex');

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function start(opts: { auth?: boolean; preferences?: MemoryIntegrationStore } = {}) {
  const store = new InMemoryEventStore();
  const projections = new Projections(store);
  await projections.start();
  app = await buildApp({
    store,
    projections,
    commands: () => undefined,
    preferences: opts.preferences ?? null,
    ...(opts.auth
      ? {
          auth: {
            clientId: 'c',
            clientSecret: 's',
            publicUrl: 'https://api.example',
            appUrl: 'https://app.example',
            operators: ['ana', 'ben'],
            apiKeys: [
              { login: 'ana', sha256: sha(KEY_A) },
              { login: 'ben', sha256: sha(KEY_B) },
            ],
            sessionSecret: 'x'.repeat(40),
            secureCookies: true,
          },
        }
      : {}),
  });
  return app;
}

const call = (a: FastifyInstance, method: 'GET' | 'PUT', key?: string, body?: unknown) =>
  a.inject({
    method,
    url: '/me/preferences',
    headers: key ? { authorization: `Bearer ${key}` } : {},
    ...(body === undefined ? {} : { payload: body as object }),
  });

it('remembers the mode per screen for a local run, with no store', async () => {
  const a = await start();
  expect((await call(a, 'GET')).json()).toEqual({ mode: {} });
  const put = await call(a, 'PUT', undefined, { mode: { dashboard: 'everything', plan: 'bliss' } });
  expect(put.statusCode).toBe(200);
  expect((await call(a, 'GET')).json()).toEqual({
    mode: { dashboard: 'everything', plan: 'bliss' },
  });
});

it('keeps each operator’s own, in the integrations store, and refuses what isn’t a mode', async () => {
  const prefs = new MemoryIntegrationStore();
  const a = await start({ auth: true, preferences: prefs });
  expect((await call(a, 'GET')).statusCode).toBe(401);
  await call(a, 'PUT', KEY_A, { mode: { mission: 'everything' } });
  await call(a, 'PUT', KEY_B, { mode: { mission: 'bliss' } });
  expect((await call(a, 'GET', KEY_A)).json()).toEqual({ mode: { mission: 'everything' } });
  expect((await call(a, 'GET', KEY_B)).json()).toEqual({ mode: { mission: 'bliss' } });
  expect(await prefs.get('prefs:ana')).toEqual({ mode: { mission: 'everything' } });

  const bad = await call(a, 'PUT', KEY_A, { mode: { mission: 'loud' } });
  expect(bad.statusCode).toBe(400);
  expect((await call(a, 'GET', KEY_A)).json()).toEqual({ mode: { mission: 'everything' } });
});
