import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { InMemoryEventStore, Projections } from '@lw/events';
import { loadPlaybook } from '@lw/playbook-sdk';
import { Simulation, sitecoreScenario } from '@lw/simulator';
import { z } from 'zod';
import { buildApp } from './app';

/**
 * M0 entry point: an in-memory event store, the projector, and simulated projects standing in for
 * the orchestrator. No authentication yet, so it binds to localhost by default; GitHub sign-in
 * lands before this runs anywhere shared.
 */
const env = z
  .object({
    PORT: z.coerce.number().int().default(4000),
    HOST: z.string().default('127.0.0.1'),
    CORS_ORIGIN: z.string().default('*'),
    SIM_SPEED: z.coerce.number().positive().default(1),
    SIM_PROJECTS: z.coerce.number().int().min(0).max(10).default(2),
    PLAYBOOK_DIR: z
      .string()
      .default(fileURLToPath(new URL('../../../playbooks/sitecoreai-migration', import.meta.url))),
  })
  .parse(process.env);

const store = new InMemoryEventStore();
const projections = new Projections(store);
await projections.start();
const playbook = await loadPlaybook(env.PLAYBOOK_DIR);
const orchestrators = new Map<string, Simulation>();

const SEEDS = [
  { name: 'Acme corporate site', client: 'Acme Corp', autopilot: false, speedFactor: 1 },
  { name: 'Northwind marketing site', client: 'Northwind', autopilot: true, speedFactor: 3 },
];

function startSimulation(opts: {
  name: string;
  client: string;
  autopilot: boolean;
  speed: number;
}) {
  const projectId = `prj-${randomUUID().slice(0, 8)}`;
  const sim = new Simulation(store, playbook, { projectId, ...opts, seed: orchestrators.size + 1 });
  orchestrators.set(projectId, sim);
  void sim
    .run(sitecoreScenario)
    .catch((err) => app.log.error({ err, projectId }, 'simulation failed'));
  return projectId;
}

const app = await buildApp({
  store,
  projections,
  orchestrators,
  corsOrigin: env.CORS_ORIGIN,
  logger: true,
});

/** Dev-only: start another simulated project, e.g. to rehearse a gate again. */
app.post('/dev/simulations', async (req) => {
  const body = z
    .object({
      name: z.string().default('Simulated project'),
      client: z.string().default('Demo client'),
      autopilot: z.boolean().default(false),
      speed: z.number().positive().default(env.SIM_SPEED),
    })
    .parse(req.body ?? {});
  return { projectId: startSimulation(body) };
});

for (const seed of SEEDS.slice(0, env.SIM_PROJECTS)) {
  startSimulation({ ...seed, speed: env.SIM_SPEED * seed.speedFactor });
}

const shutdown = async () => {
  for (const sim of orchestrators.values()) sim.stop();
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: env.PORT, host: env.HOST });
