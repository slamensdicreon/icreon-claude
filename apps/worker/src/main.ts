import { fileURLToPath } from 'node:url';
import { anthropicModelClient } from '@lw/agent-runtime';
import { openStore, Projections } from '@lw/events';
import { createWorker } from '@lw/orchestrator';
import { loadPlaybook } from '@lw/playbook-sdk';
import { composeStack } from '@lw/stack';
import { NativeConnection } from '@temporalio/worker';
import { z } from 'zod';

/**
 * The orchestration worker as its own process: runs project and task workflows and their
 * activities, writing to the shared Postgres event log the Control API reads. Scale it out by
 * running more copies; Temporal spreads the work.
 *
 * AGENTS=claude runs every role whose tools are all connected on Claude; the rest stay stubs.
 * Swapping agents is a change of activities only, never of workflows.
 */
const env = z
  .object({
    TEMPORAL_ADDRESS: z.string(),
    TEMPORAL_NAMESPACE: z.string().default('default'),
    DATABASE_URL: z.string(),
    /** Blobs (artifacts, screenshots) go under `${DATA_DIR}/blobs`; object storage when deployed. */
    DATA_DIR: z.string(),
    AGENTS: z.enum(['stub', 'claude']).default('stub'),
    PLAYBOOK_DIR: z
      .string()
      .default(fileURLToPath(new URL('../../../playbooks/sitecoreai-migration', import.meta.url))),
  })
  .parse(process.env);

const opened = await openStore('postgres', { dataDir: '', databaseUrl: env.DATABASE_URL });
// Tool servers read per-project facts (the source site) from the read models.
const projections = new Projections(opened.store);
await projections.start();
const playbook = await loadPlaybook(env.PLAYBOOK_DIR);

const stack = await composeStack({
  store: opened.store,
  projections,
  playbook,
  playbookDir: env.PLAYBOOK_DIR,
  dataDir: env.DATA_DIR,
  model: env.AGENTS === 'claude' ? anthropicModelClient() : null,
});
console.log(`Live agents: ${stack.liveRoles.join(', ') || 'none'}`);

const worker = await createWorker({
  connection: await NativeConnection.connect({ address: env.TEMPORAL_ADDRESS }),
  namespace: env.TEMPORAL_NAMESPACE,
  activities: stack.activities,
});

const stop = () => worker.shutdown();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

await worker.run();
await stack.close();
await opened.close();
