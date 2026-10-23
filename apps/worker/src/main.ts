import { fileURLToPath } from 'node:url';
import { anthropicModelClient, checkModels } from '@lw/agent-runtime';
import { openStore, Projections } from '@lw/events';
import { createWorker } from '@lw/orchestrator';
import { loadPlaybook } from '@lw/playbook-sdk';
import { composeStack } from '@lw/stack';
import { openBlobStore } from '@lw/tool-gateway';
import { NativeConnection } from '@temporalio/worker';
import { z } from 'zod';

/**
 * The orchestration worker as its own process: runs project and task workflows and their
 * activities, writing to the shared Postgres event log the Control API reads. Scale it out by
 * running more copies; Temporal spreads the work. On Vercel it is a Daemon.
 *
 * AGENTS=claude runs every role whose tools are all connected on Claude; the rest stay stubs.
 * Swapping agents is a change of activities only, never of workflows.
 */
const env = z
  .object({
    TEMPORAL_ADDRESS: z.string(),
    TEMPORAL_NAMESPACE: z.string().default('default'),
    /** Temporal Cloud API key; connects over TLS. */
    TEMPORAL_API_KEY: z.string().optional(),
    DATABASE_URL: z.string(),
    /** Direct connection for LISTEN (Neon's pooled DATABASE_URL can't carry it). */
    DATABASE_URL_UNPOOLED: z.string().optional(),
    /** Working files (clones, builds); ephemeral on a Daemon. */
    DATA_DIR: z.string().default('/tmp/launchworks'),
    /** Artifacts and screenshots, shared with the Control API: `local` under DATA_DIR, or Blob. */
    BLOB_STORE: z.enum(['local', 'vercel']).default('local'),
    AGENTS: z.enum(['stub', 'claude']).default('stub'),
    PLAYBOOK_DIR: z
      .string()
      .default(fileURLToPath(new URL('../../../playbooks/sitecoreai-migration', import.meta.url))),
  })
  .parse(process.env);

const opened = await openStore('postgres', {
  dataDir: env.DATA_DIR,
  databaseUrl: env.DATABASE_URL,
  listenUrl: env.DATABASE_URL_UNPOOLED,
});
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
  blobs: openBlobStore(env.BLOB_STORE, env.DATA_DIR),
  model: env.AGENTS === 'claude' ? anthropicModelClient() : null,
});
console.log(`Live agents: ${stack.liveRoles.join(', ') || 'none'}`);
if (env.AGENTS === 'claude') {
  for (const m of await checkModels(playbook.roles.map((r) => r.model.id))) {
    console.log(`Claude ${m.id}: ${m.ok ? `ok (${m.detail})` : `NOT AVAILABLE, ${m.detail}`}`);
  }
}

const connection = await NativeConnection.connect({
  address: env.TEMPORAL_ADDRESS,
  ...(env.TEMPORAL_API_KEY
    ? {
        tls: true,
        apiKey: env.TEMPORAL_API_KEY,
        metadata: { 'temporal-namespace': env.TEMPORAL_NAMESPACE },
      }
    : {}),
}).catch((err: unknown) => {
  console.error(`Temporal: could not connect to ${env.TEMPORAL_ADDRESS}`, err);
  throw err;
});
console.log(`Temporal: connected to ${env.TEMPORAL_ADDRESS}, namespace ${env.TEMPORAL_NAMESPACE}`);

const worker = await createWorker({
  connection,
  namespace: env.TEMPORAL_NAMESPACE,
  activities: stack.activities,
});

// Vercel sends SIGTERM on rollout and gives the grace period to finish; the worker drains.
const stop = () => worker.shutdown();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

await worker.run();
await stack.close();
await opened.close();
