import type { Playbook } from '@lw/playbook-sdk';
import type { Scenario } from './method';
import { optimizelyScenario } from './optimizely';
import { sitecoreScenario } from './scenario';

/**
 * The scripted engagement of each playbook that has one. A scenario plays one playbook's phases
 * and roles, so it is chosen by the playbook a simulated project runs, never by a constant.
 */
export const SCENARIOS: Record<string, Scenario> = {
  'sitecoreai-migration': sitecoreScenario,
  'optimizely-saas-migration': optimizelyScenario,
};

/** The scenario a simulated project of this playbook plays; undefined when it has none. */
export const scenarioFor = (playbook: Playbook): Scenario | undefined =>
  SCENARIOS[playbook.manifest.id];
