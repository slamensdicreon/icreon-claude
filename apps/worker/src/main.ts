import { fileURLToPath } from 'node:url';
import { openStore } from '@lw/events';
import { createStubActivities, createWorker, loadFixtures } from '@lw/orchestrator';
import { loadPlaybook } from '@lw/playbook-sdk';
import { NativeConnection } from '@temporalio/worker';
import { z } from 'zod';

/**
 * The orchestration worker as its own process: runs project and task workflows and their
 * activities, writing to the shared Postgres event log the Control API reads. Scale it out by
 * running more copies; Temporal spreads the work.
 *
 * Agents are stubs until the agent runtime lands (M3); swapping them is a change of activities
 * only, not of workflows.
 */
const env = z
  .object({
    TEMPORAL_ADDRESS: z.string(),
    TEMPORAL_NAMESPACE: z.string().default('default'),
    DATABASE_URL: z.string(),
    PLAYBOOK_DIR: z
      .string()
      .default(fileURLToPath(new URL('../../../playbooks/sitecoreai-migration', import.meta.url))),
  })
  .parse(process.env);

const opened = await openStore('postgres', { dataDir: '', databaseUrl: env.DATABASE_URL });
const playbook = await loadPlaybook(env.PLAYBOOK_DIR);
const { blueprint, outputs } = await loadFixtures(env.PLAYBOOK_DIR);

const worker = await createWorker({
  connection: await NativeConnection.connect({ address: env.TEMPORAL_ADDRESS }),
  namespace: env.TEMPORAL_NAMESPACE,
  activities: createStubActivities({ store: opened.store, playbook, blueprint, outputs }),
});

const stop = () => worker.shutdown();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

await worker.run();
await opened.close();
