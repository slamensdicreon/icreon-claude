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

/**
 * Paylocity's Director asked for the footer to be filled by one task: the note was acknowledged
 * and nothing happened, because agents can't create tasks. A note asking for new work now adds a
 * task for the role named, which runs with the Director's words as its instructions.
 */
it('adds a task the Director asks for, and runs it with their words', async () => {
  const runs: RunRequest[] = [];
  const runner = {
    async run(req: RunRequest) {
      runs.push(req);
      return { kind: 'done' as const, summary: 'ok', metrics: {}, spent: { tokens: 1, usd: 0 } };
    },
  };
  const p = await launch(h, { runner });
  const bot = directorBot(p, () => null);
  await until(() => Object.keys(p.state()?.tasks ?? {}).length > 0, 60_000);
  await p.commands.postMessage(
    'Add a task for content-migrator: Fill the shared footer from the source',
  );
  const added = await until(
    () => plan(p.state()!).tasks.find((t) => t.taskId.startsWith('requested-')),
    60_000,
  );
  expect(added).toMatchObject({
    role: 'content-migrator',
    title: 'Fill the shared footer from the source',
  });
  const ack = p.state()!.conversation.findLast((m) => m.kind === 'directive_ack')!;
  expect(ack.body).toContain(
    'Added a task for Content Migrator: Fill the shared footer from the source',
  );
  const run = await until(() => runs.find((r) => r.task.taskId === added.taskId), 60_000);
  expect(run.instructions).toContain('The Director asked for this: Fill the shared footer');
  await until(
    () => plan(p.state()!).tasks.find((t) => t.taskId === added.taskId)?.state === 'done',
    60_000,
  );
  await bot.stop();
  await p.handle.terminate();
}, 180_000);
