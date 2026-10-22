import type { EventStore } from '@lw/events';
import type { Playbook } from '@lw/playbook-sdk';
import { ansco } from './ansco';
import { ansell } from './ansell';
import { DemoProject, type DemoBlobs } from './engine';
import type { DemoScenario } from './types';

export { DemoProject, type DemoBlobs } from './engine';
export { DemoClock } from './clock';
export type * from './types';

/** The prototype's two projects, in switcher order. */
export const DEMO_SCENARIOS: DemoScenario[] = [ansell, ansco];

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
      projectId: `prj-${def.id}`,
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
