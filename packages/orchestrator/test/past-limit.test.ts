import type { RunRequest } from '@lw/agent-runtime';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ValidationResult } from '../src';
import { directorBot, launch, startHarness, stopHarness, type Harness } from './harness';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
}, 120_000);
afterAll(async () => {
  await stopHarness(h);
});

const PAGE = 'migrate-pages-page-1';
const HERO_FIX = 'Hero: the source shows a grey band; the page shows black.';

/** A page whose review keeps finding the Hero's code at fault; `own` adds fixes of its own on one check. */
function scenario(opts: { passOn?: number; ownFixesOn?: number; ownFixesFrom?: number } = {}) {
  const runs: RunRequest[] = [];
  const checks: string[] = [];
  const runner = {
    async run(req: RunRequest) {
      runs.push(req);
      return {
        kind: 'done' as const,
        summary: 'ok',
        metrics: {},
        spent: { tokens: 1_000, usd: 0.01 },
      };
    },
  };
  const validate = async (req: { task: { taskId: string } }): Promise<ValidationResult> => {
    const id = req.task.taskId;
    checks.push(id);
    const n = checks.filter((c) => c === PAGE).length;
    if (id !== PAGE || (opts.passOn && n >= opts.passOn)) return { pass: true, reason: null };
    return {
      pass: false,
      reason: 'Hero needs fixing in code.',
      checks: [{ id: 'parity.visual', status: 'fail' }],
      waitOn: {
        summary: 'Hero needs fixing in code.',
        taskIds: [],
        sendBack: [{ taskId: 'port-hero', fixes: HERO_FIX }],
        what: 'fixes to Hero',
        review: {
          fixes:
            n === opts.ownFixesOn || (opts.ownFixesFrom && n >= opts.ownFixesFrom)
              ? 'Remove the empty spacer above the band.'
              : null,
        },
      },
    };
  };
  return { runs, checks, runner, validate };
}

it('finishes a page past its send-back limit and hands the differences to the parity audit', async () => {
  const sc = scenario();
  const p = await launch(h, { runner: sc.runner, validate: sc.validate });
  const bot = directorBot(p, () => null);
  await p.handle.result();
  await bot.stop();
  const s = p.state()!;

  // No card: the page sent Hero back twice, then finished on its third check.
  expect(Object.values(s.escalations).filter((x) => x.title.startsWith('Migrate'))).toEqual([]);
  expect(s.tasks[PAGE]!.state).toBe('done');
  expect(sc.runs.filter((r) => r.task.taskId === PAGE)).toHaveLength(1);
  expect(sc.checks.filter((c) => c === PAGE)).toHaveLength(3);
  expect(sc.runs.filter((r) => r.task.taskId === 'port-hero')).toHaveLength(3);
  // The audit got the Hero's remaining differences in its brief.
  const audit = sc.runs.find((r) => r.task.taskId === 'audit-parity')!;
  expect(audit.instructions).toContain('already sent Port Hero');
  expect(audit.instructions).toContain(HERO_FIX);
  // The Decision Log says what happened and why.
  const logged = (await h.store.read(p.projectId)).filter(
    (e) => e.type === 'decision.recorded' && e.subject.id === `past-limit:${PAGE}`,
  );
  expect(logged).toHaveLength(1);
  expect(logged[0]!.data).toMatchObject({
    decidedBy: 'rule',
    answer: 'Finished; the component differences were handed on',
  });
}, 180_000);

it('runs a page past its limit once more for fixes of its own, without asking the component again', async () => {
  const sc = scenario({ ownFixesOn: 3, passOn: 4 });
  const p = await launch(h, { runner: sc.runner, validate: sc.validate });
  const bot = directorBot(p, () => null);
  await p.handle.result();
  await bot.stop();
  const s = p.state()!;

  expect(Object.values(s.escalations).filter((x) => x.title.startsWith('Migrate'))).toEqual([]);
  expect(s.tasks[PAGE]!.state).toBe('done');
  const page = sc.runs.filter((r) => r.task.taskId === PAGE);
  expect(page).toHaveLength(2);
  expect(page[1]!.instructions).toContain('Remove the empty spacer above the band.');
  expect(page[1]!.instructions).toContain('already sent back 2 times for this task');
  // Hero wasn't sent back a third time.
  expect(sc.runs.filter((r) => r.task.taskId === 'port-hero')).toHaveLength(3);
}, 180_000);

it('finishes after that one run when the review finds the same fixes of its own again', async () => {
  const sc = scenario({ ownFixesFrom: 3 });
  const p = await launch(h, { runner: sc.runner, validate: sc.validate });
  const bot = directorBot(p, () => null);
  await p.handle.result();
  await bot.stop();
  const s = p.state()!;

  // One run for its own fixes (check 3), then the review found them again (check 4): it
  // finished, with its findings handed to the audit alongside Hero's, and no card.
  expect(Object.values(s.escalations).filter((x) => x.title.startsWith('Migrate'))).toEqual([]);
  expect(s.tasks[PAGE]!.state).toBe('done');
  expect(sc.runs.filter((r) => r.task.taskId === PAGE)).toHaveLength(2);
  expect(sc.checks.filter((c) => c === PAGE)).toHaveLength(4);
  const audit = sc.runs.find((r) => r.task.taskId === 'audit-parity')!;
  expect(audit.instructions).toContain(
    'Its own findings, found again: Remove the empty spacer above the band.',
  );
}, 180_000);

it('asks the Director as before when the project turns the setting off', async () => {
  const sc = scenario({ passOn: 4 });
  const p = await launch(h, {
    runner: sc.runner,
    validate: sc.validate,
    finishPastLimit: async () => false,
  });
  const bot = directorBot(p, (x) => (x.title.startsWith('Migrate') ? { optionId: 'opt-1' } : null));
  await p.handle.result();
  await bot.stop();
  const s = p.state()!;

  const card = Object.values(s.escalations).find((x) => x.title.startsWith('Migrate'))!;
  expect(card.title).toBe('Migrate Page 1: what it needs is missing');
  expect(card.context).toContain('were already sent back 2 times');
  expect(s.tasks[PAGE]!.state).toBe('done');
}, 180_000);
