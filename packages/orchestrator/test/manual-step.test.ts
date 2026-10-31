import type { RunRequest } from '@lw/agent-runtime';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { directorBot, launch, startHarness, stopHarness, type Harness } from './harness';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
}, 120_000);
afterAll(async () => {
  await stopHarness(h);
});

it('asks the Director to do a by-hand step with its checklist, runs no agent for it, and goes on once it is marked done', async () => {
  const runs: string[] = [];
  const runner = {
    async run(req: RunRequest) {
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
  await p.handle.result();
  await bot.stop();
  const s = p.state()!;

  for (const id of ['prove-pilot-slice', 'smoke-test']) {
    // No agent ran it: the Director did.
    expect(runs).not.toContain(id);
    expect(s.tasks[id]!.state).toBe('done');
    const card = Object.values(s.escalations).find((x) => x.sourceTaskId === id)!;
    expect(card.title).toMatch(/^By hand: /);
    expect(card.context).toMatch(/Page builder/);
    expect(card.options.map((o) => o.id)).toEqual(['accept']);
    expect(card.resolution).toMatchObject({ optionId: 'accept', by: 'director' });
  }
  // What waited on the pilot proof ran after it.
  expect(runs).toContain('migrate-pages-page-1');
}, 180_000);
