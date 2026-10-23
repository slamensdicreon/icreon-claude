import { InMemoryEventStore, Projections } from '@lw/events';
import { afterEach, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import type { ProjectCommands } from '../src/commands';

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

it('passes the Director’s details with the chosen option to the orchestrator', async () => {
  const store = new InMemoryEventStore();
  const projections = new Projections(store);
  await projections.start();
  const calls: unknown[][] = [];
  const commands = {
    resolve: async (...args: unknown[]) => void calls.push(args),
  } as unknown as ProjectCommands;
  app = await buildApp({ store, projections, commands: () => commands });
  const resolve = (payload: object) =>
    app!.inject({ method: 'POST', url: '/projects/p/escalations/e1/resolve', payload });

  expect((await resolve({ optionId: 'opt-1', notes: '  https://anscollc.com/ ' })).statusCode).toBe(
    200,
  );
  expect((await resolve({ optionId: 'opt-2' })).statusCode).toBe(200);
  expect((await resolve({ optionId: 'opt-3', notes: '   ' })).statusCode).toBe(200);
  expect(calls).toEqual([
    ['e1', 'opt-1', 'https://anscollc.com/'],
    ['e1', 'opt-2', null],
    ['e1', 'opt-3', null],
  ]);
});
