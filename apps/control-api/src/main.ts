import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { anthropicModelClient } from '@lw/agent-runtime';
import type { CreateProject } from '@lw/contracts';
import { CommandBus, openStore, Projections } from '@lw/events';
import { createWorker, defaultPolicy, ProjectCommandsClient, startProject } from '@lw/orchestrator';
import { loadPlaybook } from '@lw/playbook-sdk';
import { Simulation, sitecoreScenario, startDemo } from '@lw/simulator';
import { composeStack } from '@lw/stack';
import { openBlobStore } from '@lw/tool-gateway';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection } from '@temporalio/worker';
import { z } from 'zod';
import { buildApp } from './app';
import { policyRows } from './policy';
import { demoCommands, remoteCommands, simulationCommands, type ProjectCommands } from './commands';

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
 *   DEMO_RUNNER=inline | separate   with the simulator, where the demo projects play: in this
 *                           process, or in the demo runner (src/demo-runner.ts) with commands
 *                           sent over Postgres. Separate is how it runs on Vercel, where this
 *                           API is a request-driven Function and the runner a Daemon.
 *
 * Without AUTH=github it only binds to localhost. Deployment settings are described in
 * docs/deploy/vercel.md.
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
    /** Direct connection for LISTEN (Neon's pooled DATABASE_URL can't carry it). */
    DATABASE_URL_UNPOOLED: z.string().optional(),
    /** Follow the log with LISTEN. Off on request-driven instances: reads catch up instead. */
    LISTEN: z.enum(['true', 'false']).default('true'),
    /** Fold every project at start (eager) or each on first use (lazy, for short-lived instances). */
    PROJECTIONS: z.enum(['eager', 'lazy']).default('eager'),
    /** How often an event stream reads the log, and when it ends itself (before a time limit). */
    STREAM_POLL_MS: z.coerce.number().int().positive().default(2000),
    STREAM_MAX_SECONDS: z.coerce.number().int().positive().optional(),
    DEMO_RUNNER: z.enum(['inline', 'separate']).default('inline'),
    /** Where artifacts and screenshots live. Default: memory for the in-memory demo, else local. */
    BLOB_STORE: z.enum(['memory', 'local', 'vercel']).optional(),
    TEMPORAL_ADDRESS: z.string().optional(),
    TEMPORAL_NAMESPACE: z.string().default('default'),
    /** Temporal Cloud API key; connects over TLS. */
    TEMPORAL_API_KEY: z.string().optional(),
    INLINE_WORKER: z.enum(['true', 'false']).default('true'),
    AGENTS: z.enum(['stub', 'claude']).default('stub'),
    AUTH: z.enum(['none', 'github']).default('none'),
    /**
     * Allow AUTH=none on a non-local HOST. Only for a container whose port is published to
     * 127.0.0.1 (compose.yaml); never on a reachable host.
     */
    INSECURE_NO_AUTH: z.enum(['true', 'false']).default('false'),
    GITHUB_CLIENT_ID: z.string().optional(),
    GITHUB_CLIENT_SECRET: z.string().optional(),
    /** Comma-separated GitHub logins allowed in. */
    OPERATORS: z.string().default(''),
    GITHUB_ORG: z.string().optional(),
    SESSION_SECRET: z.string().optional(),
    /** This API's public URL (for the OAuth callback) and the Control Center's URL. */
    PUBLIC_URL: z.string().url().optional(),
    APP_URL: z.string().url().optional(),
    /** Set by Vercel: the production domain and this deployment's own hosts. */
    VERCEL_PROJECT_PRODUCTION_URL: z.string().optional(),
    VERCEL_URL: z.string().optional(),
    VERCEL_BRANCH_URL: z.string().optional(),
    SIM_SPEED: z.coerce.number().positive().default(1),
    /** Scripted engagements to run beside the two demo projects (intake adds more). */
    SIM_PROJECTS: z.coerce.number().int().min(0).max(10).default(0),
    PLAYBOOK_DIR: z
      .string()
      .default(fileURLToPath(new URL('../../../playbooks/sitecoreai-migration', import.meta.url))),
  })
  .parse(process.env);

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
if (env.AUTH === 'none' && !LOCAL_HOSTS.has(env.HOST) && env.INSECURE_NO_AUTH !== 'true') {
  throw new Error(
    `Refusing to serve without sign-in on ${env.HOST}. Set AUTH=github, or bind to localhost.`,
  );
}
// On Vercel the web app and this API share the production domain, so both URLs default to it.
const productionUrl = env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`
  : undefined;
const publicUrl = env.PUBLIC_URL ?? productionUrl;
const appUrl = env.APP_URL ?? publicUrl;
// Commands may also come from this deployment's own URLs (a preview, a branch alias).
const extraOrigins = [env.VERCEL_URL, env.VERCEL_BRANCH_URL]
  .filter((h): h is string => Boolean(h))
  .map((h) => `https://${h}`);

const auth =
  env.AUTH === 'github'
    ? {
        clientId: required('GITHUB_CLIENT_ID', env.GITHUB_CLIENT_ID),
        clientSecret: required('GITHUB_CLIENT_SECRET', env.GITHUB_CLIENT_SECRET),
        sessionSecret: required('SESSION_SECRET', env.SESSION_SECRET),
        publicUrl: required('PUBLIC_URL', publicUrl),
        appUrl: required('APP_URL', appUrl),
        operators: env.OPERATORS.split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        requiredOrg: env.GITHUB_ORG,
        secureCookies: required('PUBLIC_URL', publicUrl).startsWith('https://'),
      }
    : undefined;
if (auth && !auth.operators.length) throw new Error('AUTH=github needs OPERATORS (GitHub logins).');

function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`AUTH=github needs ${name}`);
  return value;
}

const opened = await openStore(env.STORE, {
  dataDir: env.DATA_DIR,
  databaseUrl: env.DATABASE_URL,
  listenUrl: env.DATABASE_URL_UNPOOLED,
  listen: env.LISTEN === 'true',
});
const { store } = opened;
const projections = new Projections(store);
await projections.start({ eager: env.PROJECTIONS === 'eager' });
const playbook = await loadPlaybook(env.PLAYBOOK_DIR);
const cleanups: (() => Promise<void>)[] = [];
// Shared with the worker's tool servers (one folder in dev; object storage when deployed). The
// demo projects keep theirs in memory, with the event log.
const blobs = openBlobStore(
  env.BLOB_STORE ??
    (env.ORCHESTRATOR === 'simulator' && env.STORE === 'memory' ? 'memory' : 'local'),
  env.DATA_DIR,
);

let commands: (projectId: string) => ProjectCommands | undefined;
let createProject: (input: CreateProject) => Promise<string>;
const seeds: CreateProject[] = [];

if (env.ORCHESTRATOR === 'simulator' && env.DEMO_RUNNER === 'separate') {
  // The demo plays in the demo runner; this process only sends it commands.
  if (!opened.sql) throw new Error('DEMO_RUNNER=separate needs STORE=postgres');
  const bus = new CommandBus(opened.sql);
  commands = (id) => (projections.get(id) ? remoteCommands(bus, id) : undefined);
  createProject = async (input) => (await bus.send('*', 'createProject', [input])) as string;
} else if (env.ORCHESTRATOR === 'simulator') {
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
  // The prototype's two projects, played through the real API.
  const demos = await startDemo(store, playbook, blobs, { speed: env.SIM_SPEED });
  for (const d of demos) sims.set(d.projectId, demoCommands(d));
  cleanups.push(async () => demos.forEach((d) => d.stop()));
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
  if (!address && env.INLINE_WORKER === 'false') {
    throw new Error('ORCHESTRATOR=temporal with INLINE_WORKER=false needs TEMPORAL_ADDRESS.');
  }
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
  const cloud = env.TEMPORAL_API_KEY
    ? {
        tls: true,
        apiKey: env.TEMPORAL_API_KEY,
        metadata: { 'temporal-namespace': env.TEMPORAL_NAMESPACE },
      }
    : {};
  const client = new Client({
    connection: await Connection.connect({ address, ...cloud }),
    namespace: env.TEMPORAL_NAMESPACE,
  });

  if (env.INLINE_WORKER === 'true') {
    const stack = await composeStack({
      store,
      projections,
      playbook,
      playbookDir: env.PLAYBOOK_DIR,
      dataDir: env.DATA_DIR,
      blobs,
      model: env.AGENTS === 'claude' ? anthropicModelClient() : null,
    });
    console.log(
      stack.liveRoles.length
        ? `Live agents: ${stack.liveRoles.join(', ')}; every other role is a stub.`
        : 'All agents are stubs (AGENTS=claude runs the roles whose tools are connected).',
    );
    const worker = await createWorker({
      connection: await NativeConnection.connect({ address, ...cloud }),
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
  // A sample project for local runs only: deployed instances start cold and in parallel.
  if (env.INLINE_WORKER === 'true' && !(await store.projectIds()).length) {
    seeds.push({ name: 'Acme corporate site', client: 'Acme Corp' });
  }
}

const app = await buildApp({
  store,
  projections,
  commands,
  createProject,
  artifactContent: async (_projectId, ref) => blobs.get(ref).catch(() => null),
  policyDefaults: () => policyRows(playbook),
  corsOrigin: env.CORS_ORIGIN,
  auth,
  extraOrigins,
  stream: {
    pollMs: env.STREAM_POLL_MS,
    maxMs: env.STREAM_MAX_SECONDS ? env.STREAM_MAX_SECONDS * 1000 : null,
  },
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
