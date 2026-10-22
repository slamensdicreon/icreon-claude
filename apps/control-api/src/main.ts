import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, Projections } from '@lw/events';
import {
  createStubActivities,
  createWorker,
  defaultPolicy,
  loadFixtures,
  ProjectCommandsClient,
  startProject,
} from '@lw/orchestrator';
import { loadPlaybook } from '@lw/playbook-sdk';
import { Simulation, sitecoreScenario } from '@lw/simulator';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection } from '@temporalio/worker';
import { z } from 'zod';
import { buildApp } from './app';
import { simulationCommands, type ProjectCommands } from './commands';

/**
 * Control API entry point.
 *
 *   ORCHESTRATOR=simulator  scripted projects (default; what the UI prototype runs against)
 *   ORCHESTRATOR=temporal   the real orchestrator with stub agents. Without TEMPORAL_ADDRESS it
 *                           starts a local Temporal dev server and an in-process worker.
 *
 *   STORE=memory | pglite | postgres   where the event log lives (see stores.ts)
 *
 * No sign-in yet, so it binds to localhost by default; GitHub sign-in lands before this runs
 * anywhere shared.
 */
const env = z
  .object({
    PORT: z.coerce.number().int().default(4000),
    HOST: z.string().default('127.0.0.1'),
    CORS_ORIGIN: z.string().default('*'),
    ORCHESTRATOR: z.enum(['simulator', 'temporal']).default('simulator'),
    STORE: z.enum(['memory', 'pglite', 'postgres']).default('memory'),
    DATA_DIR: z.string().default(fileURLToPath(new URL('../../../.data', import.meta.url))),
    DATABASE_URL: z.string().optional(),
    TEMPORAL_ADDRESS: z.string().optional(),
    TEMPORAL_NAMESPACE: z.string().default('default'),
    INLINE_WORKER: z.enum(['true', 'false']).default('true'),
    SIM_SPEED: z.coerce.number().positive().default(1),
    SIM_PROJECTS: z.coerce.number().int().min(0).max(10).default(2),
    PLAYBOOK_DIR: z
      .string()
      .default(fileURLToPath(new URL('../../../playbooks/sitecoreai-migration', import.meta.url))),
  })
  .parse(process.env);

const opened = await openStore(env.STORE, { dataDir: env.DATA_DIR, databaseUrl: env.DATABASE_URL });
const { store } = opened;
const projections = new Projections(store);
await projections.start();
const playbook = await loadPlaybook(env.PLAYBOOK_DIR);
const cleanups: (() => Promise<void>)[] = [];

let commands: (projectId: string) => ProjectCommands | undefined;
let createProject: (input: { name: string; client: string }) => Promise<string>;
const seeds: { name: string; client: string }[] = [];

if (env.ORCHESTRATOR === 'simulator') {
  const sims = new Map<string, ProjectCommands>();
  const running: Simulation[] = [];
  const startSimulation = (opts: {
    name: string;
    client: string;
    autopilot: boolean;
    speed: number;
  }) => {
    const projectId = `prj-${randomUUID().slice(0, 8)}`;
    const sim = new Simulation(store, playbook, { projectId, ...opts, seed: running.length + 1 });
    sims.set(projectId, simulationCommands(sim));
    running.push(sim);
    void sim
      .run(sitecoreScenario)
      .catch((err) => console.error('simulation failed', projectId, err));
    return projectId;
  };
  commands = (id) => sims.get(id);
  createProject = async ({ name, client }) =>
    startSimulation({ name, client, autopilot: false, speed: env.SIM_SPEED });
  const SEEDS = [
    { name: 'Acme corporate site', client: 'Acme Corp', autopilot: false, speedFactor: 1 },
    { name: 'Northwind marketing site', client: 'Northwind', autopilot: true, speedFactor: 3 },
  ];
  for (const s of SEEDS.slice(0, env.SIM_PROJECTS)) {
    startSimulation({ ...s, speed: env.SIM_SPEED * s.speedFactor });
  }
  cleanups.push(async () => running.forEach((s) => s.stop()));
} else {
  let address = env.TEMPORAL_ADDRESS;
  if (!address) {
    // Dev convenience: a local Temporal dev server, persisted next to the event log.
    const { TestWorkflowEnvironment } = await import('@temporalio/testing');
    const local = await TestWorkflowEnvironment.createLocal({
      server: { dbFilename: join(env.DATA_DIR, 'temporal.db'), ui: false },
    });
    address = local.address;
    cleanups.push(() => local.teardown());
    console.log(`Local Temporal dev server on ${address}`);
  }
  const client = new Client({
    connection: await Connection.connect({ address }),
    namespace: env.TEMPORAL_NAMESPACE,
  });

  if (env.INLINE_WORKER === 'true') {
    const { blueprint, outputs } = await loadFixtures(env.PLAYBOOK_DIR);
    const worker = await createWorker({
      connection: await NativeConnection.connect({ address }),
      namespace: env.TEMPORAL_NAMESPACE,
      activities: createStubActivities({ store, playbook, blueprint, outputs }),
    });
    const run = worker.run();
    cleanups.unshift(async () => {
      worker.shutdown();
      await run;
    });
  }

  commands = (id) => (projections.get(id) ? new ProjectCommandsClient(client, id) : undefined);
  createProject = async ({ name, client: clientName }) => {
    const projectId = `prj-${randomUUID().slice(0, 8)}`;
    await startProject(client, {
      projectId,
      name,
      client: clientName,
      playbook,
      policy: defaultPolicy(playbook),
    });
    return projectId;
  };
  if (!(await store.projectIds()).length) {
    seeds.push({ name: 'Acme corporate site', client: 'Acme Corp' });
  }
}

const app = await buildApp({
  store,
  projections,
  commands,
  createProject,
  corsOrigin: env.CORS_ORIGIN,
  logger: true,
});

for (const s of seeds) await createProject(s);

const shutdown = async () => {
  await app.close();
  for (const c of cleanups) await c();
  await opened.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: env.PORT, host: env.HOST });
