import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { anthropicModelClient } from '@lw/agent-runtime';
import type { CreateProject } from '@lw/contracts';
import { openStore, Projections } from '@lw/events';
import { createWorker, defaultPolicy, ProjectCommandsClient, startProject } from '@lw/orchestrator';
import { loadPlaybook } from '@lw/playbook-sdk';
import { Simulation, sitecoreScenario } from '@lw/simulator';
import { composeStack } from '@lw/stack';
import { LocalBlobStore } from '@lw/tool-gateway';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection } from '@temporalio/worker';
import { z } from 'zod';
import { buildApp } from './app';
import { simulationCommands, type ProjectCommands } from './commands';

/**
 * Control API entry point.
 *
 *   ORCHESTRATOR=simulator  scripted projects (default; what the UI prototype runs against)
 *   ORCHESTRATOR=temporal   the real orchestrator. Without TEMPORAL_ADDRESS it starts a local
 *                           Temporal dev server and an in-process worker.
 *
 *   AGENTS=stub | claude    with claude, roles whose tools are all connected run on Claude
 *                           (ANTHROPIC_API_KEY); the rest stay on stub agents
 *
 *   STORE=memory | pglite | postgres   where the event log lives
 *
 * Without AUTH=github it only binds to localhost.
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
    AGENTS: z.enum(['stub', 'claude']).default('stub'),
    AUTH: z.enum(['none', 'github']).default('none'),
    GITHUB_CLIENT_ID: z.string().optional(),
    GITHUB_CLIENT_SECRET: z.string().optional(),
    /** Comma-separated GitHub logins allowed in. */
    OPERATORS: z.string().default(''),
    GITHUB_ORG: z.string().optional(),
    SESSION_SECRET: z.string().optional(),
    /** This API's public URL (for the OAuth callback) and the Control Center's URL. */
    PUBLIC_URL: z.string().url().optional(),
    APP_URL: z.string().url().optional(),
    SIM_SPEED: z.coerce.number().positive().default(1),
    SIM_PROJECTS: z.coerce.number().int().min(0).max(10).default(2),
    PLAYBOOK_DIR: z
      .string()
      .default(fileURLToPath(new URL('../../../playbooks/sitecoreai-migration', import.meta.url))),
  })
  .parse(process.env);

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
if (env.AUTH === 'none' && !LOCAL_HOSTS.has(env.HOST)) {
  throw new Error(
    `Refusing to serve without sign-in on ${env.HOST}. Set AUTH=github, or bind to localhost.`,
  );
}
const auth =
  env.AUTH === 'github'
    ? {
        clientId: required('GITHUB_CLIENT_ID', env.GITHUB_CLIENT_ID),
        clientSecret: required('GITHUB_CLIENT_SECRET', env.GITHUB_CLIENT_SECRET),
        sessionSecret: required('SESSION_SECRET', env.SESSION_SECRET),
        publicUrl: required('PUBLIC_URL', env.PUBLIC_URL),
        appUrl: required('APP_URL', env.APP_URL),
        operators: env.OPERATORS.split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        requiredOrg: env.GITHUB_ORG,
        secureCookies: required('PUBLIC_URL', env.PUBLIC_URL).startsWith('https://'),
      }
    : undefined;
if (auth && !auth.operators.length) throw new Error('AUTH=github needs OPERATORS (GitHub logins).');

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`AUTH=github needs ${name}`);
  return value;
}

const opened = await openStore(env.STORE, { dataDir: env.DATA_DIR, databaseUrl: env.DATABASE_URL });
const { store } = opened;
const projections = new Projections(store);
await projections.start();
const playbook = await loadPlaybook(env.PLAYBOOK_DIR);
const cleanups: (() => Promise<void>)[] = [];
// Shared with the worker's tool servers (one folder in dev; object storage when deployed).
const blobs = new LocalBlobStore(join(env.DATA_DIR, 'blobs'));

let commands: (projectId: string) => ProjectCommands | undefined;
let createProject: (input: CreateProject) => Promise<string>;
const seeds: CreateProject[] = [];

if (env.ORCHESTRATOR === 'simulator') {
  const sims = new Map<string, ProjectCommands>();
  const running: Simulation[] = [];
  const startSimulation = (opts: {
    name: string;
    client: string;
    sourceUrl?: string;
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
  createProject = async (input) =>
    startSimulation({ ...input, autopilot: false, speed: env.SIM_SPEED });
  const SEEDS = [
    {
      name: 'Acme corporate site',
      client: 'Acme Corp',
      sourceUrl: 'https://www.acme.example',
      autopilot: false,
      speedFactor: 1,
    },
    {
      name: 'Northwind marketing site',
      client: 'Northwind',
      sourceUrl: 'https://www.northwind.example',
      autopilot: true,
      speedFactor: 3,
    },
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
    const stack = await composeStack({
      store,
      projections,
      playbook,
      playbookDir: env.PLAYBOOK_DIR,
      dataDir: env.DATA_DIR,
      model: env.AGENTS === 'claude' ? anthropicModelClient() : null,
    });
    console.log(
      stack.liveRoles.length
        ? `Live agents: ${stack.liveRoles.join(', ')}; every other role is a stub.`
        : 'All agents are stubs (AGENTS=claude runs the roles whose tools are connected).',
    );
    const worker = await createWorker({
      connection: await NativeConnection.connect({ address }),
      namespace: env.TEMPORAL_NAMESPACE,
      activities: stack.activities,
    });
    const run = worker.run();
    cleanups.unshift(async () => {
      worker.shutdown();
      await run;
      await stack.close();
    });
  }

  commands = (id) => (projections.get(id) ? new ProjectCommandsClient(client, id) : undefined);
  createProject = async ({ name, client: clientName, sourceUrl }) => {
    const projectId = `prj-${randomUUID().slice(0, 8)}`;
    await startProject(client, {
      projectId,
      name,
      client: clientName,
      site: sourceUrl ? { sourceUrl } : undefined,
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
  artifactContent: async (_projectId, ref) => blobs.get(ref).catch(() => null),
  corsOrigin: env.CORS_ORIGIN,
  auth,
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
