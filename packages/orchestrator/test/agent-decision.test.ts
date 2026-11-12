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

it('re-runs a task stuck on a decision: its card is withdrawn and it runs with the new instructions', async () => {
  const seen: RunRequest[] = [];
  const runner = {
    async run(req: RunRequest) {
      seen.push(req);
      const spent = { tokens: 1_000, usd: 0.01 };
      if (req.task.taskId === 'port-hero' && !req.instructions)
        return {
          kind: 'needs_decision' as const,
          summary: 'The push was refused.',
          decision: {
            question: 'How to proceed?',
            options: ['Retry', 'Stop'],
            recommended: 'Retry',
          },
          spent,
        };
      return { kind: 'done' as const, summary: 'ok', metrics: {}, spent };
    },
  };
  const p = await launch(h, { runner });
  // Gates are approved; the Hero card is left for the re-run to settle.
  const bot = directorBot(p, (x) => (x.title === 'How to proceed?' ? 'leave' : null));
  const card = await until(
    () => Object.values(p.state()?.escalations ?? {}).find((x) => x.title === 'How to proceed?'),
    60_000,
  );
  await p.commands.rerunTask('port-hero', 'Integrate again, not fresh');
  await p.handle.result();
  await bot.stop();

  const s = p.state()!;
  expect(s.escalations[card.escalationId]!.status).toBe('superseded');
  expect(seen.filter((r) => r.task.taskId === 'port-hero').at(-1)!.instructions).toBe(
    'Integrate again, not fresh',
  );
  expect(plan(s).tasks.find((t) => t.taskId === 'port-hero')!.state).toBe('done');
  expect(s.decisions.some((d) => d.question === 'Re-run Port Hero to Content SDK')).toBe(true);
}, 120_000);

/**
 * Liberty Mutual's inventory stopped five times in four minutes on "the site refuses our
 * browser", each answer a wait that could never end. A task that stops on a question again right
 * after an answer gets a card that waits for the Director: no default, no Lead, and a way to hold it.
 */
it('makes a question asked again in a row wait for the Director, and holds the task on request', async () => {
  const seen: RunRequest[] = [];
  const runner = {
    async run(req: RunRequest) {
      seen.push(req);
      const spent = { tokens: 1, usd: 0 };
      if (req.task.taskId === 'port-hero')
        return {
          kind: 'needs_decision' as const,
          summary: 'The source site refuses our browser.',
          decision: {
            question: 'Site refuses our browser: how to go on?',
            options: ['Wait for the allowlist', 'Use another site'],
            recommended: 'Wait for the allowlist',
          },
          spent,
        };
      return { kind: 'done' as const, summary: 'ok', metrics: {}, spent };
    },
  };
  const p = await launch(h, { runner });
  const cards = () =>
    Object.values(p.state()?.escalations ?? {})
      .filter((x) => x.sourceTaskId === 'port-hero')
      .sort((a, b) => a.raisedAt.localeCompare(b.raisedAt));
  // The first card is answered the way that sends it straight back; the second is the test's.
  const bot = directorBot(p, (x) =>
    x.sourceTaskId === 'port-hero'
      ? cards().length === 1
        ? { optionId: 'opt-1' }
        : 'leave'
      : null,
  );
  const first = await until(() => cards()[0], 60_000);
  expect(first.defaultOptionId).toBe('opt-1');
  expect(first.options.map((o) => o.id)).toEqual(['opt-1', 'opt-2']);
  const second = await until(() => cards()[1], 60_000);
  expect(second.defaultOptionId).toBeNull();
  expect(second.context).toContain('has stopped on a question 2 times in a row');
  expect(second.options.map((o) => o.id)).toEqual(['opt-1', 'opt-2', 'hold']);
  const ran = seen.filter((r) => r.task.taskId === 'port-hero').length;
  await p.commands.resolve(second.escalationId, 'hold', null, undefined);
  await new Promise((r) => setTimeout(r, 1_200));
  expect(cards()).toHaveLength(2);
  expect(seen.filter((r) => r.task.taskId === 'port-hero')).toHaveLength(ran);
  expect(p.state()!.tasks['port-hero']!.state).toBe('blocked');
  await bot.stop();
  await p.handle.terminate();
}, 180_000);
