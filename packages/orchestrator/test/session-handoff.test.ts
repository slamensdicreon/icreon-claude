import {
  BlobCheckpoints,
  type RunOptions,
  type RunOutcome,
  type RunRequest,
  type SessionCheckpoint,
} from '@lw/agent-runtime';
import { Context } from '@temporalio/activity';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import type { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createWorker } from '../src';
import {
  directorBot,
  launch,
  startHarness,
  stopHarness,
  TASK_QUEUE,
  type Harness,
} from './harness';

const TURNS = 4;

// A real dev server, not the time-skipping one: only a server that keeps the heartbeat an
// activity fails with (Temporal 1.16+, as Temporal Cloud does) hands the retry its last details.
let env: TestWorkflowEnvironment;
beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
}, 120_000);
afterAll(async () => {
  await env?.teardown();
});

const checkpoint = (turn: number): SessionCheckpoint => ({
  turn,
  stepIndex: turn,
  maxTokens: 16_000,
  spent: { tokens: turn * 1_000, usd: turn / 100 },
  system: [{ type: 'text', text: 'You are the Component Engineer.' }],
  messages: Array.from({ length: 2 * turn + 1 }, (_, i) => ({
    role: i % 2 ? ('assistant' as const) : ('user' as const),
    content: `message ${i}`,
  })),
});

/** Checkpoints in memory, as the blob store would keep them. */
function memoryCheckpoints() {
  const stored = new Map<string, Uint8Array>();
  const store = new BlobCheckpoints({
    put: async (projectId, key, bytes) => {
      stored.set(`blob://${projectId}/${key}`, bytes);
      return `blob://${projectId}/${key}`;
    },
    get: async (ref) => stored.get(ref) ?? Promise.reject(new Error(`No blob at ${ref}`)),
    delete: async (refs) => refs.forEach((r) => stored.delete(r)),
    deleteProject: async () => undefined,
  });
  return { stored, store };
}

/**
 * Hero's agent, keeping the runtime's contract: a turn at a time, each saved, and between turns
 * it stops if its worker is draining. Every other task finishes at once.
 */
function heroAgent(during: (turn: number, attempt: number, opts: RunOptions) => Promise<void>) {
  const turns: string[] = [];
  return {
    turns,
    async run(req: RunRequest, opts: RunOptions = {}): Promise<RunOutcome> {
      if (req.task.taskId !== 'port-hero')
        return { kind: 'done', summary: 'ok', metrics: {}, spent: { tokens: 1_000, usd: 0.01 } };
      const attempt = Context.current().info.attempt;
      for (let turn = (opts.resume?.turn ?? 0) + 1; turn <= TURNS; turn++) {
        if (opts.drain?.aborted)
          throw Object.assign(new Error(`Stopped after turn ${turn - 1}`), {
            name: 'SessionStopped',
          });
        turns.push(`turn ${turn} on attempt ${attempt}`);
        await during(turn, attempt, opts);
        await opts.checkpoint?.(checkpoint(turn));
      }
      return { kind: 'done', summary: 'Ported Hero', metrics: {}, spent: checkpoint(TURNS).spent };
    },
  };
}

/**
 * A project whose Hero session a deploy interrupts: the old worker drains and stops taking
 * tasks, finishes what it had (the session hands over), and the new one starts on the queue.
 */
async function engagementWithDeploy(
  h: Harness,
  drainOld: AbortController,
  during: (turn: number, attempt: number, opts: RunOptions) => Promise<void>,
) {
  const { stored, store } = memoryCheckpoints();
  const agent = heroAgent(during);
  const p = await launch(h, { runner: agent, checkpoints: store });
  const bot = directorBot(p);
  return {
    agent,
    stored,
    p,
    async deploy(meanwhile?: () => void): Promise<{ worker: Worker; run: Promise<void> }> {
      drainOld.abort();
      h.worker.shutdown();
      meanwhile?.();
      // One worker per queue in a process: the new one starts once the old one is done.
      await h.run;
      const worker = await createWorker({
        connection: h.env.nativeConnection,
        activities: h.activities,
        taskQueue: TASK_QUEUE,
      });
      return { worker, run: worker.run() };
    },
    async finish() {
      await p.handle.result();
      await bot.stop();
    },
  };
}

const heroCards = (s: ReturnType<Awaited<ReturnType<typeof launch>>['state']>) =>
  Object.values(s?.escalations ?? {}).filter((x) => x.title.includes('Hero'));

it('hands a session over after its turn in progress when the worker is replaced, and loses nothing', async () => {
  const drainOld = new AbortController();
  const h = await startHarness({ env, draining: drainOld.signal, shutdownGraceTime: '1 minute' });
  let next: { worker: Worker; run: Promise<void> } | undefined;
  try {
    let reached!: () => void;
    const atTurn2 = new Promise<void>((r) => (reached = r));
    let deployed!: () => void;
    const afterDeploy = new Promise<void>((r) => (deployed = r));
    const e = await engagementWithDeploy(h, drainOld, async (turn, attempt) => {
      if (turn === 2 && attempt === 1) {
        reached();
        await afterDeploy;
      }
    });
    await atTurn2;
    // The deploy lands mid-turn; the turn finishes on the old worker, within its grace period.
    next = await e.deploy(deployed);
    await e.finish();

    expect(e.agent.turns).toEqual([
      'turn 1 on attempt 1',
      'turn 2 on attempt 1',
      'turn 3 on attempt 2',
      'turn 4 on attempt 2',
    ]);
    const s = e.p.state()!;
    expect(s.status).toBe('completed');
    expect(s.tasks['port-hero']!.state).toBe('done');
    // The handoff is invisible to the plan: one attempt, no card.
    expect(s.tasks['port-hero']!.attempt).toBe(1);
    expect(heroCards(s)).toEqual([]);
    // Finished: its saved conversation is gone.
    expect(e.stored.size).toBe(0);
  } finally {
    next?.worker.shutdown();
    await next?.run;
    await stopHarness(h);
  }
}, 300_000);

it('when the grace period runs out mid-turn, the next worker redoes only that turn', async () => {
  const drainOld = new AbortController();
  // No grace: the old worker cancels what it is running as soon as it shuts down.
  const h = await startHarness({ env, draining: drainOld.signal });
  let next: { worker: Worker; run: Promise<void> } | undefined;
  try {
    let reached!: () => void;
    const atTurn3 = new Promise<void>((r) => (reached = r));
    const e = await engagementWithDeploy(h, drainOld, async (turn, attempt, opts) => {
      if (turn !== 3 || attempt !== 1) return;
      reached();
      // A long tool call, abandoned when the session is cancelled.
      await new Promise((_, reject) =>
        opts.abort!.addEventListener('abort', () => reject(opts.abort!.reason), { once: true }),
      );
    });
    await atTurn3;
    next = await e.deploy();
    await e.finish();

    expect(e.agent.turns).toEqual([
      'turn 1 on attempt 1',
      'turn 2 on attempt 1',
      'turn 3 on attempt 1',
      'turn 3 on attempt 2',
      'turn 4 on attempt 2',
    ]);
    const s = e.p.state()!;
    expect(s.tasks['port-hero']!.state).toBe('done');
    expect(s.tasks['port-hero']!.attempt).toBe(1);
    expect(heroCards(s)).toEqual([]);
  } finally {
    next?.worker.shutdown();
    await next?.run;
    await stopHarness(h);
  }
}, 300_000);
