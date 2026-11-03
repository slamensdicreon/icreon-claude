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

it('sends finished work back to its owner with the fixes, and carries on when it is redone', async () => {
  const seen: RunRequest[] = [];
  const runner = {
    async run(req: RunRequest) {
      seen.push(req);
      const spent = { tokens: 1_000, usd: 0.01 };
      if (req.task.taskId === 'port-header' && !req.instructions)
        return {
          kind: 'waiting' as const,
          summary: 'Header needs the Hero export renamed.',
          waitingOn: {
            taskIds: [],
            sendBack: [{ taskId: 'port-hero', fixes: 'Export Hero as HeroBanner.' }],
            what: 'the HeroBanner export',
          },
          spent,
        };
      return { kind: 'done' as const, summary: 'ok', metrics: {}, spent };
    },
  };
  const p = await launch(h, { runner });
  const bot = directorBot(p, () => null);
  await p.handle.result();
  await bot.stop();

  const s = p.state()!;
  const hero = seen.filter((r) => r.task.taskId === 'port-hero');
  expect(hero).toHaveLength(2);
  expect(hero[1]!.instructions).toBe(
    'Sent back by Component Engineer (Port Header to Content SDK): Export Hero as HeroBanner.',
  );
  const header = seen.filter((r) => r.task.taskId === 'port-header');
  expect(header).toHaveLength(2);
  expect(header[1]!.instructions).toContain('What you waited for (the HeroBanner export)');
  expect(Object.values(s.escalations).some((x) => x.title.includes('Header'))).toBe(false);
  expect(plan(s).tasks.every((t) => t.state === 'done' || t.kind !== 'work')).toBe(true);
}, 120_000);

it("counts send-backs per asker: one task's asks don't spend another's allowance", async () => {
  const runs: Record<string, number> = {};
  const runner = {
    async run(req: RunRequest) {
      const n = (runs[req.task.taskId] = (runs[req.task.taskId] ?? 0) + 1);
      const spent = { tokens: 1_000, usd: 0.01 };
      const back = (fixes: string) => ({
        kind: 'waiting' as const,
        summary: `Needs Hero changed: ${fixes}`,
        waitingOn: {
          taskIds: [],
          sendBack: [{ taskId: 'port-hero', fixes }],
          what: 'the Hero fix',
        },
        spent,
      });
      const wait = (taskId: string) => ({
        kind: 'waiting' as const,
        summary: `Waits on ${taskId}.`,
        waitingOn: { taskIds: [taskId], what: taskId },
        spent,
      });
      // Header waits for Hero, then sends it back twice (its full allowance) once it is done;
      // Tabs waits for Header, then sends Hero back once of its own.
      if (req.task.taskId === 'port-header' && n === 1) return wait('port-hero');
      if (req.task.taskId === 'port-header' && (n === 2 || n === 3))
        return back(`Header ask ${n}.`);
      if (req.task.taskId === 'port-tabs' && n === 1) return wait('port-header');
      if (req.task.taskId === 'port-tabs' && n === 2) return back('Tabs ask.');
      return { kind: 'done' as const, summary: 'ok', metrics: {}, spent };
    },
  };
  const p = await launch(h, { runner });
  const bot = directorBot(p, () => null);
  await p.handle.result();
  await bot.stop();

  const s = p.state()!;
  // Three asks of one component from two tasks: within each asker's allowance, so no card.
  expect(
    Object.values(s.escalations).filter((x) => x.title.endsWith('what it needs is missing')),
  ).toEqual([]);
  expect(runs['port-hero']).toBeGreaterThanOrEqual(4);
  expect(plan(s).tasks.every((t) => t.state === 'done' || t.kind !== 'work')).toBe(true);
}, 120_000);

it('counts only waits with nothing under way: a page that keeps sending fixes back raises no card', async () => {
  const runs: Record<string, number> = {};
  const runner = {
    async run(req: RunRequest) {
      const n = (runs[req.task.taskId] = (runs[req.task.taskId] ?? 0) + 1);
      const spent = { tokens: 1_000, usd: 0.01 };
      // Tabs checks four times; each time a fix it needs is still owed, so it sends Hero or
      // Header back (twice each, within its allowance) and waits for that round to land.
      const target = ['port-hero', 'port-header', 'port-hero', 'port-header'][n - 1];
      if (req.task.taskId === 'port-tabs' && target)
        return {
          kind: 'waiting' as const,
          summary: `Check ${n}: ${target} still needs a fix.`,
          waitingOn: {
            taskIds: [],
            sendBack: [{ taskId: target, fixes: `Fix ${n}.` }],
            what: `the ${target} fix`,
          },
          spent,
        };
      return { kind: 'done' as const, summary: 'ok', metrics: {}, spent };
    },
  };
  const p = await launch(h, { runner });
  const bot = directorBot(p, () => null);
  await p.handle.result();
  await bot.stop();

  const s = p.state()!;
  // Four waits, past the limit of three, but each waited on work under way: no card.
  expect(
    Object.values(s.escalations).filter((x) => x.title.endsWith('what it needs is missing')),
  ).toEqual([]);
  expect(runs['port-tabs']).toBe(5);
  expect(plan(s).tasks.every((t) => t.state === 'done' || t.kind !== 'work')).toBe(true);
}, 120_000);

it("renews a task's waits when its card is answered, so it asks again only after three more", async () => {
  const runs: Record<string, number> = {};
  const runner = {
    async run(req: RunRequest) {
      const n = (runs[req.task.taskId] = (runs[req.task.taskId] ?? 0) + 1);
      const spent = { tokens: 1_000, usd: 0.01 };
      // Tabs waits on Hero five times in a row, then finishes.
      if (req.task.taskId === 'port-tabs' && n <= 5)
        return {
          kind: 'waiting' as const,
          summary: 'Waits on Hero.',
          waitingOn: { taskIds: ['port-hero'], what: 'the Hero component' },
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
  // The fourth wait passes the limit and asks; the answer renews the waits, so the fifth doesn't.
  const cards = Object.values(s.escalations).filter((x) => x.title.startsWith('Port Tabs'));
  expect(cards).toHaveLength(1);
  expect(runs['port-tabs']).toBe(6);
  expect(plan(s).tasks.every((t) => t.state === 'done' || t.kind !== 'work')).toBe(true);
}, 120_000);

it('never parks a task on a later phase: it finishes its part and leaves the rest', async () => {
  const seen: RunRequest[] = [];
  const runner = {
    async run(req: RunRequest) {
      seen.push(req);
      const spent = { tokens: 1_000, usd: 0.01 };
      if (req.task.taskId === 'port-header' && !req.instructions)
        return {
          kind: 'waiting' as const,
          summary: 'The re-crawl has to happen first.',
          waitingOn: { taskIds: ['recrawl-source'], what: 'the re-crawl' },
          spent,
        };
      return { kind: 'done' as const, summary: 'ok', metrics: {}, spent };
    },
  };
  const p = await launch(h, { runner });
  const bot = directorBot(p, () => null);
  await p.handle.result();
  await bot.stop();

  const header = seen.filter((r) => r.task.taskId === 'port-header');
  expect(header).toHaveLength(2);
  expect(header[1]!.instructions).toContain('runs in a later phase');
  expect(Object.values(p.state()!.escalations).some((x) => x.title.includes('Header'))).toBe(false);
}, 120_000);

it("runs a redone port's integration again, and the page waits for both", async () => {
  const order: string[] = [];
  const runs: Record<string, number> = {};
  const runner = {
    async run(req: RunRequest) {
      const id = req.task.taskId;
      const n = (runs[id] = (runs[id] ?? 0) + 1);
      order.push(`${id}#${n}`);
      const spent = { tokens: 1_000, usd: 0.01 };
      // A page sends only the Hero port back; nothing names Hero's integration.
      if (id === 'migrate-pages-page-1' && n === 1)
        return {
          kind: 'waiting' as const,
          summary: 'The Hero needs a fix.',
          waitingOn: {
            taskIds: [],
            sendBack: [{ taskId: 'port-hero', fixes: 'Fix the Hero overlay.' }],
            what: 'the Hero fix',
          },
          spent,
        };
      return { kind: 'done' as const, summary: 'ok', metrics: {}, spent };
    },
  };
  const p = await launch(h, { runner });
  const bot = directorBot(p, () => null);
  await p.handle.result();
  await bot.stop();

  // The integration ran again after the port was redone, and the page only after both.
  expect(runs['integrate-hero']).toBe(2);
  const at = (x: string) => order.indexOf(x);
  expect(at('integrate-hero#2')).toBeGreaterThan(at('port-hero#2'));
  expect(at('migrate-pages-page-1#2')).toBeGreaterThan(at('integrate-hero#2'));
  expect(plan(p.state()!).tasks.every((t) => t.state === 'done' || t.kind !== 'work')).toBe(true);
}, 120_000);

it('lets a held send-back run when the task it waits behind waits on it', async () => {
  const seen: RunRequest[] = [];
  const runs: Record<string, number> = {};
  let first: string | null = null;
  const pair = ['port-hero', 'port-header'];
  const runner = {
    async run(req: RunRequest) {
      seen.push(req);
      const id = req.task.taskId;
      const n = (runs[id] = (runs[id] ?? 0) + 1);
      const spent = { tokens: 1_000, usd: 0.01 };
      // Tabs sends Hero and Header back together: the later one in the plan is held until the
      // earlier one is redone. The earlier one, redone, then needs a change in the later one.
      if (id === 'port-tabs' && n === 1)
        return {
          kind: 'waiting' as const,
          summary: 'Hero and Header both need a fix.',
          waitingOn: {
            taskIds: [],
            sendBack: pair.map((taskId) => ({ taskId, fixes: `Fix ${taskId}.` })),
            what: 'the Hero and Header fixes',
          },
          spent,
        };
      if (pair.includes(id) && n === 2 && !first) {
        first = id;
        const other = pair.find((x) => x !== id)!;
        return {
          kind: 'waiting' as const,
          summary: `Needs ${other} first.`,
          waitingOn: { taskIds: [other], what: `the ${other} fix` },
          spent,
        };
      }
      return { kind: 'done' as const, summary: 'ok', metrics: {}, spent };
    },
  };
  const p = await launch(h, { runner });
  const bot = directorBot(p, () => null);
  await p.handle.result();
  await bot.stop();

  // The held task ran, so the first one's wait ended the normal way, not by a release.
  const last = seen.filter((r) => r.task.taskId === first).at(-1)!;
  expect(runs[first!]).toBe(3);
  expect(last.instructions).toContain('What you waited for');
  expect(last.instructions).not.toContain('Nothing is working on what you waited for');
  expect(plan(p.state()!).tasks.every((t) => t.state === 'done' || t.kind !== 'work')).toBe(true);
}, 120_000);

it('releases waits nothing can end: nobody working and no card open', async () => {
  const seen: RunRequest[] = [];
  const runner = {
    async run(req: RunRequest) {
      seen.push(req);
      const spent = { tokens: 1_000, usd: 0.01 };
      // Validation waits on Header's registration, which waits on this port: it can't move.
      if (req.task.taskId === 'port-header' && !req.instructions)
        return {
          kind: 'waiting' as const,
          summary: 'Waiting for validation.',
          waitingOn: { taskIds: ['validate-components'], what: 'the validation' },
          spent,
        };
      return { kind: 'done' as const, summary: 'ok', metrics: {}, spent };
    },
  };
  const p = await launch(h, { runner });
  const bot = directorBot(p, () => null);
  await p.handle.result();
  await bot.stop();

  const header = seen.filter((r) => r.task.taskId === 'port-header');
  expect(header).toHaveLength(2);
  expect(header[1]!.instructions).toContain('Nothing is working on what you waited for');
}, 120_000);

it('hands fixes for a later phase to that task, without waiting on it', async () => {
  const seen: RunRequest[] = [];
  const runner = {
    async run(req: RunRequest) {
      seen.push(req);
      const spent = { tokens: 1_000, usd: 0.01 };
      if (req.task.taskId === 'port-header' && !req.instructions)
        return {
          kind: 'waiting' as const,
          summary: 'The re-crawl must include the header links.',
          waitingOn: {
            taskIds: [],
            sendBack: [{ taskId: 'recrawl-source', fixes: 'Include the header links.' }],
            what: 'header links in the re-crawl',
          },
          spent,
        };
      return { kind: 'done' as const, summary: 'ok', metrics: {}, spent };
    },
  };
  const p = await launch(h, { runner });
  const bot = directorBot(p, () => null);
  await p.handle.result();
  await bot.stop();

  const header = seen.filter((r) => r.task.taskId === 'port-header');
  expect(header).toHaveLength(2);
  expect(header[1]!.instructions).toContain('Your fixes for Re-crawl the source for parity');
  const recrawl = seen.filter((r) => r.task.taskId === 'recrawl-source');
  expect(recrawl[0]!.instructions).toBe(
    'Handed on by Component Engineer (Port Header to Content SDK): Include the header links.',
  );
  expect(Object.values(p.state()!.escalations).some((x) => x.title.includes('Header'))).toBe(false);
}, 120_000);
