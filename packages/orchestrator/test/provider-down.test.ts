import type { RunRequest } from '@lw/agent-runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { providerOutage } from '../src';
import { directorBot, launch, startHarness, stopHarness, type Harness } from './harness';

const CREDIT =
  '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}';

describe('providerOutage', () => {
  it('names refusals that last until someone acts, and lets passing ones retry', () => {
    expect(providerOutage(Object.assign(new Error(CREDIT), { status: 400 }))).toContain(
      'credit balance is too low',
    );
    expect(providerOutage({ status: 401, message: 'invalid x-api-key' })).toContain('API key');
    expect(providerOutage({ status: 429, message: 'rate_limit_error' })).toBeNull();
    expect(providerOutage({ status: 529, message: 'overloaded_error' })).toBeNull();
    expect(providerOutage(new Error('socket hang up'))).toBeNull();
  });
});

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
}, 120_000);
afterAll(async () => {
  await stopHarness(h);
});

it('pauses the project once when the provider refuses calls, and spends no attempt or card', async () => {
  let down = true;
  const runs: string[] = [];
  const runner = {
    async run(req: RunRequest) {
      if (down && req.task.taskId === 'port-hero')
        throw Object.assign(new Error(CREDIT), { status: 400 });
      runs.push(req.task.taskId);
      return {
        kind: 'done' as const,
        summary: 'ok',
        metrics: {},
        spent: { tokens: 1_000, usd: 0.01 },
      };
    },
  };
  const p = await launch(h, { runner });
  const bot = directorBot(p, () => null);
  // The project pauses itself when Hero's agent can't reach the provider.
  for (let i = 0; i < 600 && p.state()?.status !== 'paused'; i++)
    await new Promise((r) => setTimeout(r, 100));
  const paused = p.state()!;
  expect(paused.status).toBe('paused');
  expect(paused.tasks['port-hero']!.state).toBe('ready');
  const heroCards = (x: { title: string }) => x.title.includes('Hero');
  expect(Object.values(paused.escalations).filter(heroCards)).toEqual([]);
  const events = await h.store.read(p.projectId);
  const told = events.filter(
    (e) => e.type === 'cos.message' && JSON.stringify(e.data).includes("can't reach the model"),
  );
  expect(told).toHaveLength(1);

  // Credit restored, the Director resumes: Hero runs and the project finishes.
  down = false;
  await p.commands.control({ verb: 'resume', scope: { kind: 'project', id: p.projectId } });
  await p.handle.result();
  await bot.stop();
  const s = p.state()!;
  expect(s.tasks['port-hero']!.state).toBe('done');
  expect(s.tasks['port-hero']!.attempt).toBe(1);
  expect(runs).toContain('port-hero');
  expect(Object.values(s.escalations).filter(heroCards)).toEqual([]);
}, 180_000);
