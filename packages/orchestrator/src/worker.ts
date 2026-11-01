import { fileURLToPath } from 'node:url';
import { Context } from '@temporalio/activity';
import {
  bundleWorkflowCode,
  NativeConnection,
  Worker,
  type WorkflowBundleWithSourceMap,
} from '@temporalio/worker';
import type { Activities } from './activities';
import { TASK_QUEUE } from './types';

export const WORKFLOWS_PATH = fileURLToPath(new URL('./workflows/index.ts', import.meta.url));

let bundled: Promise<WorkflowBundleWithSourceMap> | null = null;

/**
 * The workflow code, bundled once per process: every project's worker runs the same workflows,
 * and bundling them is the slow part of starting a worker.
 */
export function workflowBundle(): Promise<WorkflowBundleWithSourceMap> {
  bundled ??= bundleWorkflowCode({ workflowsPath: WORKFLOWS_PATH }).catch((err: unknown) => {
    bundled = null;
    throw err;
  });
  return bundled;
}

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
    workflowBundle: await workflowBundle(),
    activities: withHeartbeats(opts.activities),
  });
}
