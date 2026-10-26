import { fileURLToPath } from 'node:url';
import { Context } from '@temporalio/activity';
import { NativeConnection, Worker } from '@temporalio/worker';
import type { Activities } from './activities';
import { TASK_QUEUE } from './types';

export const WORKFLOWS_PATH = fileURLToPath(new URL('./workflows/index.ts', import.meta.url));

/** Often enough for any heartbeat timeout the workflows set (agent sessions: five minutes). */
const HEARTBEAT_EVERY_MS = 30_000;

/**
 * Every activity heartbeats while it runs. An agent session (a Blueprint, a batch of pages) can
 * work far longer than its heartbeat timeout; the timeout is there to notice a worker that died,
 * which stops heartbeating, not a session that is still working.
 */
export function withHeartbeats(activities: Activities, everyMs = HEARTBEAT_EVERY_MS): Activities {
  return Object.fromEntries(
    Object.entries(activities).map(([name, fn]) => [
      name,
      async (...args: unknown[]) => {
        const ctx = Context.current();
        const timer = setInterval(() => ctx.heartbeat(), everyMs);
        try {
          return await (fn as (...a: unknown[]) => Promise<unknown>).apply(activities, args);
        } finally {
          clearInterval(timer);
        }
      },
    ]),
  ) as unknown as Activities;
}

export async function createWorker(opts: {
  connection: NativeConnection;
  activities: Activities;
  namespace?: string;
  taskQueue?: string;
}): Promise<Worker> {
  return Worker.create({
    connection: opts.connection,
    namespace: opts.namespace ?? 'default',
    taskQueue: opts.taskQueue ?? TASK_QUEUE,
    workflowsPath: WORKFLOWS_PATH,
    activities: withHeartbeats(opts.activities),
  });
}
