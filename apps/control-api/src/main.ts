import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { anthropicModelClient, draftRule } from '@lw/agent-runtime';
import {
  CommandBus,
  masterKey,
  MemoryIntegrationStore,
  MemoryVault,
  openStore,
  PostgresIntegrationStore,
  PostgresRuleStore,
  MemoryRuleStore,
  PostgresVault,
  Projections,
  type SecretVault,
} from '@lw/events';
import { CommandError } from '@lw/domain';
import {
  createWorker,
  defaultPolicy,
  ProjectCommandsClient,
  startProject,
  stopProject,
} from '@lw/orchestrator';
import { loadCatalog } from '@lw/playbook-sdk';
import { createPlatforms } from '@lw/platforms';
import { RETIRED_DEMO_PROJECTS, Simulation, sitecoreScenario, startDemo } from '@lw/simulator';
import { composeStack } from '@lw/stack';
import { openBlobStore } from '@lw/tool-gateway';
import { Client, Connection } from '@temporalio/client';
import { NativeConnection } from '@temporalio/worker';
import { z } from 'zod';
import { buildApp, type WorkerHeartbeat } from './app';
import { GithubApp } from '@lw/connectors';
import { IntakeService, type StartInput } from './intake';
import { SITECORE_DEFAULTS } from '@lw/connectors';
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
    /** Seals project credentials (32 bytes, base64). The previous key stays readable after rotation. */
    CREDENTIALS_KEY: z.string().optional(),
    CREDENTIALS_KEY_PREVIOUS: z.string().optional(),
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
    /** `login:sha256hex` pairs, comma-separated: operator API keys, stored as hashes only. */
    OPERATOR_API_KEYS: z.string().default(''),
    GITHUB_ORG: z.string().optional(),
    SESSION_SECRET: z.string().optional(),
    /** This API's public URL (for the OAuth callback) and the Control Center's URL. */
    PUBLIC_URL: z.string().url().optional(),
    APP_URL: z.string().url().optional(),
    /** Create the GitHub App under this organization instead of the signed-in operator's account. */
    GITHUB_APP_ORG: z.string().optional(),
    /** Our GitHub organization, where projects' build repositories are created. */
    GITHUB_BUILD_ORG: z.string().optional(),
    /** Set by Vercel: the production domain and this deployment's own hosts. */
    VERCEL_PROJECT_PRODUCTION_URL: z.string().optional(),
    VERCEL_URL: z.string().optional(),
    VERCEL_BRANCH_URL: z.string().optional(),
    SIM_SPEED: z.coerce.number().positive().default(1),
    /** Scripted engagements to run beside the demo project (intake adds more). */
    SIM_PROJECTS: z.coerce.number().int().min(0).max(10).default(0),
    /** Every folder under it holding a playbook.yaml is a playbook new projects can run. */
    PLAYBOOKS_DIR: z
      .string()
      .default(fileURLToPath(new URL('../../../playbooks', import.meta.url))),
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
        apiKeys: env.OPERATOR_API_KEYS.split(',')
          .map((s) => s.trim().split(':'))
          .filter((p): p is [string, string] => p.length === 2 && /^[0-9a-f]{64}$/i.test(p[1]!))
          .map(([login, sha256]) => ({ login, sha256 })),
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
const catalog = await loadCatalog(env.PLAYBOOKS_DIR);
const platforms = createPlatforms({ sitecore: SITECORE_DEFAULTS });
// The scripted demo, the simulator and the local sample project run the SitecoreAI build.
const DEFAULT_PLAYBOOK = 'sitecoreai-migration';
const { playbook, dir: playbookDir } = catalog.get(DEFAULT_PLAYBOOK) ?? [...catalog.values()][0]!;
const playbookOf = (id: string | undefined) =>
  catalog.get(id ?? DEFAULT_PLAYBOOK)?.playbook ?? playbook;
const cleanups: (() => Promise<void>)[] = [];
// Shared with the worker's tool servers (one folder in dev; object storage when deployed). The
// demo projects keep theirs in memory, with the event log.
const blobs = openBlobStore(
  env.BLOB_STORE ??
    (env.ORCHESTRATOR === 'simulator' && env.STORE === 'memory' ? 'memory' : 'local'),
  env.DATA_DIR,
);

let commands: (projectId: string) => ProjectCommands | undefined;
/** Starts a project the New Project wizard recorded; only a real orchestrator can. */
let start: ((input: StartInput) => Promise<void>) | undefined;
/** Stops a project's run for good, for a reset; only a real orchestrator has one. */
let stop: ((projectId: string) => Promise<void>) | undefined;
let seedSample: (() => Promise<void>) | null = null;

if (env.ORCHESTRATOR === 'simulator' && env.DEMO_RUNNER === 'separate') {
  // The demo plays in the demo runner; this process only sends it commands.
  if (!opened.sql) throw new Error('DEMO_RUNNER=separate needs STORE=postgres');
  const bus = new CommandBus(opened.sql);
  commands = (id) => (projections.get(id) ? remoteCommands(bus, id) : undefined);
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
  // The demo project, played through the real API.
  for (const id of RETIRED_DEMO_PROJECTS) await store.reset(id);
  const demos = await startDemo(store, playbook, blobs, { speed: env.SIM_SPEED });
  for (const d of demos) sims.set(d.projectId, demoCommands(d));
  cleanups.push(async () => demos.forEach((d) => d.stop()));
  commands = (id) => sims.get(id);
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
  // Lazy: an unreachable Temporal must not stop the API answering. Commands and Start fail with
  // the cause instead; the check below puts it in the log at once.
  const client = new Client({
    connection: Connection.lazy({ address, ...cloud }),
    namespace: env.TEMPORAL_NAMESPACE,
  });
  void client.workflowService
    .describeNamespace({ namespace: env.TEMPORAL_NAMESPACE })
    .then(() =>
      console.log(`Temporal: namespace ${env.TEMPORAL_NAMESPACE} reachable at ${address}`),
    )
    .catch((err: unknown) =>
      console.error(
        `Temporal: namespace ${env.TEMPORAL_NAMESPACE} not reachable at ${address}`,
        err,
      ),
    );

  if (env.INLINE_WORKER === 'true') {
    const stack = await composeStack({
      store,
      projections,
      playbook,
      playbookDir,
      platform: platforms.get(playbook.manifest.platform)!,
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

  // Demo projects still play in the demo runner beside real ones, when there is one.
  const demo = env.DEMO_RUNNER === 'separate' && opened.sql ? new CommandBus(opened.sql) : null;
  commands = (id) => {
    const s = projections.get(id);
    if (!s) return undefined;
    if (s.mode === 'demo') return demo ? remoteCommands(demo, id) : undefined;
    return new ProjectCommandsClient(client, id);
  };
  start = async (input) => {
    await startProject(client, {
      projectId: input.projectId,
      name: input.name,
      client: input.client,
      site: { sourceUrl: input.sourceUrl },
      playbook: playbookOf(input.playbookId),
      policy: {
        ...defaultPolicy(playbookOf(input.playbookId)),
        budgets: input.budgets,
        features: input.features,
      },
      registered: true,
    });
  };
  stop = (projectId) => stopProject(client, projectId, 'Reset by the Director');
  // A sample project for local runs only: deployed instances start cold and in parallel.
  if (env.INLINE_WORKER === 'true' && !(await store.projectIds()).length) {
    seedSample = async () => {
      await startProject(client, {
        projectId: `prj-${randomUUID().slice(0, 8)}`,
        name: 'Acme corporate site',
        client: 'Acme Corp',
        playbook,
        policy: defaultPolicy(playbook),
      });
    };
  }
}

/**
 * Where project credentials are sealed. A shared database needs CREDENTIALS_KEY (32 bytes,
 * base64); without it, intake still checks credentials but refuses to store them. The in-memory
 * store gets an in-memory vault, lost on restart like the store.
 */
function openVault(): SecretVault {
  if (env.CREDENTIALS_KEY && opened.sql) {
    const keys = [
      env.CREDENTIALS_KEY,
      ...(env.CREDENTIALS_KEY_PREVIOUS ? [env.CREDENTIALS_KEY_PREVIOUS] : []),
    ];
    return new PostgresVault(opened.sql, keys.map(masterKey));
  }
  if (env.STORE === 'memory') return new MemoryVault();
  const refuse = async (): Promise<never> => {
    throw new CommandError(
      503,
      'vault_unconfigured',
      'Credentials can be checked but not stored: CREDENTIALS_KEY is not set on the server.',
    );
  };
  return { seal: refuse, open: refuse };
}

const vault = openVault();
// The GitHub App's keys are sealed in the vault, so it is offered only where the vault can keep
// them: GitHub hands the keys over exactly once.
const integrations =
  opened.sql && env.CREDENTIALS_KEY
    ? new PostgresIntegrationStore(opened.sql)
    : env.STORE === 'memory'
      ? new MemoryIntegrationStore()
      : null;
// Rules live in the database beside the event log; the memory store keeps them for local runs.
const rules = opened.sql
  ? new PostgresRuleStore(opened.sql)
  : env.STORE === 'memory'
    ? new MemoryRuleStore()
    : undefined;
const github = integrations
  ? new GithubApp({
      integrations,
      vault,
      publicUrl: publicUrl ?? `http://localhost:${env.PORT}`,
      appUrl: appUrl ?? 'http://localhost:5173',
      owner: env.GITHUB_APP_ORG ? { kind: 'org', org: env.GITHUB_APP_ORG } : { kind: 'user' },
    })
  : undefined;

const app = await buildApp({
  store,
  projections,
  commands,
  intake: new IntakeService({
    store,
    catalog,
    platforms,
    vault,
    start,
    stop,
    blobs,
    github,
    buildOrg: env.GITHUB_BUILD_ORG,
    connections: integrations ?? undefined,
  }),
  github,
  artifactContent: async (_projectId, ref) => blobs.get(ref).catch(() => null),
  policyDefaults: (projectId) => policyRows(playbookOf(projections.get(projectId)?.playbook?.id)),
  autonomyDefaults: (projectId) =>
    playbookOf(projections.get(projectId)?.playbook?.id).manifest.defaults.autonomy,
  corsOrigin: env.CORS_ORIGIN,
  auth,
  extraOrigins,
  stream: {
    pollMs: env.STREAM_POLL_MS,
    maxMs: env.STREAM_MAX_SECONDS ? env.STREAM_MAX_SECONDS * 1000 : null,
  },
  logger: true,
  heartbeat: integrations ? () => integrations.get<WorkerHeartbeat>('heartbeat:worker') : undefined,
  rules,
  ruleDrafter: process.env.ANTHROPIC_API_KEY ? (input) => draftRule(input) : null,
  cypher: integrations
    ? {
        model:
          env.AGENTS === 'claude' || process.env.ANTHROPIC_API_KEY ? anthropicModelClient() : null,
        store: integrations,
      }
    : undefined,
});

await seedSample?.();

const shutdown = async () => {
  await app.close();
  for (const c of cleanups) await c();
  await opened.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: env.PORT, host: env.HOST });
