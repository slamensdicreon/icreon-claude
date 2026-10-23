import { fileURLToPath } from 'node:url';
import { CommandError } from '@lw/domain';
import { CommandBus, openStore, verifiedTls } from '@lw/events';
import { loadPlaybook } from '@lw/playbook-sdk';
import { DEMO_SCENARIOS, demoProjectId, startDemo } from '@lw/simulator';
import { openBlobStore } from '@lw/tool-gateway';
import pg from 'pg';
import { z } from 'zod';
import { demoCommands, dispatch, type ProjectCommands } from './commands';

/**
 * The demo runner: plays the prototype's two projects into the shared Postgres log and runs the
 * Director's commands for them off the command bus. It is the long-running half of
 * ORCHESTRATOR=simulator when the API runs on request-driven instances (DEMO_RUNNER=separate):
 * on Vercel, a Daemon with exactly one instance.
 *
 * Each start reseeds the demo projects, so the demo always opens on the prototype's story. A
 * project started from intake runs here too, until the runner restarts.
 *
 * Only one runner may play at a time. It holds a Postgres advisory lock for its whole life; a
 * second copy (a rollout overlapping the old instance) waits for the lock before it touches the
 * log.
 */
const env = z
  .object({
    DATABASE_URL: z.string(),
    /** Direct connection for LISTEN and the lock; Neon's pooled URL can't hold either. */
    DATABASE_URL_UNPOOLED: z.string().optional(),
    BLOB_STORE: z.enum(['local', 'vercel']).default('local'),
    DATA_DIR: z.string().default('/tmp/launchworks'),
    SIM_SPEED: z.coerce.number().positive().default(1),
    PLAYBOOK_DIR: z
      .string()
      .default(fileURLToPath(new URL('../../../playbooks/sitecoreai-migration', import.meta.url))),
  })
  .parse(process.env);

const direct = env.DATABASE_URL_UNPOOLED ?? env.DATABASE_URL;

const lock = new pg.Client({ connectionString: verifiedTls(direct) });
await lock.connect();
lock.on('error', (err) => {
  // Losing the lock's connection means another runner may start: stop rather than both play.
  console.error('Demo runner lost its lock connection; exiting so the platform restarts it', err);
  process.exit(1);
});
console.log('Demo runner waiting for the runner lock');
await lock.query(`SELECT pg_advisory_lock(hashtext('launchworks.demo-runner'))`);
console.log('Demo runner holds the lock');

const opened = await openStore('postgres', {
  dataDir: env.DATA_DIR,
  databaseUrl: env.DATABASE_URL,
  listenUrl: direct,
});
const { store } = opened;
const playbook = await loadPlaybook(env.PLAYBOOK_DIR);
const blobs = openBlobStore(env.BLOB_STORE, env.DATA_DIR);

for (const def of DEMO_SCENARIOS) await store.reset(demoProjectId(def));
const demos = await startDemo(store, playbook, blobs, { speed: env.SIM_SPEED });
const projects = new Map<string, ProjectCommands>(demos.map((d) => [d.projectId, demoCommands(d)]));
console.log(`Demo projects running: ${demos.map((d) => d.projectId).join(', ')}`);

const stop = new AbortController();
const bus = new CommandBus(opened.sql!);
const serving = bus.serve(
  async (req) => {
    const cmds = projects.get(req.projectId);
    if (!cmds) {
      throw new CommandError(
        409,
        'project_stopped',
        'This simulated project stopped when the demo runner restarted. It is a leftover from the old intake and can no longer take commands.',
      );
    }
    return dispatch(cmds, req);
  },
  { signal: stop.signal, listen: opened.listen ?? undefined },
);

const shutdown = async () => {
  console.log('Demo runner stopping');
  stop.abort();
  await serving;
  for (const d of demos) d.stop();
  await opened.close();
  await lock.end();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
