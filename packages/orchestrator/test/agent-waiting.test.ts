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

it('parks a task waiting on another, restarts it when that finishes, and asks only when no task can end the wait', async () => {
  const seen: RunRequest[] = [];
  const runner = {
    async run(req: RunRequest) {
      seen.push(req);
      const spent = { tokens: 1_000, usd: 0.01 };
      if (req.task.taskId === 'port-hero' && !req.instructions)
        return {
          kind: 'waiting' as const,
          summary: 'Hero composes Promo Card, which is not built yet.',
          waitingOn: { taskIds: ['port-promo-card'], what: 'the Promo Card component' },
          spent,
        };
      if (req.task.taskId === 'port-tabs' && !req.instructions)
        return {
          kind: 'waiting' as const,
          summary: 'The variants folder is missing.',
          waitingOn: { taskIds: ['make-variants'], what: 'Tabs variants' },
          spent,
        };
      return { kind: 'done' as const, summary: 'ok', metrics: {}, spent };
    },
  };
  const p = await launch(h, { runner });
  const bot = directorBot(p, (x) =>
    x.title.startsWith('Port Tabs') ? { optionId: 'opt-1' } : null,
  );
  await p.handle.result();
  await bot.stop();

  const s = p.state()!;
  // The wait another task ends needs no one: no card, and the retry says what finished.
  expect(Object.values(s.escalations).some((x) => x.title.startsWith('Port Hero'))).toBe(false);
  const hero = seen.filter((r) => r.task.taskId === 'port-hero');
  expect(hero).toHaveLength(2);
  expect(hero[1]!.instructions).toContain('What you waited for (the Promo Card component)');
  const moves = (await h.store.read(p.projectId))
    .filter((e) => e.type === 'task.state' && e.subject.id === 'port-hero')
    .map((e) => (e.data as { to: string }).to);
  expect(moves).toContain('waiting');

  // A wait on a task that doesn't exist comes to the Director.
  const card = Object.values(s.escalations).find((x) => x.title.startsWith('Port Tabs'))!;
  expect(card).toMatchObject({
    type: 'decision',
    title: 'Port Tabs to Content SDK: what it needs is missing',
    resolution: { optionId: 'opt-1', by: 'director' },
  });
  expect(card.context).toContain('it named no task in the plan that makes it (make-variants)');
  expect(plan(s).tasks.every((t) => t.state === 'done' || t.kind !== 'work')).toBe(true);
}, 120_000);
