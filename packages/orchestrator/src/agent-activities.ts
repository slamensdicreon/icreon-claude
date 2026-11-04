import type {
  CheckpointRef,
  CheckpointStore,
  RunOptions,
  RunOutcome,
  RunRequest,
  SessionCheckpoint,
} from '@lw/agent-runtime';
import { MetricKey } from '@lw/contracts';
import { ApplicationFailure } from '@temporalio/activity';
import type { Activities } from './activities';
import { currentSession } from './sessions';
import {
  ACCESS_DENIED,
  AGENT_FAILED,
  CAPABILITY_GAP,
  NEEDS_DECISION,
  PROVIDER_DOWN,
  providerOutage,
  WAITING,
  type AgentRequest,
  type AgentResult,
} from './types';

/** Anything that runs one agent session for a task: the AgentRuntime, or a test double. */
export interface AgentRunner {
  run(req: RunRequest, opts?: RunOptions): Promise<RunOutcome>;
}

/**
 * Swaps the stub agents for real ones: runAgent goes to the agent runtime; the other activities
 * stay as given. Outcomes the workflow must act on travel as typed, non-retryable failures that
 * carry what the session spent. With `checkpoints`, a session saves every turn there and a retry
 * after its worker went away carries on from the last one (see sessions.ts).
 */
export function withAgentRunner(
  base: Activities,
  runner: AgentRunner,
  /** Tasks that run on the real runtime; the rest keep the base (stub) agents. */
  only: (task: AgentRequest['task']) => boolean = () => true,
  opts: { checkpoints?: CheckpointStore } = {},
): Activities {
  return {
    ...base,
    async runAgent(req): Promise<AgentResult> {
      if (!only(req.task)) return base.runAgent(req);
      const out = await outageAware(() => runSession(runner, req, opts.checkpoints));
      const spent = { tokens: out.spent.tokens, usd: out.spent.usd };
      switch (out.kind) {
        case 'done': {
          const metrics: AgentResult['metrics'] = {};
          for (const [k, v] of Object.entries(out.metrics)) {
            const key = MetricKey.safeParse(k);
            if (key.success) metrics[key.data] = v;
          }
          return { ...spent, metrics, summary: out.summary };
        }
        case 'needs_decision':
          throw ApplicationFailure.create({
            type: NEEDS_DECISION,
            message: out.decision.question,
            nonRetryable: true,
            details: [{ spent, summary: out.summary, ...out.decision }],
          });
        case 'waiting':
          throw ApplicationFailure.create({
            type: WAITING,
            message: out.waitingOn.what,
            nonRetryable: true,
            details: [{ spent, summary: out.summary, ...out.waitingOn }],
          });
        case 'capability_gap':
          throw ApplicationFailure.create({
            type: CAPABILITY_GAP,
            message: out.capability,
            nonRetryable: true,
            details: [{ spent, summary: out.summary, capability: out.capability }],
          });
        case 'access_denied':
          throw ApplicationFailure.create({
            type: ACCESS_DENIED,
            message: out.message,
            nonRetryable: true,
            details: [{ spent }],
          });
        case 'failed':
          if (providerOutage({ message: out.reason }))
            throw down(providerOutage({ message: out.reason })!, spent);
          throw ApplicationFailure.create({
            type: AGENT_FAILED,
            message: out.reason,
            nonRetryable: true,
            details: [{ spent }],
          });
      }
    },
    // The Lead's review calls the model too.
    async validate(req) {
      return outageAware(() => base.validate(req));
    },
  };
}

/** A failure the workflow pauses the project for, without spending the task's attempts. */
function down(reason: string, spent = { tokens: 0, usd: 0 }) {
  return ApplicationFailure.create({
    type: PROVIDER_DOWN,
    message: reason,
    nonRetryable: true,
    details: [{ spent }],
  });
}

/**
 * One attempt of a task's agent session. Hosted by a worker, it carries on from the checkpoint
 * an earlier attempt left, saves one after every turn, and stops between turns when the worker
 * drains. Called outside a worker (some tests), it is a plain run.
 */
async function runSession(
  runner: AgentRunner,
  req: AgentRequest,
  store: CheckpointStore | undefined,
): Promise<RunOutcome> {
  const session = currentSession();
  if (!session) return runner.run(req);
  const key = { projectId: req.projectId, taskId: req.task.taskId, attempt: req.attempt };
  let ref: CheckpointRef | null = store ? session.resumeFrom : null;
  let resume: SessionCheckpoint | null = null;
  if (store && ref) {
    try {
      resume = await store.load(ref);
    } catch (err) {
      console.warn(`${req.task.taskId}: its saved session can't be read, so it starts over`, err);
      await store.discard(ref).catch(() => undefined);
      ref = null;
      session.saved(null);
    }
  }
  try {
    const out = await runner.run(req, {
      resume,
      drain: session.draining,
      abort: session.cancelled,
      ...(store
        ? {
            checkpoint: async (cp: SessionCheckpoint) => {
              ref = await store.save(key, ref, cp);
              session.saved(ref);
            },
          }
        : {}),
    });
    // Over on its own terms: nothing carries on from it.
    if (store && ref) {
      const done: CheckpointRef = ref;
      session.saved(null);
      await store.discard(done).catch(() => undefined);
    }
    return out;
  } catch (err) {
    // The next attempt starts over (or there is none): what this one saved won't be read.
    if (store && ref && !session.resumable(err)) await store.discard(ref).catch(() => undefined);
    throw err;
  }
}

async function outageAware<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const why = providerOutage(err);
    throw why ? down(why) : err;
  }
}
