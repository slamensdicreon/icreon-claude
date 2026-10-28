import type { RunRequest } from '@lw/agent-runtime';
import { plan } from '@lw/domain';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { directorBot, launch, startHarness, stopHarness, until, type Harness } from './harness';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
}, 120_000);
afterAll(async () => {
  await stopHarness(h);
});

it('runs the first item of a batch alone, so a tool failure costs one card, and releases the rest after it', async () => {
  const seen: RunRequest[] = [];
  let denied = false;
  const runner = {
    async run(req: RunRequest) {
      seen.push(req);
      const spent = { tokens: 1_000, usd: 0.01 };
      if (req.task.taskId === 'migrate-pages-page-1' && !denied) {
        denied = true;
        return { kind: 'access_denied' as const, message: 'Sitecore refused the write.', spent };
      }
      return { kind: 'done' as const, summary: 'ok', metrics: {}, spent };
    },
  };
  const p = await launch(h, { runner });
  // Pages started while the canary's card was open: there should be none.
  let siblingsBeforeAnswer = -1;
  const bot = directorBot(p, (x) => {
    if (x.title.startsWith('Access denied')) {
      siblingsBeforeAnswer = seen.filter(
        (r) =>
          r.task.taskId.startsWith('migrate-pages-') && r.task.taskId !== 'migrate-pages-page-1',
      ).length;
    }
    return null;
  });
  await p.handle.result();
  await bot.stop();

  const s = p.state()!;
  const cards = Object.values(s.escalations).filter((x) => x.type === 'access');
  expect(cards).toHaveLength(1);
  expect(cards[0]!.title).toContain('Page 1');
  expect(siblingsBeforeAnswer).toBe(0);
  const pages = plan(s).tasks.filter((t) => t.taskId.startsWith('migrate-pages-'));
  expect(pages).toHaveLength(10);
  expect(pages.every((t) => t.state === 'done')).toBe(true);
}, 120_000);

it('parks a task whose tools fall short, without a card, holds its batch, and runs again once the capability is added', async () => {
  const seen: RunRequest[] = [];
  let added = false;
  const runner = {
    async run(req: RunRequest) {
      seen.push(req);
      const spent = { tokens: 1_000, usd: 0.01 };
      if (req.task.taskId === 'migrate-pages-page-1' && !added)
        return {
          kind: 'capability_gap' as const,
          summary: 'The page needs a personalization variant; no tool creates one.',
          capability: 'create personalization variants in Page builder',
          spent,
        };
      return { kind: 'done' as const, summary: 'ok', metrics: {}, spent };
    },
  };
  const p = await launch(h, { runner });
  const bot = directorBot(p);
  await until(() => p.state()?.capabilityGaps['create personalization variants in page builder']);
  // Its batch holds behind it, and nobody is asked.
  await until(() => p.state()!.tasks['migrate-pages-page-1']!.state === 'waiting');
  const pages = () => seen.filter((r) => r.task.taskId.startsWith('migrate-pages-'));
  expect(pages().map((r) => r.task.taskId)).toEqual(['migrate-pages-page-1']);
  expect(
    Object.values(p.state()!.escalations).some((x) => x.sourceTaskId === 'migrate-pages-page-1'),
  ).toBe(false);

  // Engineering adds it: the task runs again, told so, and the batch follows.
  added = true;
  await p.commands.rerunTask(
    'migrate-pages-page-1',
    'The capability you lacked is now available: create personalization variants in Page builder.',
  );
  await p.handle.result();
  await bot.stop();

  const s = p.state()!;
  expect(
    seen.filter((r) => r.task.taskId === 'migrate-pages-page-1').at(-1)!.instructions,
  ).toContain('now available');
  expect(s.capabilityGaps['create personalization variants in page builder']).toMatchObject({
    tasks: {},
    closedAt: expect.any(String),
  });
  expect(
    plan(s)
      .tasks.filter((t) => t.taskId.startsWith('migrate-pages-'))
      .every((t) => t.state === 'done'),
  ).toBe(true);
}, 120_000);
