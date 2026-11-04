import type { CheckpointRef } from '@lw/agent-runtime';
import { ApplicationFailure, CancelledFailure, Context } from '@temporalio/activity';
import type { Activities } from './activities';
import { SESSION_ATTEMPTS, WORKER_LOST, WORKER_SHUTDOWN } from './types';

/**
 * What an agent session's heartbeats carry. Temporal hands the last of them to the next attempt
 * (`info.heartbeatDetails`), so the retry knows where the session got to and how the attempts
 * before it ended. The conversation itself is in the checkpoint store; this only points at it.
 */
export interface SessionProgress {
  v: 1;
  /** The session as of its last completed turn; null before the first, or when it starts over. */
  checkpoint: CheckpointRef | null;
  /** Earlier attempts that ended in an error of the session's own. */
  failures: number;
  /** Earlier attempts handed on because their worker was shutting down. */
  handoffs: number;
  /** How the attempt that sent this ended, when it ended on its own terms. */
  ended?: 'failed' | 'handoff';
}

/** The hosting of one attempt of an agent session, for the runner that carries it out. */
export interface AgentSession {
  /** Where an earlier attempt left the session: this one carries on from there. */
  readonly resumeFrom: CheckpointRef | null;
  /** Aborted when the worker begins shutting down: hand over after the turn in progress. */
  readonly draining: AbortSignal;
  /** Aborted when the attempt must stop now (grace period over, workflow gone, timed out). */
  readonly cancelled: AbortSignal;
  /** A completed turn was saved here (null: nothing to resume); the next attempt will find it. */
  saved(ref: CheckpointRef | null): void;
  /** Whether a later attempt will carry on from this one's checkpoint after `err`. */
  resumable(err: unknown): boolean;
}

/** How an attempt ended, for what the next one does. */
type Ending =
  /** The session is over either way: an outcome, or a failure that isn't retried. */
  | 'final'
  /** The worker is going away; the next attempt resumes. */
  | 'handoff'
  /** Temporal stopped it (workflow gone, timed out); a retry, if any, resumes. */
  | 'cancelled'
  /** An error of its own: the next attempt starts over. */
  | 'failed';

const sessions = new WeakMap<Context, Session>();
const lastDetails = new WeakMap<Context, unknown>();
const NEVER = new AbortController().signal;
const ZERO = { tokens: 0, usd: 0 };

/** The agent session the current activity hosts; null outside a worker's runAgent. */
export function currentSession(): AgentSession | null {
  let ctx: Context;
  try {
    ctx = Context.current();
  } catch {
    return null;
  }
  return sessions.get(ctx) ?? null;
}

/**
 * What a heartbeat should carry now: the activity's latest details, else the previous
 * attempt's. Every heartbeat replaces the details the server keeps, so a periodic one without
 * them would wipe out a checkpoint.
 */
export function heartbeatDetails(ctx: Context): unknown {
  return lastDetails.has(ctx) ? lastDetails.get(ctx) : ctx.info.heartbeatDetails;
}

function beat(ctx: Context, details: unknown) {
  lastDetails.set(ctx, details);
  ctx.heartbeat(details);
}

/**
 * Agent sessions that survive their worker. A deploy replaces the worker; each session in it
 * stops after its turn in progress, saved, and hands over (a retryable WorkerShutdown), and the
 * retry on the new worker carries on from that turn. Attempts are counted by how they ended,
 * so handing over never spends one:
 *
 * - an error of the session's own: the next attempt starts over, as before; the third ends the
 *   session (nonretryable), so real failures stay bounded at three attempts;
 * - a worker that vanished (crash, killed before its turn finished; Temporal saw its heartbeat
 *   stop): the next attempt resumes from the last checkpoint; the third loss ends the session;
 * - a handoff: resumes, and costs nothing. Temporal's maximumAttempts is the backstop.
 */
export function withSessionRetries(
  activities: Activities,
  opts: { draining?: AbortSignal } = {},
): Activities {
  return {
    ...activities,
    async runAgent(req) {
      const ctx = Context.current();
      const before = readProgress(ctx.info.heartbeatDetails);
      const lost = ctx.info.attempt - 1 - before.failures - before.handoffs;
      if (lost >= SESSION_ATTEMPTS.losses) {
        const at = before.checkpoint ? ` (it had finished ${turns(before.checkpoint.turn)})` : '';
        throw ApplicationFailure.create({
          type: WORKER_LOST,
          message: `The worker running this session stopped ${lost} times without handing it on${at}: it crashed, or was stopped before its turn finished.`,
          nonRetryable: true,
          details: [{ spent: before.checkpoint?.spent ?? ZERO }],
        });
      }
      const session = new Session(ctx, before, opts.draining ?? NEVER);
      sessions.set(ctx, session);
      session.begin();
      try {
        return await activities.runAgent(req);
      } catch (err) {
        throw session.end(err);
      }
    },
  };
}

class Session implements AgentSession {
  readonly resumeFrom: CheckpointRef | null;
  private progress: SessionProgress;

  constructor(
    private readonly ctx: Context,
    before: SessionProgress,
    readonly draining: AbortSignal,
  ) {
    // After an error of its own the session starts over; after a lost or handed-on attempt it
    // carries on from that attempt's last turn.
    this.resumeFrom = before.ended === 'failed' ? null : before.checkpoint;
    this.progress = {
      v: 1,
      checkpoint: this.resumeFrom,
      failures: before.failures,
      handoffs: before.handoffs,
    };
  }

  get cancelled() {
    return this.ctx.cancellationSignal;
  }

  /** Says at once that this attempt is under way, so if it vanishes it counts as lost. */
  begin() {
    beat(this.ctx, this.progress);
  }

  saved(ref: CheckpointRef | null) {
    this.progress = { ...this.progress, checkpoint: ref };
    beat(this.ctx, this.progress);
  }

  resumable(err: unknown) {
    const how = this.ending(err);
    return how === 'handoff' || how === 'cancelled';
  }

  /** Records how the attempt ended and returns what to throw. */
  end(err: unknown): unknown {
    const how = this.ending(err);
    if (how === 'final') return err;
    if (how === 'cancelled') {
      // Thrown as the cancellation it is, so Temporal records it as one.
      const reason = this.ctx.cancellationSignal.reason;
      return reason instanceof CancelledFailure ? reason : err;
    }
    const p = this.progress;
    if (how === 'handoff') {
      // Failed, not cancelled, so the server retries at once; the heartbeat goes out first.
      beat(this.ctx, { ...p, handoffs: p.handoffs + 1, ended: 'handoff' });
      return ApplicationFailure.create({
        type: WORKER_SHUTDOWN,
        message: `The worker is shutting down; the session carries on from ${p.checkpoint ? `after ${turns(p.checkpoint.turn)}` : 'the start'} on another worker.`,
        nextRetryDelay: '1 second',
      });
    }
    const failures = p.failures + 1;
    if (failures >= SESSION_ATTEMPTS.failures) {
      const app = err instanceof ApplicationFailure ? err : null;
      return ApplicationFailure.create({
        type: app?.type ?? (err instanceof Error ? err.name : 'Error'),
        message: err instanceof Error ? err.message : String(err),
        nonRetryable: true,
        cause: err instanceof Error ? err : undefined,
        // What the session had spent by its last checkpoint, so the budget still counts it.
        details: [{ spent: p.checkpoint?.spent ?? ZERO }],
      });
    }
    beat(this.ctx, { ...p, failures, ended: 'failed' });
    return err;
  }

  private ending(err: unknown): Ending {
    if (err instanceof ApplicationFailure && err.nonRetryable) return 'final';
    // The runner stopped between turns because the worker is draining.
    if (err instanceof Error && err.name === 'SessionStopped') return 'handoff';
    const signal = this.ctx.cancellationSignal;
    if (signal.aborted) {
      const reason = signal.reason as unknown;
      const shutdown =
        this.ctx.cancellationDetails?.workerShutdown ||
        (reason instanceof CancelledFailure && reason.message === 'WORKER_SHUTDOWN');
      return shutdown ? 'handoff' : 'cancelled';
    }
    return 'failed';
  }
}

/** The details an earlier attempt left, or a fresh start for anything else. */
export function readProgress(details: unknown): SessionProgress {
  const d = (details ?? {}) as Partial<Record<keyof SessionProgress, unknown>>;
  const count = (x: unknown) => (Number.isInteger(x) && (x as number) >= 0 ? (x as number) : 0);
  return {
    v: 1,
    checkpoint: isRef(d.checkpoint) ? d.checkpoint : null,
    failures: count(d.failures),
    handoffs: count(d.handoffs),
    ...(d.ended === 'failed' || d.ended === 'handoff' ? { ended: d.ended } : {}),
  };
}

function isRef(x: unknown): x is CheckpointRef {
  const r = x as Partial<CheckpointRef> | null;
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  return (
    !!r &&
    typeof r === 'object' &&
    Array.isArray(r.parts) &&
    r.parts.every((p) => typeof p === 'string') &&
    [r.messages, r.turn, r.stepIndex, r.maxTokens, r.spent?.tokens, r.spent?.usd].every(num)
  );
}

const turns = (n: number) => `${n} turn${n === 1 ? '' : 's'}`;
