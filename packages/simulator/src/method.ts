import type { Workstream } from '@lw/contracts';
import type { Simulation } from './simulation';

/**
 * The method every scripted engagement shares, whatever the platform: how a task runs and is
 * reviewed, how a phase opens and closes, the two Director gates, and what happens when a task
 * can't go on without the Director. A scenario supplies the platform's side: the tasks, the tool
 * calls and the words.
 */

/** A scripted engagement: what `Simulation.run` plays. */
export type Scenario = (sim: Simulation) => Promise<void>;

/** One tool call: the server, the operation, and what came back. */
export type Step = [server: string, op: string, summary: string];

type Card = Parameters<Simulation['escalate']>[0];

const LEADS = [
  'chief-of-staff',
  'discovery-lead',
  'engineering-lead',
  'content-lead',
  'quality-lead',
];

/**
 * Runs one task end to end: agent active → steps → validating → done (or rejected and retried).
 * `rejectTimes` makes the Lead reject the output that many times before it passes.
 */
export async function work(
  sim: Simulation,
  agentId: string,
  taskId: string,
  label: string,
  steps: Step[],
  opts: { rejectTimes?: number; validator?: Step } = {},
) {
  await sim.move(taskId, 'ready');
  await sim.move(taskId, 'running');
  let rejections = 0;
  for (;;) {
    for (let i = 0; i < steps.length; i++) {
      const [server, op, summary] = steps[i]!;
      await sim.agent(agentId, 'active', `${label}, step ${i + 1} of ${steps.length}`, taskId);
      await sim.step(agentId, taskId, server, op, summary);
    }
    await sim.move(taskId, 'validating');
    if (opts.validator) {
      const [server, op, summary] = opts.validator;
      const pass = rejections >= (opts.rejectTimes ?? 0);
      await sim.step(agentId, taskId, server, op, pass ? summary : `${summary}: failed`, {
        code: pass ? 200 : 422,
        severity: pass ? 'notable' : 'failure',
      });
    }
    if (rejections < (opts.rejectTimes ?? 0)) {
      rejections++;
      await sim.move(taskId, 'rejected', 'Lead review: acceptance criteria not met');
      if (rejections > 2) return 'escalate' as const;
      await sim.move(taskId, 'running', `Retry ${rejections} with Lead feedback`);
      continue;
    }
    await sim.move(taskId, 'done');
    await sim.agent(agentId, 'idle', null, null);
    return 'done' as const;
  }
}

/**
 * One agent session over several tasks of the same template (the plan's `batchSize`): they are
 * dispatched together and finish one by one. `each` makes the tool calls of one task.
 */
export async function workBatch(
  sim: Simulation,
  agentId: string,
  taskIds: string[],
  label: string,
  each: (taskId: string, index: number) => Promise<void>,
) {
  for (const id of taskIds) await sim.move(id, 'ready');
  for (const id of taskIds) await sim.move(id, 'running');
  for (const [i, id] of taskIds.entries()) {
    await sim.agent(agentId, 'active', `${label}, ${i + 1} of ${taskIds.length}`, id);
    await each(id, i);
    await sim.move(id, 'validating');
    await sim.move(id, 'done');
  }
  await sim.agent(agentId, 'idle', null, null);
}

async function activate(sim: Simulation, phase: number) {
  for (const r of sim.playbook.roles) {
    if (r.tier !== 'specialist' || !Array.isArray(r.activePhases)) continue;
    if (r.activePhases.includes(phase)) await sim.agent(r.role, 'idle');
  }
}

async function deactivate(sim: Simulation, phase: number, next: number[]) {
  for (const r of sim.playbook.roles) {
    if (r.tier !== 'specialist' || !Array.isArray(r.activePhases)) continue;
    const activeNow = r.activePhases.includes(phase);
    const activeLater = next.some((n) => (r.activePhases as number[]).includes(n));
    if (activeNow && !activeLater) await sim.agent(r.role, 'inactive');
  }
}

export async function enter(sim: Simulation, phase: number, brief: string[]) {
  const p = sim.playbook.manifest.phases[phase]!;
  await sim.phase('entered', phase);
  await activate(sim, phase);
  await sim.say('phase_brief_entry', `Phase ${phase} brief: ${p.name}`, brief.join('\n'));
}

export async function exit(sim: Simulation, phase: number, results: string[], next: number[]) {
  const p = sim.playbook.manifest.phases[phase]!;
  await sim.phase('exited', phase);
  await deactivate(sim, phase, next);
  await sim.say('phase_brief_exit', `Phase ${phase} complete: ${p.name}`, results.join('\n'));
}

/** A task as `planTasks` takes it. */
export const task = (
  id: string,
  role: string,
  title: string,
  workstream: Workstream | null,
  dependsOn: string[] = [],
) => ({
  taskId: id,
  role,
  title,
  workstream,
  dependsOn,
});

/**
 * Creates the project, seats the Chief of Staff and the Leads, and posts the intake brief.
 * `labelled` gives it the playbook's stat cards and tool server names.
 */
export async function kickOff(sim: Simulation, opts: { labelled?: boolean } = {}) {
  // Small budgets so the burn bar moves during a demo; real projects use the playbook defaults.
  await sim.createProject({ tokens: 2_500_000, usd: 20, hours: 6 }, opts);
  for (const lead of LEADS) await sim.agent(lead, 'idle');
  await sim.say(
    'text',
    'Intake brief',
    `Project created for ${sim.opts.client}. The team will verify access, analyse the repository and the live site, then bring you the Implementation Blueprint for approval at Gate 1.`,
  );
}

/**
 * A task that can't go on without the Director: it and its agent show blocked until the card is
 * answered, then the task runs again. Returns the option chosen.
 */
export async function hold(
  sim: Simulation,
  agentId: string,
  taskId: string,
  why: { reason: string; now: string; resumed: string },
  card: Card,
) {
  await sim.move(taskId, 'blocked', why.reason);
  await sim.agent(agentId, 'blocked', why.now, taskId);
  const answer = await sim.escalate(card);
  await sim.move(taskId, 'running', why.resumed);
  return answer;
}

/**
 * A step no agent can do yet: the Director does it and marks it done. The card is the one the
 * orchestrator raises for a plan task with a `manual` checklist; it has no default.
 */
export async function byHand(sim: Simulation, taskId: string, title: string, checklist: string) {
  await sim.move(taskId, 'ready');
  await sim.move(taskId, 'blocked', 'A step for the Director, by hand');
  await sim.escalate({
    type: 'decision',
    title: `By hand: ${title}`.slice(0, 120),
    context: checklist,
    impact: `${title} and the tasks that depend on it wait for it. Other work continues.`,
    options: [
      { id: 'accept', label: 'Done: I checked it (say what you checked)', recommended: true },
    ],
    defaultOptionId: null,
    sourceTaskId: taskId,
    evidence: [{ kind: 'log', label: 'Task', ref: `task:${taskId}` }],
  });
  await sim.move(taskId, 'running', 'Marked done by the Director');
  await sim.move(taskId, 'validating');
  await sim.move(taskId, 'done');
}

/**
 * The Decision every Blueprint needs before content moves: which source wins where the repository
 * and the live site differ. It expires to the live site. `waits` names who waits on the answer.
 */
export function sourceOfTruth(sim: Simulation, taskId: string, waits: string) {
  return sim.escalate({
    type: 'decision',
    title: 'Source of truth for page content',
    context:
      'The repo holds content for 12 pages that differs from the live site. The Blueprint needs one source per page.',
    impact: `The ${waits} waits on this in phase 6; nothing waits today.`,
    options: [
      { id: 'live', label: 'Live site for every page', recommended: true },
      { id: 'repo', label: 'Repository content where it exists' },
    ],
    defaultOptionId: 'live',
    deadlineSimSeconds: 90,
    sourceTaskId: taskId,
  });
}

/**
 * Gate 1: publishes the Blueprint and waits for the Director. Sent back, the Solution Architect
 * writes the next version and the gate is raised again. Returns the version approved.
 */
export async function blueprintGate(
  sim: Simulation,
  taskId: string,
  card: { context: string; impact: string },
): Promise<number> {
  let version = 1;
  await sim.artifact(
    'blueprint',
    'blueprint',
    'Implementation Blueprint',
    version,
    'solution-architect',
  );
  for (;;) {
    const answer = await sim.escalate({
      type: 'gate',
      title: `Approve Implementation Blueprint v${version}`,
      context: card.context,
      impact: card.impact,
      options: [
        { id: 'approve', label: 'Approve', recommended: true },
        { id: 'send_back', label: 'Send back with notes' },
      ],
      defaultOptionId: null,
      sourceTaskId: taskId,
      evidence: [{ kind: 'artifact', label: `Blueprint v${version}`, ref: 'artifact:blueprint' }],
      gate: {
        phase: 2,
        artifactId: 'blueprint',
        artifactVersion: version,
        requiresConfirmation: false,
      },
    });
    if (answer === 'approve') return version;
    version++;
    await sim.say('text', null, `Revising the Blueprint per your notes. v${version} follows.`);
    await sim.step(
      'solution-architect',
      taskId,
      'blackboard',
      'write.blueprint',
      `Blueprint v${version} written`,
    );
    await sim.artifact(
      'blueprint',
      'blueprint',
      'Implementation Blueprint',
      version,
      'solution-architect',
    );
  }
}

/**
 * Gate 2: publishes the handover pack and waits for the Director to accept in the live systems
 * (they type the project's name), then closes the last phase and the project.
 */
export async function acceptAndClose(sim: Simulation, phase: number, context: string) {
  await sim.artifact('handover-pack', 'handover_pack', 'Handover pack', 1, 'handover-writer');
  await sim.escalate({
    type: 'gate',
    title: 'Accept the implementation',
    context,
    impact: 'Accepting closes the engagement.',
    options: [
      { id: 'approve', label: 'Accept', recommended: true },
      { id: 'send_back', label: 'Send back with notes' },
    ],
    defaultOptionId: null,
    sourceTaskId: null,
    evidence: [{ kind: 'artifact', label: 'Handover pack', ref: 'artifact:handover-pack' }],
    gate: {
      phase,
      artifactId: 'handover-pack',
      artifactVersion: 1,
      requiresConfirmation: true,
    },
  });
  await exit(sim, phase, ['Accepted. Handover pack delivered.'], []);
  await sim.emit(sim.projectStatus('completed'));
  await sim.say(
    'text',
    'Project complete',
    'This project is complete. Open the handover pack in Workbench.',
  );
}

/**
 * Work started now and awaited later. If the simulation stops in between, its rejection must not
 * surface as unhandled; whoever awaits it still receives it.
 */
export function background<T>(work: Promise<T>): Promise<T> {
  work.catch(() => {});
  return work;
}

/** One agent's queue: jobs run one at a time, in the order they were given. */
export function lane() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const next = background(tail.then(job));
    tail = next.catch(() => {});
    return next;
  };
}

export function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}
