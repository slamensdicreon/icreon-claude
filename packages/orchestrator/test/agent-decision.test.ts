import type { RunRequest } from '@lw/agent-runtime';
import { plan } from '@lw/domain';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { directorBot, launch, startHarness, stopHarness, type Harness } from './harness';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
}, 120_000);
afterAll(async () => {
  await stopHarness(h);
});

it('turns an agent’s decision flag into a Director card and carries the answer into the retry', async () => {
  const seen: RunRequest[] = [];
  const runner = {
    async run(req: RunRequest) {
      seen.push(req);
      const spent = { tokens: 10_000, usd: 0.05 };
      if (req.task.taskId === 'port-hero' && !req.instructions) {
        return {
          kind: 'needs_decision' as const,
          summary: 'The source Hero has five layouts driven by props.',
          decision: {
            question: 'Hero: one rendering with variants, or five renderings?',
            options: ['One rendering with variants', 'Five renderings'],
            recommended: 'One rendering with variants',
          },
          spent,
        };
      }
      return { kind: 'done' as const, summary: 'ok', metrics: {}, spent };
    },
  };
  const p = await launch(h, { runner });
  const bot = directorBot(p, (x) => (x.title.startsWith('Hero:') ? { optionId: 'opt-2' } : null));
  await p.handle.result();
  await bot.stop();

  const s = p.state()!;
  const card = Object.values(s.escalations).find((x) => x.title.startsWith('Hero:'))!;
  expect(card).toMatchObject({
    type: 'decision',
    title: 'Hero: one rendering with variants, or five renderings?',
    context: 'Component Engineer: The source Hero has five layouts driven by props.',
    defaultOptionId: 'opt-1',
    options: [
      { id: 'opt-1', label: 'One rendering with variants', recommended: true },
      { id: 'opt-2', label: 'Five renderings', recommended: false },
    ],
    resolution: { optionId: 'opt-2', by: 'director' },
  });
  const retry = seen.filter((r) => r.task.taskId === 'port-hero').at(-1)!;
  expect(retry.instructions).toBe(
    'Decision on "Hero: one rendering with variants, or five renderings?": Five renderings.',
  );
  expect(plan(s).tasks.find((t) => t.taskId === 'port-hero')!.state).toBe('done');
  // Both Hero sessions are counted, including the one that stopped for the decision.
  expect(s.spent.tokens).toBe(seen.length * 10_000);
}, 120_000);
