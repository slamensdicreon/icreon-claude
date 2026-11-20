import { randomUUID } from 'node:crypto';
import type { EventStore } from '@lw/events';
import type { CatalogEntry } from '@lw/playbook-sdk';
import { scenarioFor, Simulation } from '@lw/simulator';
import { simulationCommands, type ProjectCommands } from './commands';

/** A scripted engagement: a simulated project and the playbook it runs. */
export interface SimSeed {
  name: string;
  client: string;
  sourceUrl: string;
  /** The playbook the project is created on; its scenario is the one that plays. */
  playbook: string;
  /** Answers gates and Blockers by itself. */
  autopilot: boolean;
  /** Times SIM_SPEED. */
  speedFactor: number;
}

/**
 * The scripted engagements, in the order SIM_PROJECTS starts them: two SitecoreAI builds, then
 * an Optimizely CMS (SaaS) build. New ones go at the end, so a count keeps meaning what it did.
 */
export const SIM_SEEDS: SimSeed[] = [
  {
    name: 'Acme corporate site',
    client: 'Acme Corp',
    sourceUrl: 'https://www.acme.example',
    playbook: 'sitecoreai-migration',
    autopilot: false,
    speedFactor: 1,
  },
  {
    name: 'Northwind marketing site',
    client: 'Northwind',
    sourceUrl: 'https://www.northwind.example',
    playbook: 'sitecoreai-migration',
    autopilot: true,
    speedFactor: 3,
  },
  {
    name: 'Globex website',
    client: 'Globex',
    sourceUrl: 'https://www.globex.example',
    playbook: 'optimizely-saas-migration',
    autopilot: false,
    speedFactor: 1,
  },
];

/** A seed's project id when it must be the same on every start (the demo runner's shared log). */
export const simProjectId = (seed: SimSeed) =>
  `prj-sim-${seed.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')}`;

export interface SimProjects {
  /** The Director's commands for each simulated project, by project id. */
  commands: Map<string, ProjectCommands>;
  stop(): void;
}

/**
 * Starts the first `count` scripted engagements. Each is created on its own playbook and plays
 * that playbook's scenario; one whose playbook is not in the catalog, or has no scenario, is
 * skipped and named in the log.
 */
export function startSimProjects(opts: {
  store: EventStore;
  catalog: Map<string, CatalogEntry>;
  count: number;
  /** SIM_SPEED. */
  speed: number;
  /** Project ids; random by default. */
  projectId?: (seed: SimSeed) => string;
  seeds?: SimSeed[];
}): SimProjects {
  const commands = new Map<string, ProjectCommands>();
  const running: Simulation[] = [];
  for (const seed of (opts.seeds ?? SIM_SEEDS).slice(0, opts.count)) {
    const playbook = opts.catalog.get(seed.playbook)?.playbook;
    const scenario = playbook && scenarioFor(playbook);
    if (!playbook || !scenario) {
      console.warn(
        `Simulated project "${seed.name}" not started: ${playbook ? `the playbook ${seed.playbook} has no scripted scenario` : `no playbook ${seed.playbook} in the catalog`}.`,
      );
      continue;
    }
    const projectId = opts.projectId?.(seed) ?? `prj-${randomUUID().slice(0, 8)}`;
    const sim = new Simulation(opts.store, playbook, {
      projectId,
      name: seed.name,
      client: seed.client,
      sourceUrl: seed.sourceUrl,
      autopilot: seed.autopilot,
      speed: opts.speed * seed.speedFactor,
      seed: running.length + 1,
    });
    commands.set(projectId, simulationCommands(sim));
    running.push(sim);
    void sim.run(scenario).catch((err) => console.error('simulation failed', projectId, err));
  }
  return { commands, stop: () => running.forEach((s) => s.stop()) };
}
