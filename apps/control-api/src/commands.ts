import type { Control, SettingKey } from '@lw/contracts';
import { CommandError } from '@lw/domain';
import type { CommandBus, CommandRequest } from '@lw/events';
import {
  DEMO_SCENARIOS,
  demoProjectId,
  scenarioList,
  type DemoProject,
  type Simulation,
} from '@lw/simulator';

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
  postMessage(body: string, about?: string): Promise<unknown>;
  stopDirective(directiveId: string): Promise<unknown>;
  control(cmd: Control): Promise<unknown>;
  /** Ends a deferral early ("Resume now"). */
  resume?(escalationId: string): Promise<unknown>;
  rerunTask?(taskId: string, instructions: string): Promise<unknown>;
  rollbackTask?(taskId: string): Promise<unknown>;
  rollbackPhase?(phase: number): Promise<unknown>;
  archive?(): Promise<unknown>;
  changeSetting?(key: SettingKey, value: unknown): Promise<unknown>;
  verifyCredential?(credentialId: string): Promise<unknown>;
  /** Simulated projects only: raise one of the scripted scenarios on demand. */
  runScenario?(key: string): Promise<unknown>;
  /** Simulated projects only: the scenarios `runScenario` accepts. */
  scenarios?(): { key: string; label: string }[];
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

/** The demo projects implement every command the Control Center sends. */
export function demoCommands(p: DemoProject): ProjectCommands {
  return {
    resolve: (escalationId, optionId, notes = null) => p.resolve(escalationId, optionId, notes),
    defer: (escalationId, until) => p.defer(escalationId, until),
    undo: (escalationId) => p.undo(escalationId),
    postMessage: (body, about) => p.postMessage(body, about),
    stopDirective: (directiveId) => p.stopDirective(directiveId),
    control: (cmd) => p.control(cmd),
    resume: (escalationId) => p.resume(escalationId),
    rerunTask: (taskId, instructions) => p.rerunTask(taskId, instructions),
    rollbackTask: (taskId) => p.rollbackTask(taskId),
    rollbackPhase: (phase) => p.rollbackPhase(phase),
    archive: () => p.archive(),
    changeSetting: (key, value) => p.changeSetting(key, value),
    verifyCredential: (credentialId) => p.verifyCredential(credentialId),
    runScenario: (key) => p.runScenario(key),
    scenarios: () => p.scenarios(),
  };
}

/** The commands a runner on the bus accepts; `until` travels as an ISO string. */
const REMOTE = [
  'resolve',
  'defer',
  'undo',
  'postMessage',
  'stopDirective',
  'control',
  'resume',
  'rerunTask',
  'rollbackTask',
  'rollbackPhase',
  'archive',
  'changeSetting',
  'verifyCredential',
  'runScenario',
] as const;
type RemoteMethod = (typeof REMOTE)[number];

/**
 * Commands for a project run by another process (the demo runner on a daemon), sent over the
 * Postgres command bus. Refusals come back as the runner's own CommandError.
 */
export function remoteCommands(bus: CommandBus, projectId: string): ProjectCommands {
  const send =
    (method: RemoteMethod) =>
    (...args: unknown[]) =>
      bus.send(
        projectId,
        method,
        args.map((a) => (a instanceof Date ? a.toISOString() : a)),
      );
  const cmds = Object.fromEntries(REMOTE.map((m) => [m, send(m)])) as unknown as ProjectCommands;
  const def = DEMO_SCENARIOS.find((d) => demoProjectId(d) === projectId);
  if (def) cmds.scenarios = () => scenarioList(def);
  return cmds;
}

/** The runner's side: one command off the bus, run against the project's own commands. */
export async function dispatch(cmds: ProjectCommands, req: CommandRequest): Promise<unknown> {
  const method = req.method as RemoteMethod;
  const fn = REMOTE.includes(method) ? cmds[method] : undefined;
  if (!fn) {
    throw new CommandError(501, 'not_supported', `This runner can't ${req.method}.`);
  }
  const args = method === 'defer' ? [req.args[0], new Date(req.args[1] as string)] : req.args;
  return (fn as (...a: unknown[]) => Promise<unknown>).apply(cmds, args);
}
