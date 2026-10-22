import type { Control } from '@lw/contracts';
import { CommandError } from '@lw/domain';
import type { Simulation } from '@lw/simulator';

/**
 * What the API needs from whatever runs a project: the simulator in M0 demos, the Temporal
 * orchestrator otherwise. Refusals throw CommandError; the API turns them into 4xx answers.
 */
export interface ProjectCommands {
  resolve(
    escalationId: string,
    optionId: string,
    notes?: string | null,
    confirmation?: string,
  ): Promise<unknown>;
  defer(escalationId: string, until: Date): Promise<unknown>;
  /** Takes back a reversible choice inside its undo window. */
  undo(escalationId: string): Promise<unknown>;
  postMessage(body: string): Promise<unknown>;
  stopDirective(directiveId: string): Promise<unknown>;
  control(cmd: Control): Promise<unknown>;
}

export function simulationCommands(sim: Simulation): ProjectCommands {
  return {
    resolve: (escalationId, optionId, notes = null, confirmation) =>
      sim.resolve(escalationId, optionId, 'director', notes, confirmation),
    defer: (escalationId, until) => sim.defer(escalationId, until),
    undo: async () => {
      throw new CommandError(
        422,
        'not_supported',
        'Undo runs on the orchestrator, not in the simulator.',
      );
    },
    postMessage: (body) => sim.postMessage(body),
    stopDirective: (directiveId) => sim.stopDirective(directiveId),
    control: (cmd) => sim.control(cmd),
  };
}
