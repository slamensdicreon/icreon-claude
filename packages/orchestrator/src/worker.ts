import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';
import type { Activities } from './activities';
import { TASK_QUEUE } from './types';

export const WORKFLOWS_PATH = fileURLToPath(new URL('./workflows/index.ts', import.meta.url));

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
    activities: opts.activities,
  });
}
