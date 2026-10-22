import { randomUUID } from 'node:crypto';
import { CommandError } from '@lw/domain';
import type { Listen, SqlClient } from './postgres';

export interface CommandRequest {
  id: string;
  projectId: string;
  method: string;
  args: unknown[];
}

/** Runs one command. Throw CommandError to refuse it; the sender gets the same refusal. */
export type CommandHandler = (req: CommandRequest) => Promise<unknown>;

interface StoredError {
  status?: CommandError['status'];
  code?: string;
  message: string;
}

const CHANNEL = 'lw_commands';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Director commands for a runner in another process, over the shared Postgres. The API sends from
 * request-driven instances; the runner (the demo on a daemon) holds the projects in memory and
 * runs them. A row per command keeps it simple to inspect and safe across restarts: a command
 * nobody picks up in time is withdrawn, never run late.
 */
export class CommandBus {
  constructor(
    private readonly sql: SqlClient,
    private readonly opts: { timeoutMs?: number } = {},
  ) {}

  /** Sends one command and waits for its outcome. A refusal comes back as the same CommandError. */
  async send(projectId: string, method: string, args: unknown[]): Promise<unknown> {
    const id = randomUUID();
    await this.sql.query(
      'INSERT INTO lw_commands (id, project_id, method, args) VALUES ($1, $2, $3, $4::jsonb)',
      [id, projectId, method, JSON.stringify(args)],
    );
    await this.sql.query('SELECT pg_notify($1, $2)', [CHANNEL, id]);
    const deadline = Date.now() + (this.opts.timeoutMs ?? 15_000);
    let wait = 20;
    for (;;) {
      const { rows } = await this.sql.query<{
        status: string;
        result: unknown;
        error: StoredError | null;
      }>('SELECT status, result, error FROM lw_commands WHERE id = $1', [id]);
      const row = rows[0];
      if (row?.status === 'done') return row.result ?? undefined;
      if (row?.status === 'failed') {
        const e = row.error ?? { message: 'The project runner failed the command.' };
        throw e.status && e.code
          ? new CommandError(e.status, e.code, e.message)
          : new Error(e.message);
      }
      if (Date.now() > deadline) {
        // Withdraw it if nobody took it, so a runner that comes back later can't act on it.
        const { rows: withdrawn } = await this.sql.query(
          `UPDATE lw_commands SET status = 'expired', done_at = now()
            WHERE id = $1 AND status = 'pending' RETURNING id`,
          [id],
        );
        throw new CommandError(
          503,
          'runner_unavailable',
          withdrawn.length
            ? 'The project runner did not pick up the command. It may be restarting: try again in a minute.'
            : 'The project runner took the command but has not finished it. Check Activity before you try again.',
        );
      }
      await sleep(wait);
      wait = Math.min(wait * 2, 200);
    }
  }

  /**
   * Runs commands one at a time, oldest first, until `signal` aborts. With `listen`, a new command
   * wakes the loop at once; without, it polls.
   */
  async serve(
    handler: CommandHandler,
    opts: { signal: AbortSignal; listen?: Listen; maxAgeMs?: number; pollMs?: number },
  ): Promise<void> {
    let wake = () => {};
    const unlisten = opts.listen ? await opts.listen(CHANNEL, () => wake()) : null;
    opts.signal.addEventListener('abort', () => wake(), { once: true });
    let swept = 0;
    while (!opts.signal.aborted) {
      if (Date.now() - swept > 10_000) {
        await this.sweep(opts.maxAgeMs ?? 60_000);
        swept = Date.now();
      }
      const job = await this.claim();
      if (!job) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, opts.pollMs ?? 500);
          wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
        continue;
      }
      try {
        const result = await handler(job);
        await this.sql.query(
          `UPDATE lw_commands SET status = 'done', result = $2::jsonb, done_at = now() WHERE id = $1`,
          [job.id, JSON.stringify(result ?? null)],
        );
      } catch (err) {
        const error: StoredError =
          err instanceof CommandError
            ? { status: err.status, code: err.code, message: err.message }
            : { message: err instanceof Error ? err.message : String(err) };
        await this.sql.query(
          `UPDATE lw_commands SET status = 'failed', error = $2::jsonb, done_at = now() WHERE id = $1`,
          [job.id, JSON.stringify(error)],
        );
      }
    }
    await unlisten?.();
  }

  private async claim(): Promise<CommandRequest | null> {
    const { rows } = await this.sql.query<{
      id: string;
      project_id: string;
      method: string;
      args: unknown[];
    }>(
      `UPDATE lw_commands SET status = 'running'
        WHERE id = (SELECT id FROM lw_commands WHERE status = 'pending'
                     ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING id, project_id, method, args`,
    );
    const r = rows[0];
    return r ? { id: r.id, projectId: r.project_id, method: r.method, args: r.args } : null;
  }

  /** Withdraws commands that waited out a restart, and forgets finished ones after a day. */
  private async sweep(maxAgeMs: number): Promise<void> {
    await this.sql.query(
      `UPDATE lw_commands SET status = 'expired', done_at = now()
        WHERE status = 'pending' AND created_at < now() - make_interval(secs => $1)`,
      [maxAgeMs / 1000],
    );
    await this.sql.query(`DELETE FROM lw_commands WHERE done_at < now() - interval '1 day'`);
  }
}
