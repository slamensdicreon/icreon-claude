import type { RunRequest } from '@lw/agent-runtime';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ValidationResult } from '../src';
import { directorBot, launch, startHarness, stopHarness, until, type Harness } from './harness';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
}, 120_000);
afterAll(async () => {
  await stopHarness(h);
});

const PAGE = 'migrate-pages-page-1';

/**
 * Microsoft's 404 page failed on a cause no retry could change, and its card defaulted to a retry
 * every hour overnight. Once a card has retried by default, the next one for that task waits for
 * the Director, recommends accepting, and offers to hold the task.
 */
it('waits for the Director once a rejected task fails again after a default retry', async () => {
  const runs: RunRequest[] = [];
  const runner = {
    async run(req: RunRequest) {
      runs.push(req);
      return { kind: 'done' as const, summary: 'ok', metrics: {}, spent: { tokens: 1, usd: 0 } };
    },
  };
  const validate = async (req: { task: { taskId: string } }): Promise<ValidationResult> =>
    req.task.taskId === PAGE
      ? {
          pass: false,
          reason: 'parity.visual: the page has no header.',
          checks: [{ id: 'parity.visual', status: 'fail' }],
        }
      : { pass: true, reason: null };
  const p = await launch(h, {
    runner,
    validate,
    policy: { escalationDeadlinesMs: { decision: 300 } },
  });
  const cards = () =>
    Object.values(p.state()?.escalations ?? {}).filter((x) => x.sourceTaskId === PAGE);
  // The first card is left to its default; the second is answered by the test.
  const bot = directorBot(p, (x) => (x.sourceTaskId === PAGE ? 'leave' : null));
  const first = await until(() => cards()[0], 60_000);
  expect(first.defaultOptionId).toBe('retry');
  expect(first.options.map((o) => o.id)).toEqual(['retry', 'accept', 'waive', 'hold']);
  const second = await until(() => cards()[1], 60_000);
  expect(second.defaultOptionId).toBeNull();
  expect(second.options.find((o) => o.recommended)?.id).toBe('accept');
  expect(second.context).toContain('retried it by default');
  // Nothing defaults it: it stays open well past the window that expired the first.
  await new Promise((r) => setTimeout(r, 1_200));
  expect(cards()).toHaveLength(2);
  expect(p.state()!.escalations[second.escalationId]!.status).toBe('open');
  // Hold parks it: no retry and no further card.
  const ran = runs.filter((r) => r.task.taskId === PAGE).length;
  await p.commands.resolve(second.escalationId, 'hold', 'Waits on the head route', undefined);
  await new Promise((r) => setTimeout(r, 1_200));
  expect(cards()).toHaveLength(2);
  expect(runs.filter((r) => r.task.taskId === PAGE)).toHaveLength(ran);
  expect(p.state()!.tasks[PAGE]!.state).toBe('blocked');
  // Run again from the plan, it goes back through the same checks.
  await p.commands.rerunTask(PAGE, '');
  await until(() => runs.filter((r) => r.task.taskId === PAGE).length > ran, 60_000);
  await bot.stop();
  await p.handle.terminate();
}, 180_000);

/**
 * Ervin Cable's SEO titles raised three cards for one decision, each answered "retry". The same
 * failing checks again make the next card the same decision: it waits for the Director and offers
 * to waive those checks for the task, which re-checks it without them and without its agent.
 */
it('makes the same failure a card that waits, and waives its checks for the task', async () => {
  const runs: RunRequest[] = [];
  const runner = {
    async run(req: RunRequest) {
      runs.push(req);
      return { kind: 'done' as const, summary: 'ok', metrics: {}, spent: { tokens: 1, usd: 0 } };
    },
  };
  let projectId = '';
  const waived = async () =>
    (await h.store.read(projectId)).some(
      (e) => e.type === 'decision.recorded' && e.data.scopeKey === `waiver:${PAGE}:seo.titles`,
    );
  const validate = async (req: { task: { taskId: string } }): Promise<ValidationResult> =>
    req.task.taskId === PAGE && !(await waived())
      ? {
          pass: false,
          reason: 'seo.titles: the head renders the site name.',
          checks: [
            { id: 'seo.titles', status: 'fail' },
            { id: 'parity.render', status: 'pass' },
          ],
        }
      : { pass: true, reason: null };
  const p = await launch(h, { runner, validate });
  projectId = p.projectId;
  const cards = () =>
    Object.values(p.state()?.escalations ?? {}).filter((x) => x.sourceTaskId === PAGE);
  // The first card is answered "retry" by the Director; the second is left to the test.
  const bot = directorBot(p, (x) =>
    x.sourceTaskId === PAGE ? (cards().length === 1 ? { optionId: 'retry' } : 'leave') : null,
  );
  const first = await until(() => cards()[0], 60_000);
  expect(first.defaultOptionId).toBe('retry');
  expect(first.options.map((o) => o.id)).toEqual(['retry', 'accept', 'waive', 'hold']);
  const second = await until(() => cards()[1], 60_000);
  expect(second.defaultOptionId).toBeNull();
  expect(second.options.find((o) => o.recommended)?.id).toBe('accept');
  expect(second.context).toContain('same checks as its last card (seo.titles)');
  const ran = runs.filter((r) => r.task.taskId === PAGE).length;
  await p.commands.resolve(second.escalationId, 'waive', 'The head owns the title', undefined);
  await until(() => p.state()?.tasks[PAGE]?.state === 'done', 60_000);
  // Checked again without its agent.
  expect(runs.filter((r) => r.task.taskId === PAGE)).toHaveLength(ran);
  expect(await waived()).toBe(true);
  await bot.stop();
  await p.handle.terminate();
}, 180_000);
