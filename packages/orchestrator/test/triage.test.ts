import type { RunRequest } from '@lw/agent-runtime';
import { plan } from '@lw/domain';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { TriageOutcome, TriageRequest } from '../src/types';
import { directorBot, launch, startHarness, stopHarness, type Harness } from './harness';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
}, 120_000);
afterAll(async () => {
  await stopHarness(h);
});

const spent = { tokens: 1_000, usd: 0.01 };
const HERO_Q = 'Hero: one rendering with variants, or five renderings?';

/** The Hero port stops with a question its first `asks` times, then finishes. */
function heroAsks(asks: number, seen: RunRequest[] = []) {
  let n = 0;
  return {
    async run(req: RunRequest) {
      seen.push(req);
      if (req.task.taskId === 'port-hero' && n++ < asks)
        return {
          kind: 'needs_decision' as const,
          summary: 'The source Hero has five layouts driven by props.',
          decision: {
            question: HERO_Q,
            options: ['One rendering with variants', 'Five renderings'],
            recommended: 'One rendering with variants',
          },
          spent,
        };
      return { kind: 'done' as const, summary: 'ok', metrics: {}, spent };
    },
  };
}

const lead =
  (
    level: 'lead' | 'shadow',
    optionId = 'opt-1',
  ): ((req: TriageRequest) => Promise<TriageOutcome>) =>
  async () => ({
    level,
    leadId: 'engineering-lead',
    leadName: 'Marcus Reyes',
    decision: 'answer',
    optionId,
    reasoning: 'The Blueprint lists Hero with variants.',
    ruleIds: [],
    tokens: 500,
    usd: 0.002,
  });

const heroCards = (s: ReturnType<Awaited<ReturnType<typeof launch>>['state']>) =>
  Object.values(s!.escalations).filter((x) => x.title === HERO_Q);

it('lets the Lead settle a question it may decide: the task retries with its answer', async () => {
  const seen: RunRequest[] = [];
  const asked: TriageRequest[] = [];
  const answer = lead('lead');
  const p = await launch(h, {
    runner: heroAsks(1, seen),
    triage: async (req) => (asked.push(req), answer(req)),
  });
  const bot = directorBot(p, () => null);
  await p.handle.result();
  await bot.stop();
  const s = p.state()!;

  expect(asked[0]).toMatchObject({
    taskId: 'port-hero',
    category: 'naming',
    previous: [],
    card: {
      options: [
        { id: 'opt-1', recommended: true },
        { id: 'opt-2', recommended: false },
      ],
    },
  });
  const [card] = heroCards(s);
  expect(card).toMatchObject({
    category: 'naming',
    status: 'resolved',
    resolution: {
      optionId: 'opt-1',
      by: 'lead',
      notes: 'Marcus Reyes: The Blueprint lists Hero with variants.',
    },
  });
  expect(s.decisions.find((d) => d.escalationId === card!.escalationId)).toMatchObject({
    decidedBy: 'lead',
    answer: 'One rendering with variants',
  });
  const retry = seen.filter((r) => r.task.taskId === 'port-hero').at(-1)!;
  expect(retry.instructions).toMatch(/^Decision on "Hero: .*": One rendering with variants\./);
  expect(plan(s).tasks.find((t) => t.taskId === 'port-hero')!.state).toBe('done');
}, 120_000);

it('in shadow, puts the Lead’s answer on the card and leaves the choice to the Director', async () => {
  const p = await launch(h, { runner: heroAsks(1), triage: lead('shadow', 'opt-1') });
  const bot = directorBot(p, (x) => (x.title === HERO_Q ? { optionId: 'opt-2' } : null));
  await p.handle.result();
  await bot.stop();
  const [card] = heroCards(p.state());
  expect(card).toMatchObject({
    triage: {
      leadId: 'engineering-lead',
      mode: 'shadow',
      optionId: 'opt-1',
      reasoning: 'The Blueprint lists Hero with variants.',
    },
    resolution: { optionId: 'opt-2', by: 'director' },
  });
}, 120_000);

it('answers at most twice in a row on one task, then the Director gets the question with its answers', async () => {
  const asked: TriageRequest[] = [];
  const answer = lead('lead');
  const p = await launch(h, {
    runner: heroAsks(3),
    triage: async (req) => (asked.push(req), answer(req)),
  });
  const bot = directorBot(p, (x) => (x.title === HERO_Q ? { optionId: 'opt-2' } : null));
  await p.handle.result();
  await bot.stop();
  const cards = heroCards(p.state()).sort((a, b) => a.raisedAt.localeCompare(b.raisedAt));
  expect(cards.map((c) => c.resolution?.by)).toEqual(['lead', 'lead', 'director']);
  expect(cards[2]!.triage).toMatchObject({ mode: 'forwarded', optionId: null });
  expect(cards[2]!.triage!.reasoning).toMatch(/answered 2 questions on this task in a row/);
  // Each question showed the Lead its earlier answers on the task (a retried call asks again).
  expect([...new Set(asked.map((a) => a.previous.length))]).toEqual([0, 1, 2]);
}, 120_000);

it('sends the card up as before when triage fails', async () => {
  const p = await launch(h, {
    runner: heroAsks(1),
    triage: async () => {
      throw new Error('model unavailable');
    },
  });
  const bot = directorBot(p, (x) => (x.title === HERO_Q ? { optionId: 'opt-1' } : null));
  await p.handle.result();
  await bot.stop();
  const [card] = heroCards(p.state());
  expect(card).toMatchObject({ category: 'naming', triage: null, resolution: { by: 'director' } });
}, 120_000);
