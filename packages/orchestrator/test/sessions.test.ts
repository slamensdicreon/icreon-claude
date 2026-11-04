import {
  BlobCheckpoints,
  type CheckpointRef,
  type RunOptions,
  type RunOutcome,
  type RunRequest,
  type SessionCheckpoint,
} from '@lw/agent-runtime';
import { ApplicationFailure, CancelledFailure } from '@temporalio/common';
import { MockActivityEnvironment } from '@temporalio/testing';
import { describe, expect, it } from 'vitest';
import {
  currentSession,
  SESSION_ATTEMPTS,
  withAgentRunner,
  withHeartbeats,
  withSessionRetries,
  WORKER_LOST,
  WORKER_SHUTDOWN,
  type Activities,
  type AgentRequest,
  type SessionProgress,
} from '../src';

const req = { projectId: 'p1', task: { taskId: 't1' }, attempt: 1 } as unknown as AgentRequest;
const ref: CheckpointRef = {
  parts: ['blob://p1/sessions/t1/1/a.json'],
  messages: 3,
  turn: 4,
  stepIndex: 6,
  maxTokens: 16_000,
  spent: { tokens: 5_000, usd: 0.05 },
};
const progress = (p: Partial<SessionProgress>) => ({
  v: 1,
  checkpoint: null,
  failures: 0,
  handoffs: 0,
  ...p,
});

/** runAgent as a worker hosts it, in an activity at `attempt` with the details it inherited. */
function host(
  runAgent: Activities['runAgent'],
  opts: { attempt?: number; details?: unknown; draining?: AbortSignal } = {},
) {
  const env = new MockActivityEnvironment({
    attempt: opts.attempt ?? 1,
    heartbeatDetails: opts.details,
  });
  const beats: unknown[] = [];
  env.on('heartbeat', (d: unknown) => beats.push(structuredClone(d)));
  const acts = withHeartbeats(
    withSessionRetries({ runAgent } as Activities, { draining: opts.draining }),
    20,
  );
  return { env, beats, run: () => env.run(acts.runAgent, req) };
}

const done = { tokens: 1, usd: 0 };

describe('agent session attempts', () => {
  it('starts afresh on the first attempt, and says so at once', async () => {
    let seen: unknown = 'unset';
    const h = host(async () => {
      seen = currentSession()?.resumeFrom;
      return done;
    });
    await expect(h.run()).resolves.toEqual(done);
    expect(seen).toBeNull();
    expect(h.beats[0]).toEqual(progress({}));
  });

  it('carries on from the checkpoint of an attempt whose worker vanished', async () => {
    let seen: unknown;
    const h = host(
      async () => {
        seen = currentSession()?.resumeFrom;
        return done;
      },
      { attempt: 2, details: progress({ checkpoint: ref }) },
    );
    await h.run();
    expect(seen).toEqual(ref);
    // The checkpoint stays in the details until a new one replaces it.
    expect(h.beats[0]).toEqual(progress({ checkpoint: ref }));
  });

  it('starts over after an error of its own, and gives up on the third as before', async () => {
    const boom = async () => {
      throw new Error('socket hang up');
    };
    // First: rethrown for Temporal to retry, counted.
    const first = host(boom);
    await expect(first.run()).rejects.toThrow('socket hang up');
    expect(first.beats.at(-1)).toEqual(progress({ failures: 1, ended: 'failed' }));

    // Second: the checkpoint the failed attempt left is not resumed.
    let seen: unknown = 'unset';
    const second = host(
      async () => {
        seen = currentSession()?.resumeFrom;
        throw new Error('socket hang up');
      },
      { attempt: 2, details: progress({ checkpoint: ref, failures: 1, ended: 'failed' }) },
    );
    await expect(second.run()).rejects.toThrow('socket hang up');
    expect(seen).toBeNull();
    expect(second.beats.at(-1)).toEqual(progress({ failures: 2, ended: 'failed' }));

    // Third, after a handoff in between: that one didn't count, this one ends the session.
    const third = host(boom, {
      attempt: 4,
      details: progress({ failures: 2, handoffs: 1 }),
    });
    const err = await third.run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApplicationFailure);
    expect(err).toMatchObject({ message: 'socket hang up', nonRetryable: true });
    expect(SESSION_ATTEMPTS.failures).toBe(3);
  });

  it('hands over when its worker drains, without spending an attempt', async () => {
    const draining = new AbortController();
    const h = host(
      async () => {
        draining.abort();
        currentSession()!.saved(ref);
        throw Object.assign(new Error('Stopped after turn 4'), { name: 'SessionStopped' });
      },
      { attempt: 3, details: progress({ failures: 1, handoffs: 1 }), draining: draining.signal },
    );
    const err = await h.run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApplicationFailure);
    expect(err).toMatchObject({ type: WORKER_SHUTDOWN, nonRetryable: false });
    expect((err as Error).message).toContain('after 4 turns');
    expect(h.beats.at(-1)).toEqual(
      progress({ checkpoint: ref, failures: 1, handoffs: 2, ended: 'handoff' }),
    );
  });

  it('hands over when the grace period ends mid-turn', async () => {
    let env!: MockActivityEnvironment;
    const h = host(async () => {
      const session = currentSession()!;
      env.cancel('WORKER_SHUTDOWN');
      // The runner abandons its turn with the cancellation.
      throw session.cancelled.reason;
    });
    env = h.env;
    const err = await h.run().catch((e: unknown) => e);
    expect(err).toMatchObject({ type: WORKER_SHUTDOWN });
    expect(h.beats.at(-1)).toEqual(progress({ handoffs: 1, ended: 'handoff' }));
  });

  it('passes other cancellations on as cancellations', async () => {
    let env!: MockActivityEnvironment;
    const h = host(async () => {
      env.cancel('NOT_FOUND');
      throw currentSession()!.cancelled.reason;
    });
    env = h.env;
    await expect(h.run()).rejects.toBeInstanceOf(CancelledFailure);
    expect(h.beats).toEqual([progress({})]);
  });

  it('gives up after its worker is lost three times, counting neither failures nor handoffs', async () => {
    let ran = 0;
    const run = async () => {
      ran++;
      return done;
    };
    // Six attempts before: 1 failure, 2 handoffs, so 3 lost.
    const lost = host(run, {
      attempt: 7,
      details: progress({ checkpoint: ref, failures: 1, handoffs: 2 }),
    });
    const err = await lost.run().catch((e: unknown) => e);
    expect(err).toMatchObject({ type: WORKER_LOST, nonRetryable: true });
    expect((err as Error).message).toContain('stopped 3 times');
    expect((err as ApplicationFailure).details).toEqual([{ spent: ref.spent }]);
    expect(ran).toBe(0);

    // Many deploys, two losses: it runs.
    await host(run, { attempt: 13, details: progress({ handoffs: 10 }) }).run();
    expect(ran).toBe(1);
  });

  it('ignores details it does not recognise', async () => {
    let seen: unknown = 'unset';
    const h = host(
      async () => {
        seen = currentSession()?.resumeFrom;
        return done;
      },
      { attempt: 2, details: { checkpoint: { parts: 'nope' }, failures: -1 } },
    );
    await h.run();
    expect(seen).toBeNull();
  });

  it('repeats the latest details on every periodic heartbeat', async () => {
    const h = host(async () => {
      currentSession()!.saved(ref);
      await new Promise((r) => setTimeout(r, 70));
      return done;
    });
    await h.run();
    expect(h.beats.length).toBeGreaterThanOrEqual(4);
    for (const b of h.beats.slice(1)) expect(b).toEqual(progress({ checkpoint: ref }));
  });
});

describe('withAgentRunner with checkpoints', () => {
  const session = (n: number): SessionCheckpoint => ({
    turn: n,
    stepIndex: n,
    maxTokens: 16_000,
    spent: { tokens: n * 1_000, usd: n / 100 },
    system: [{ type: 'text', text: 'system' }],
    messages: Array.from({ length: 2 * n + 1 }, (_, i) => ({
      role: i % 2 ? ('assistant' as const) : ('user' as const),
      content: `m${i}`,
    })),
  });
  const blobs = () => {
    const stored = new Map<string, Uint8Array>();
    return {
      stored,
      store: new BlobCheckpoints({
        put: async (p, k, bytes) => {
          stored.set(`blob://${p}/${k}`, bytes);
          return `blob://${p}/${k}`;
        },
        get: async (r) => stored.get(r) ?? Promise.reject(new Error(`No blob at ${r}`)),
        delete: async (refs) => refs.forEach((r) => stored.delete(r)),
        deleteProject: async () => undefined,
      }),
    };
  };
  /** Takes turns from where it is resumed until `upTo`, then stops (drain) or finishes. */
  const runner = (upTo: number, stop: boolean) => {
    const calls: { resumedAt: number | null }[] = [];
    return {
      calls,
      async run(_: RunRequest, opts: RunOptions = {}): Promise<RunOutcome> {
        calls.push({ resumedAt: opts.resume?.turn ?? null });
        for (let n = (opts.resume?.turn ?? 0) + 1; n <= upTo; n++)
          await opts.checkpoint?.(session(n));
        if (stop) throw Object.assign(new Error('stopped'), { name: 'SessionStopped' });
        return { kind: 'done', summary: 'ok', metrics: {}, spent: session(upTo).spent };
      },
    };
  };
  const agents = (r: ReturnType<typeof runner>, store: BlobCheckpoints) =>
    withAgentRunner({} as Activities, r, () => true, { checkpoints: store }).runAgent;

  it('saves every turn, resumes the next attempt from the last, and clears up when done', async () => {
    const { stored, store } = blobs();
    const first = runner(2, true);
    const a = host(agents(first, store));
    const err = await a.run().catch((e: unknown) => e);
    expect(err).toMatchObject({ type: WORKER_SHUTDOWN });
    const left = a.beats.at(-1) as SessionProgress;
    expect(left.checkpoint).toMatchObject({ turn: 2, messages: 5 });
    expect(stored.size).toBe(2);

    const second = runner(3, false);
    const b = host(agents(second, store), { attempt: 2, details: left });
    await expect(b.run()).resolves.toMatchObject({ tokens: 3_000, summary: 'ok' });
    expect(second.calls).toEqual([{ resumedAt: 2 }]);
    // Finished: the details point at nothing and the conversation is gone.
    expect((b.beats.at(-1) as SessionProgress).checkpoint).toBeNull();
    expect(stored.size).toBe(0);
  });

  it('starts over, and drops what it saved, when the checkpoint is unreadable or the attempt failed', async () => {
    const { stored, store } = blobs();
    const missing = { ...ref, parts: ['blob://p1/sessions/t1/1/gone.json'] };
    const r = runner(1, false);
    const run = withAgentRunner(
      {} as Activities,
      {
        run: async (q, o) => {
          await r.run(q, o);
          throw new Error('model overloaded');
        },
      },
      () => true,
      { checkpoints: store },
    ).runAgent;
    const h = host(run, { attempt: 2, details: progress({ checkpoint: missing }) });
    await expect(h.run()).rejects.toThrow('model overloaded');
    expect(r.calls).toEqual([{ resumedAt: null }]);
    expect(stored.size).toBe(0);
    expect(h.beats.at(-1)).toMatchObject({ failures: 1, ended: 'failed' });
  });
});
