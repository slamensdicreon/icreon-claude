import { MemoryIntegrationStore } from '@lw/events';
import { expect, it } from 'vitest';
import type { OperatorNotice } from '../src/operator';
import { operatorEmail } from '../src/operator-email';
import { watchWorker } from '../src/watchdog';

const at = (iso: string) => new Date(iso);
const projects = (status: string) =>
  ({
    catchUpAll: async () => {},
    all: () => [
      { name: 'icreon', mode: 'live', status },
      { name: 'Ansell (demo)', mode: 'demo', status: 'running' },
    ],
  }) as never;

it('tells the Director once when the worker goes silent while a project runs, and once when it is back', async () => {
  const store = new MemoryIntegrationStore();
  const sent: OperatorNotice[] = [];
  let beat: string | null = '2026-11-04T10:00:00.000Z';
  const check = (now: string, status = 'running') =>
    watchWorker({
      lastBeat: async () => beat,
      projections: projects(status),
      store,
      notify: async (n) => void sent.push(n),
      now: () => at(now),
    });

  expect(await check('2026-11-04T10:05:00.000Z')).toEqual({
    state: 'ok',
    minutesSilent: 5,
    told: null,
  });
  expect(await check('2026-11-04T10:12:00.000Z')).toMatchObject({ state: 'down', told: 'down' });
  expect(sent[0]).toMatchObject({ kind: 'down', title: 'The agent worker has stopped' });
  expect(sent[0]!.body).toContain("hasn't been seen for 12 minutes, while icreon is running");
  // Told already: not again while it stays down.
  expect(await check('2026-11-04T10:30:00.000Z')).toMatchObject({ state: 'down', told: null });
  expect(sent).toHaveLength(1);

  beat = '2026-11-04T10:40:00.000Z';
  expect(await check('2026-11-04T10:41:00.000Z')).toMatchObject({ state: 'ok', told: 'up' });
  expect(sent[1]).toMatchObject({ kind: 'up', title: 'The agent worker is back' });
  expect(sent[1]!.body).toContain('after it went silent at 10:12 UTC');
  expect(await check('2026-11-04T10:42:00.000Z')).toMatchObject({ told: null });
  expect(sent).toHaveLength(2);

  // The email for it links to the Dashboard, branded as a down notice.
  const m = operatorEmail(sent[0]!, 'https://lw.example');
  expect(m.subject).toBe('Launchworks: The agent worker has stopped');
  expect(m.html).toContain('Worker down');
  expect(m.html).toContain('href="https://lw.example/"');
});

it('stays quiet while nothing runs, and retries a notice it could not send', async () => {
  const store = new MemoryIntegrationStore();
  const paused = await watchWorker({
    lastBeat: async () => null,
    projections: projects('paused'),
    store,
    notify: async () => {
      throw new Error('should not send');
    },
    now: () => at('2026-11-04T10:00:00.000Z'),
  });
  expect(paused).toEqual({ state: 'idle', minutesSilent: null, told: null });

  let attempts = 0;
  const flaky = () =>
    watchWorker({
      lastBeat: async () => '2026-11-04T09:00:00.000Z',
      projections: projects('running'),
      store,
      notify: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('Resend down');
      },
      now: () => at('2026-11-04T10:00:00.000Z'),
    });
  await expect(flaky()).rejects.toThrow('Resend down');
  expect(await flaky()).toMatchObject({ told: 'down' });
  expect(attempts).toBe(2);
});
