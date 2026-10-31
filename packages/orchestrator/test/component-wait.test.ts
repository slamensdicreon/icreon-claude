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

it('sends a component failure to its owner once, redoes its port before its integration, and re-checks the pages without their agent', async () => {
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
  // Three pages fail on the Hero's code the first time they are checked; the Hero is fixed by
  // the time they are checked again.
  const failing = new Set(['migrate-pages-page-1', 'migrate-pages-page-2', 'migrate-pages-page-3']);
  const checked: string[] = [];
  const validate = async (req: { task: { taskId: string } }): Promise<ValidationResult> => {
    const id = req.task.taskId;
    checked.push(id);
    if (!failing.has(id)) return { pass: true, reason: null };
    failing.delete(id);
    const fixes = 'Hero: the source shows a grey band; the page shows black.';
    return {
      pass: false,
      reason: 'Hero needs fixing in code.',
      checks: [{ id: 'parity.visual', status: 'fail' }],
      waitOn: {
        summary: 'Hero needs fixing in code.',
        taskIds: [],
        // Listed integration first: the workflow redoes them in plan order regardless.
        sendBack: [
          { taskId: 'integrate-hero', fixes },
          { taskId: 'port-hero', fixes },
        ],
        what: 'fixes to Hero',
        review: { fixes: null },
      },
    };
  };
  const p = await launch(h, { runner, validate });
  const bot = directorBot(p, () => null);
  await p.handle.result();
  await bot.stop();
  const s = p.state()!;

  // No card for any page: the failure was the component's.
  expect(Object.values(s.escalations).filter((x) => x.title.startsWith('Migrate'))).toEqual([]);
  // Each page's agent ran once; the pages passed on a second check without it.
  for (const n of [1, 2, 3]) {
    const id = `migrate-pages-page-${n}`;
    expect(runs.filter((r) => r === id)).toHaveLength(1);
    expect(checked.filter((c) => c === id)).toHaveLength(2);
    expect(s.tasks[id]!.state).toBe('done');
  }
  // The Hero was redone once for all three pages, port before integration.
  expect(runs.filter((r) => r === 'port-hero')).toHaveLength(2);
  expect(runs.filter((r) => r === 'integrate-hero')).toHaveLength(2);
  const portRedo = runs.lastIndexOf('port-hero');
  const integrateRedo = runs.lastIndexOf('integrate-hero');
  expect(portRedo).toBeLessThan(integrateRedo);
  const events = await h.store.read(p.projectId);
  const pageMoves = events
    .filter((e) => e.type === 'task.state' && e.subject.id === 'migrate-pages-page-1')
    .map((e) => (e.data as { from: string; to: string }).to);
  expect(pageMoves).toContain('waiting');
  expect(pageMoves).not.toContain('rejected');
  // Both fixes reached the port's brief.
  const portBrief = events.filter(
    (e) =>
      e.type === 'task.state' &&
      e.subject.id === 'port-hero' &&
      (e.data as { to: string }).to === 'rolled_back',
  );
  expect(portBrief).toHaveLength(1);
}, 180_000);
