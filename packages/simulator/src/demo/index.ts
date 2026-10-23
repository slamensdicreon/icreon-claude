import type { EventStore } from '@lw/events';
import type { Playbook } from '@lw/playbook-sdk';
import { ansell } from './ansell';
import { DemoProject, type DemoBlobs } from './engine';
import type { DemoScenario } from './types';

export { DemoProject, scenarioList, type DemoBlobs } from './engine';
export { DemoClock } from './clock';
export type * from './types';

/** The demo project, in switcher order. */
export const DEMO_SCENARIOS: DemoScenario[] = [ansell];

export const demoProjectId = (def: DemoScenario) => `prj-${def.id}`;

/**
 * Demo projects that no longer play. The runner deletes their logs on start, so they don't linger
 * as stopped projects. Ansco is now a real engagement, set up through the New Project wizard.
 */
export const RETIRED_DEMO_PROJECTS = ['prj-ansco'];

/** Seeds and starts the demo projects. Each keeps running until `stop()`. */
export async function startDemo(
  store: EventStore,
  playbook: Playbook,
  blobs: DemoBlobs,
  opts: {
    speed?: number;
    auto?: boolean;
    scenarios?: DemoScenario[];
    undoWindowMs?: number;
    directiveWindowMs?: number;
  } = {},
): Promise<DemoProject[]> {
  const projects: DemoProject[] = [];
  for (const def of opts.scenarios ?? DEMO_SCENARIOS) {
    const p = new DemoProject(store, playbook, blobs, def, {
      projectId: demoProjectId(def),
      speed: opts.speed,
      auto: opts.auto,
      undoWindowMs: opts.undoWindowMs,
      directiveWindowMs: opts.directiveWindowMs,
    });
    await p.seed();
    p.start();
    projects.push(p);
  }
  return projects;
}
