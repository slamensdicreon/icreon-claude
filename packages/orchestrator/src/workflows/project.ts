import type {
  AgentState,
  EscalationCard,
  EscalationCardInput,
  EscalationOption,
  EscalationStatus,
  EscalationType,
  MessageSection,
  MetricKey,
  NewEvent,
  ScopeKind,
  TaskState,
} from '@lw/contracts';
import { metricUnit } from '@lw/domain';
import {
  compilePlan,
  diffBlueprints,
  diffPlans,
  impactOf,
  phaseComplete,
  phasePercent,
  RELEASE_GATE,
  rollbackOrder,
  startablePhases,
  type Blueprint,
  type Impact,
  type Plan,
  type PlannedTask,
} from '@lw/plan';
import { phaseDefs, roster } from '@lw/playbook-sdk/pure';
import {
  allHandlersFinished,
  ApplicationFailure,
  condition,
  makeContinueAsNewFunc,
  patched,
  proxyActivities,
  setHandler,
  startChild,
  uuid4,
  type ChildWorkflowHandle,
  workflowInfo,
} from '@temporalio/workflow';
import type { Activities } from '../activities';
import {
  cancelTask,
  changeBudgets,
  completeTasks,
  rerunTask,
  control,
  deferEscalation,
  pauseTask,
  postMessage,
  resolveEscalation,
  resumeTask,
  stopDirective,
  undoResolution,
} from '../definitions';
import type { AgentResult, ProjectInput, ProjectSnapshot, Resolver, TaskOutcome } from '../types';
import { taskWorkflow } from './task';

const acts = proxyActivities<Activities>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 10 },
});

const BUDGET_SOFT = 0.8;
const CHIEF = { kind: 'chief_of_staff' as const, id: 'chief-of-staff' };
const SYSTEM = { kind: 'system' as const, id: 'orchestrator' };
const DIRECTOR = { kind: 'director' as const, id: 'director' };

interface Escalation {
  card: EscalationCard;
  status: EscalationStatus;
  deadlineAt: number | null;
  windowMs: number | null;
  deferredUntil: number | null;
  /** A Director's choice inside its undo window. */
  pending: { optionId: string; notes: string | null; undone: boolean } | null;
  /** What answering it does (see `applyResolution`). */
  resolver: Resolver;
}

interface Gate {
  status: 'none' | 'pending' | 'approved';
  escalationId: string | null;
}

/**
 * One engagement, end to end. Compiles the plan from the playbook (and, after the first gate, the
 * Blueprint), enters phases as their prerequisites finish, dispatches ready tasks to child
 * workflows under the concurrency limit, raises escalations by rule, waits on Director gates,
 * applies defaults at deadlines, and re-plans on directives after a stop window.
 *
 * Every state change is an event in the project log; the read models and the Control Center are
 * built from those events alone.
 */
export async function projectWorkflow(input: ProjectInput): Promise<void> {
  const { projectId, playbook, policy } = input;
  /** The previous run's state, when this run continues one. */
  const resume = input.resume;
  const startedAt = resume?.startedAt ?? Date.now();
  const phaseInfo = new Map(playbook.manifest.phases.map((p) => [p.number, p]));
  const roles = new Map(playbook.roles.map((r) => [r.role, r]));
  const templates = new Map(playbook.plan.templates.map((t) => [t.id, t]));
  const lastDirectorGate = Math.max(
    ...playbook.manifest.phases.filter((p) => p.gate === 'director').map((p) => p.number),
  );

  let blueprint: Blueprint | null = resume?.blueprint ?? null;
  let plan: Plan =
    resume?.plan ??
    compilePlan(playbook, null, {
      enabledGates: policy.enabledGates,
      features: policy.features,
    });
  const states: Record<string, TaskState> = {};
  const attempts: Record<string, number> = {};
  const instructions: Record<string, string | null> = {};
  const retryFromBlocked = new Set<string>();
  /** Tasks the Director sent back: they run even if their phase has already exited. */
  const reruns = new Set<string>();
  /** Tasks parked until other tasks make what they need, and how often each has waited. */
  const waitingOn = new Map<
    string,
    { ids: string[]; what: string; prior: string | null; note?: string }
  >();
  const waits: Record<string, number> = {};
  const MAX_WAITS = 3;
  /** How often agents sent each finished task back; past the limit, the Director decides. */
  const sentBack: Record<string, number> = {};
  const MAX_SEND_BACKS = 2;
  const titleOf = (id: string) => task(id)?.title ?? id;
  const taskEscalation = new Map<string, string>();
  const started = new Set<number>();
  const done = new Set<number>();
  const gates = new Map<string, Gate>();
  const escalations = new Map<string, Escalation>();
  const children = new Map<string, ChildWorkflowHandle<typeof taskWorkflow>>();
  const running = new Map<string, Set<string>>(); // role → task ids
  const agentStates = new Map<string, AgentState>();
  const pausedRoles = new Set<string>();
  const pausedPhases = new Set<number>();
  const pausedTasks = new Set<string>();
  const cancelledPhases = new Set<number>();
  const artifactVersions = new Map<string, number>();
  const phaseArtifact = new Map<number, { artifactId: string; title: string; version: number }>();
  const directives = new Map<string, { stopped: boolean; settled: boolean }>();
  const spent = { tokens: 0, usd: 0 };
  let projectPaused = false;
  let budgetHold = false;
  let softWarned = false;
  let hardStopped = false;
  /** The hard stop paused the project (not the Director): new budgets that cover it resume it. */
  let budgetPaused = false;
  let completed = false;
  let wake = false;
  let childRuns = 0;

  const send = (...events: NewEvent[]) => acts.emit(projectId, events);
  const poke = () => void (wake = true);
  /** Background work in progress that a handover to a new run must not cut short. */
  let busy = 0;
  /** Counts a background job without awaiting it, so its scheduling stays as it was. */
  const track = (job: Promise<unknown>) => {
    busy += 1;
    const finished = () => void (busy -= 1);
    void job.then(finished, finished);
  };
  /** The same, for a job the caller awaits. */
  const tracked = <T>(job: Promise<T>): Promise<T> => {
    track(job);
    return job;
  };
  const task = (id: string) => plan.tasks.find((t) => t.taskId === id);
  const stateOf = (id: string): TaskState => states[id] ?? 'planned';
  /** Paused by the Director at any level that covers this task. */
  const held = (t: PlannedTask) =>
    projectPaused ||
    pausedRoles.has(t.role) ||
    pausedPhases.has(t.phase) ||
    pausedTasks.has(t.taskId);
  const now = () => new Date(Date.now()).toISOString();

  // -------------------------------------------------------------------------------------------
  // Event builders
  // -------------------------------------------------------------------------------------------

  const taskMove = (t: PlannedTask, to: TaskState, reason: string | null = null): NewEvent => {
    const from = stateOf(t.taskId);
    states[t.taskId] = to;
    return {
      type: 'task.state',
      actor: SYSTEM,
      subject: { kind: 'task', id: t.taskId },
      severity: to === 'blocked' ? 'warning' : to === 'done' ? 'notable' : 'routine',
      data: { taskId: t.taskId, from, to, attempt: attempts[t.taskId] ?? 0, reason },
    };
  };

  /** Walks a checkpoint (no agent work) to done from wherever it stands. */
  const completeCheckpoint = (t: PlannedTask, reason: string): NewEvent[] => [
    ...(stateOf(t.taskId) === 'planned' ? [taskMove(t, 'ready')] : []),
    taskMove(t, 'running'),
    taskMove(t, 'validating'),
    taskMove(t, 'done', reason),
  ];

  const planned = (t: PlannedTask): NewEvent => ({
    type: 'task.planned',
    actor: SYSTEM,
    subject: { kind: 'task', id: t.taskId },
    severity: 'routine',
    data: {
      taskId: t.taskId,
      phase: t.phase,
      workstream: t.workstream,
      role: t.role,
      title: t.title,
      dependsOn: t.dependsOn,
      kind: t.kind,
      group: t.collection ? t.templateId : null,
      groupTitle: t.groupTitle,
      itemKeys: t.itemKeys,
      estimateHours: t.estimateHours,
      contract: t.contract,
    },
  });

  const agent = (
    role: string,
    state: AgentState,
    nowLine: string | null,
    taskId: string | null,
  ): NewEvent => {
    agentStates.set(role, state);
    return {
      type: 'agent.state',
      actor: { kind: 'agent', id: role },
      subject: { kind: 'agent', id: role },
      severity: state === 'blocked' || state === 'failed' ? 'warning' : 'routine',
      data: { agentId: role, state, now: nowLine, taskId },
    };
  };

  /** Recomputes a role's displayed state from what it is running and what is blocked. */
  const agentRefresh = (role: string): NewEvent => {
    const mine = [...(running.get(role) ?? [])];
    if (pausedRoles.has(role))
      return agent(role, 'waiting', 'Waiting: paused by the Director', mine[0] ?? null);
    if (mine.length) {
      const t = task(mine.at(-1)!)!;
      const line =
        mine.length === 1 ? t.title : `${mine.length} tasks in progress, latest: ${t.title}`;
      return agent(role, 'active', line, t.taskId);
    }
    const blocked = plan.tasks.find((t) => t.role === role && stateOf(t.taskId) === 'blocked');
    if (blocked) return agent(role, 'blocked', `Blocked: ${blocked.title}`, blocked.taskId);
    const def = roles.get(role);
    const resident = def?.tier !== 'specialist';
    const activeNow = [...started].some(
      (n) =>
        !done.has(n) &&
        (def?.activePhases === 'all' || (def?.activePhases as number[]).includes(n)),
    );
    return agent(role, resident || activeNow ? 'idle' : 'inactive', null, null);
  };

  const say = (
    kind: Extract<NewEvent, { type: 'cos.message' }>['data']['kind'],
    title: string | null,
    body: string,
    extra: { sections?: MessageSection[]; proceedsAt?: string; directiveId?: string } = {},
  ): NewEvent[] => [
    {
      type: 'cos.presence',
      actor: CHIEF,
      subject: { kind: 'agent', id: CHIEF.id },
      severity: 'routine',
      data: { presence: 'briefing' },
    },
    {
      type: 'cos.message',
      actor: CHIEF,
      subject: { kind: 'message', id: uuid4() },
      severity: 'routine',
      data: {
        messageId: uuid4(),
        kind,
        title,
        body,
        sections: extra.sections ?? [],
        proceedsAt: extra.proceedsAt ?? null,
        directiveId: extra.directiveId ?? null,
      },
    },
    {
      type: 'cos.presence',
      actor: CHIEF,
      subject: { kind: 'agent', id: CHIEF.id },
      severity: 'routine',
      data: { presence: 'listening' },
    },
  ];

  const metricEvents = (): NewEvent[] => {
    const byMetric = new Map<MetricKey, PlannedTask[]>();
    // Cancelled work leaves the total, so "4 of 4" can still be reached.
    for (const t of plan.tasks)
      if (t.metric && stateOf(t.taskId) !== 'cancelled')
        byMetric.set(t.metric, [...(byMetric.get(t.metric) ?? []), t]);
    return [...byMetric].map(([key, ts]) => ({
      type: 'metric.updated' as const,
      actor: SYSTEM,
      subject: { kind: 'metric' as const, id: key },
      severity: 'routine' as const,
      data: {
        key,
        value: ts.filter((t) => stateOf(t.taskId) === 'done').length,
        total: ts.length,
        unit: metricUnit(key),
      },
    }));
  };

  const decision = (
    question: string,
    answer: string,
    rationale: string,
    decidedBy: 'director' | 'chief_of_staff' | 'default',
    scopeKey: string,
    escalationId: string | null,
  ): NewEvent => ({
    type: 'decision.recorded',
    actor: decidedBy === 'director' ? DIRECTOR : CHIEF,
    subject: { kind: 'escalation', id: escalationId ?? scopeKey },
    severity: 'notable',
    data: { decisionId: uuid4(), question, answer, rationale, decidedBy, scopeKey, escalationId },
  });

  // -------------------------------------------------------------------------------------------
  // Escalations
  // -------------------------------------------------------------------------------------------

  const unresolved = (e: Escalation) => e.status === 'open' || e.status === 'deferred';

  async function raise(
    card: Omit<EscalationCardInput, 'escalationId' | 'deadline'>,
    resolver: Resolver,
  ): Promise<string> {
    const escalationId = `esc-${uuid4().slice(0, 8)}`;
    const windowMs = card.defaultOptionId
      ? (policy.escalationDeadlinesMs[card.type] ?? null)
      : null;
    const deadlineAt = windowMs ? Date.now() + windowMs : null;
    const full: EscalationCard = {
      ...card,
      options: card.options.map((o) => ({ recommended: false, key: null, ...o })),
      evidence: card.evidence ?? [],
      gate: card.gate ?? null,
      typeLabel: card.typeLabel ?? null,
      waitNote: card.waitNote ?? null,
      reversible: card.reversible ?? true,
      escalationId,
      deadline: deadlineAt ? new Date(deadlineAt).toISOString() : null,
    };
    escalations.set(escalationId, {
      card: full,
      status: 'open',
      deadlineAt,
      windowMs,
      deferredUntil: null,
      pending: null,
      resolver,
    });
    await send({
      type: 'escalation.raised',
      actor: CHIEF,
      subject: { kind: 'escalation', id: escalationId },
      severity: card.type === 'risk' ? 'notable' : 'warning',
      data: full,
    });
    void watch(escalationId);
    return escalationId;
  }

  /** Applies the default at the deadline; re-opens a deferred card when its deferral ends. */
  async function watch(id: string) {
    const e = escalations.get(id)!;
    while (unresolved(e)) {
      if (e.status === 'deferred' && e.deferredUntil) {
        const changed = await condition(
          () => !unresolved(e) || e.status !== 'deferred',
          Math.max(1, e.deferredUntil - Date.now()),
        );
        if (!changed && e.status === 'deferred') {
          e.status = 'open';
          e.deferredUntil = null;
          if (e.windowMs) e.deadlineAt = Date.now() + e.windowMs;
          await tracked(
            send({
              type: 'escalation.updated',
              actor: CHIEF,
              subject: { kind: 'escalation', id },
              severity: 'warning',
              data: { escalationId: id, status: 'open', deferredUntil: null, resolution: null },
            }),
          );
        }
        continue;
      }
      if (e.deadlineAt) {
        const changed = await condition(
          () => !unresolved(e) || e.status === 'deferred',
          Math.max(1, e.deadlineAt - Date.now()),
        );
        if (!changed && e.status === 'open')
          await tracked(settle(id, e.card.defaultOptionId!, null, 'default'));
        continue;
      }
      await condition(() => !unresolved(e) || e.status === 'deferred');
    }
  }

  /**
   * Records a choice. A Director's reversible choice (any option except approving a gate) takes
   * effect after the undo window; until then it shows as resolved with `undoUntil`, and Undo
   * re-opens the card. Defaults and gate approvals take effect at once.
   */
  async function settle(
    id: string,
    optionId: string,
    notes: string | null,
    by: 'director' | 'default' | 'chief_of_staff',
  ) {
    const e = escalations.get(id)!;
    e.status = by === 'default' ? 'expired' : 'resolved';
    const undoable =
      by === 'director' &&
      policy.undoWindowMs > 0 &&
      (e.card.type !== 'gate' || optionId === 'send_back');
    if (!undoable) {
      await commit(id, optionId, notes, by);
      return;
    }
    const pending = { optionId, notes, undone: false };
    e.pending = pending;
    await send(
      updated(
        id,
        e.status,
        { optionId, notes, by, supersededBy: null },
        {
          undoUntil: new Date(Date.now() + policy.undoWindowMs).toISOString(),
        },
      ),
    );
    track(
      (async () => {
        const undone = await condition(() => pending.undone, policy.undoWindowMs);
        if (undone) return;
        e.pending = null;
        await commit(id, optionId, notes, by);
      })(),
    );
  }

  async function commit(
    id: string,
    optionId: string,
    notes: string | null,
    by: 'director' | 'default' | 'chief_of_staff',
  ) {
    const e = escalations.get(id)!;
    const option = e.card.options.find((o) => o.id === optionId);
    await send(
      updated(id, e.status, { optionId, notes, by, supersededBy: null }),
      decision(
        e.card.title,
        option?.label ?? optionId,
        notes ??
          (by === 'default'
            ? 'Deadline passed; the recommended default applied.'
            : 'Director choice.'),
        by,
        `${e.card.type}:${e.card.sourceTaskId ?? e.card.gate?.artifactId ?? e.card.title}`,
        id,
      ),
    );
    await applyResolution(e.resolver, optionId, notes);
    poke();
  }

  /** What an answered card does, by the kind of card it is. */
  async function applyResolution(r: Resolver, optionId: string, notes: string | null) {
    switch (r.kind) {
      case 'agent-decision': {
        taskEscalation.delete(r.taskId);
        const chosen = r.options.find((o) => o.id === optionId)!.label;
        instructions[r.taskId] =
          `Decision on "${r.question}": ${chosen}.${notes ? ` ${notes}` : ''}`;
        retryFromBlocked.add(r.taskId);
        return;
      }
      case 'blocked': {
        taskEscalation.delete(r.taskId);
        const t = task(r.taskId)!;
        if (optionId === 'accept') {
          await send(
            taskMove(t, 'running', 'Accepted by the Director'),
            taskMove(t, 'validating'),
            taskMove(t, 'done', 'Accepted as is'),
            agentRefresh(t.role),
          );
        } else {
          instructions[r.taskId] = notes;
          retryFromBlocked.add(r.taskId);
        }
        return;
      }
      case 'budget': {
        budgetHold = false;
        if (optionId === 'pause') await setProjectPaused(true);
        return;
      }
      case 'gate': {
        const gate = gates.get(r.key)!;
        const checkpoint = r.checkpointTaskId ? task(r.checkpointTaskId)! : null;
        if (optionId === 'approve') {
          gate.status = 'approved';
          if (checkpoint) await send(...completeCheckpoint(checkpoint, 'Approved by the Director'));
          if (!blueprint && plan.tasks.some((t) => t.kind === 'placeholder'))
            await adoptBlueprint();
        } else {
          gate.status = 'none';
          await rerun(r.coveredTasks, notes);
          if (checkpoint) states[checkpoint.taskId] = 'ready';
        }
        return;
      }
    }
  }

  const updated = (
    id: string,
    status: EscalationStatus,
    resolution: Extract<NewEvent, { type: 'escalation.updated' }>['data']['resolution'],
    extra: { undoUntil?: string } = {},
  ): NewEvent => ({
    type: 'escalation.updated',
    actor: resolution?.by === 'director' ? DIRECTOR : CHIEF,
    subject: { kind: 'escalation', id },
    severity: 'notable',
    data: {
      escalationId: id,
      status,
      deferredUntil: null,
      resolution,
      undoUntil: extra.undoUntil ?? null,
    },
  });

  async function supersede(id: string, by: string) {
    const e = escalations.get(id);
    if (!e || !unresolved(e)) return;
    e.status = 'superseded';
    await send({
      type: 'escalation.updated',
      actor: CHIEF,
      subject: { kind: 'escalation', id },
      severity: 'routine',
      data: {
        escalationId: id,
        status: 'superseded',
        deferredUntil: null,
        resolution: { optionId: null, notes: null, by: 'chief_of_staff', supersededBy: by },
      },
    });
  }

  const reject = (
    type: 'not_found' | 'conflict' | 'invalid' | 'not_supported',
    message: string,
  ) => {
    throw ApplicationFailure.create({ type, message, nonRetryable: true });
  };

  // -------------------------------------------------------------------------------------------
  // Tasks
  // -------------------------------------------------------------------------------------------

  /**
   * Starts one agent session for a batch of same-template tasks (usually one task). The ready
   * transitions are logged before the child starts, so the log always reads ready → running.
   */
  async function dispatch(batch: PlannedTask[], from: 'ready' | 'blocked') {
    const events: NewEvent[] = [];
    for (const t of batch) {
      reruns.delete(t.taskId);
      if (from === 'ready' && stateOf(t.taskId) === 'planned') events.push(taskMove(t, 'ready'));
      const set = running.get(t.role) ?? new Set<string>();
      set.add(t.taskId);
      running.set(t.role, set);
    }
    events.push(agentRefresh(batch[0]!.role));
    await send(...events);
    childRuns += 1;
    const handle = await startChild(taskWorkflow, {
      workflowId: `${projectId}:task:${batch[0]!.taskId}:${childRuns}`,
      args: [
        {
          projectId,
          paused: batch.some(held),
          items: batch.map((t) => ({
            task: t,
            from,
            attempt: attempts[t.taskId] ?? 0,
            instructions: instructions[t.taskId] ?? null,
          })),
        },
      ],
    });
    for (const t of batch) {
      children.set(t.taskId, handle);
      // The child owns these tasks' transitions now; marking them in flight means they are
      // never dispatched twice.
      states[t.taskId] = 'running';
    }
    // Tracked: its task leaves `children` before its outcome is recorded.
    track(
      handle.result().then(
        async (outcomes) => {
          for (const [i, outcome] of outcomes.entries()) await onOutcome(batch[i]!, outcome);
        },
        async (err: unknown) => {
          for (const t of batch) {
            await onOutcome(t, {
              outcome: 'escalate',
              state: stateOf(t.taskId),
              attempt: attempts[t.taskId] ?? 0,
              reason: `Task workflow failed: ${err instanceof Error ? err.message : String(err)}`,
              spent: { tokens: 0, usd: 0 },
            });
          }
        },
      ),
    );
  }

  async function onOutcome(t: PlannedTask, outcome: TaskOutcome) {
    children.delete(t.taskId);
    running.get(t.role)?.delete(t.taskId);
    states[t.taskId] = outcome.state;
    attempts[t.taskId] = outcome.attempt;
    const prior = instructions[t.taskId] ?? null;
    instructions[t.taskId] = null;
    const result: AgentResult = outcome.outcome === 'done' ? outcome.result : outcome.spent;
    const events: NewEvent[] = [];
    await account(result, events);

    if (outcome.outcome === 'done') {
      for (const [key, value] of Object.entries(result.metrics ?? {})) {
        events.push({
          type: 'metric.updated',
          actor: SYSTEM,
          subject: { kind: 'metric', id: key },
          severity: 'routine',
          data: { key: key as MetricKey, value, total: null, unit: metricUnit(key as MetricKey) },
        });
      }
      for (const a of result.artifacts ?? []) {
        const version = (artifactVersions.get(a.artifactId) ?? 0) + 1;
        artifactVersions.set(a.artifactId, version);
        phaseArtifact.set(t.phase, { artifactId: a.artifactId, title: a.title, version });
        events.push({
          type: 'artifact.versioned',
          actor: { kind: 'agent', id: t.role },
          subject: { kind: 'artifact', id: a.artifactId },
          severity: 'notable',
          data: { artifactId: a.artifactId, kind: a.kind, title: a.title, version },
        });
      }
      if (t.metric)
        events.push(
          ...metricEvents().filter((e) => e.type === 'metric.updated' && e.data.key === t.metric),
        );
      events.push(agentRefresh(t.role));
      await send(...events);
    } else if (outcome.outcome === 'cancelled') {
      events.push(taskMove(t, 'cancelled', 'Removed from scope'), agentRefresh(t.role));
      await send(...events);
    } else if (outcome.outcome === 'waiting') {
      // Another task still has to make what this one needs: park it, no card, and start it again
      // once those tasks finish. Only a wait no task can end comes to the Director.
      const w = outcome.waiting;
      const back = (w.sendBack ?? []).filter(
        (x) => x.taskId !== t.taskId && task(x.taskId)?.kind === 'work',
      );
      // Fixes for a task whose phase hasn't started travel in its brief: it gets them when it
      // runs, and nothing waits on it (that phase starts only once this one is done).
      const handOn = patched('send-back-later-phase')
        ? back.filter((x) => {
            const d = task(x.taskId)!;
            return d.phase > t.phase && !started.has(d.phase) && stateOf(x.taskId) !== 'done';
          })
        : [];
      const backNow = back.filter((x) => !handOn.includes(x));
      const named = [...new Set([...w.taskIds, ...backNow.map((x) => x.taskId)])].filter(
        (id) => id !== t.taskId && task(id)?.kind === 'work',
      );
      const cycle = named.some((id) => waitingOn.get(id)?.ids.includes(t.taskId));
      const overSent = backNow.filter((x) => (sentBack[x.taskId] ?? 0) >= MAX_SEND_BACKS);
      const count = (waits[t.taskId] = (waits[t.taskId] ?? 0) + 1);
      const asked = [...w.taskIds, ...(w.sendBack ?? []).map((x) => x.taskId)];
      const problem =
        !named.length && !handOn.length
          ? `it named no task in the plan that makes it (${asked.join(', ')})`
          : cycle
            ? `${named.map(titleOf).join(', ')} wait on this task in turn`
            : overSent.length
              ? `${overSent.map((x) => titleOf(x.taskId)).join(', ')} were already sent back ${MAX_SEND_BACKS} times`
              : count > MAX_WAITS
                ? `it has waited ${MAX_WAITS} times and it is still missing`
                : null;
      if (problem) {
        await send(...events);
        return onOutcome(t, {
          outcome: 'needs_decision',
          state: outcome.state,
          attempt: outcome.attempt,
          spent: { tokens: 0, usd: 0 },
          decision: {
            summary: `${w.summary} It waits on ${w.what}, but ${problem}.`,
            question: clip(`${t.title}: what it needs is missing`),
            options: ['Retry: look for it again', 'Retry, and work around what is missing'],
            recommended: 'Retry: look for it again',
          },
        });
      }
      // Finished work that must change goes back to its owner, with the fixes in its brief.
      const by = `${roles.get(t.role)?.name ?? t.role} (${t.title})`;
      for (const x of handOn) {
        const note = `Handed on by ${by}: ${x.fixes}`;
        if (!(instructions[x.taskId] ?? '').includes(note))
          instructions[x.taskId] = [instructions[x.taskId], note].filter(Boolean).join('\n\n');
      }
      for (const x of backNow) {
        sentBack[x.taskId] = (sentBack[x.taskId] ?? 0) + 1;
        const note = `Sent back by ${by}: ${x.fixes}`;
        if (stateOf(x.taskId) === 'done') {
          await rerun([x.taskId], note, `Sent back by ${by}`);
          reruns.add(x.taskId);
        } else {
          instructions[x.taskId] = [instructions[x.taskId], note].filter(Boolean).join('\n\n');
        }
      }
      // A task in a phase that hasn't started can't be waited on: that phase starts only once
      // this one is done. Finish now and leave the rest to it.
      const later = patched('wait-later-phase')
        ? named.filter((id) => task(id)!.phase > t.phase && !started.has(task(id)!.phase))
        : [];
      const open = named.filter((id) => !SETTLED_STATES.has(stateOf(id)) && !later.includes(id));
      waitingOn.set(t.taskId, {
        ids: open,
        what: w.what,
        prior: prior ?? null,
        note:
          [
            later.length
              ? `${later.map(titleOf).join(', ')} run${later.length === 1 ? 's' : ''} in a later phase, which starts only after this one is done, so this task can't wait for ${later.length === 1 ? 'it' : 'them'}. Finish what is yours now, don't wait on ${later.length === 1 ? 'it' : 'them'} again, and say in your summary what is left for ${later.length === 1 ? 'it' : 'them'}.`
              : '',
            handOn.length
              ? `Your fixes for ${handOn.map((x) => titleOf(x.taskId)).join(', ')} are in ${handOn.length === 1 ? 'its' : 'their'} brief for when ${handOn.length === 1 ? 'it runs' : 'they run'} in a later phase. Don't wait on or send back to ${handOn.length === 1 ? 'it' : 'them'} again: finish now, and say in your summary what you handed on.`
              : '',
          ]
            .filter(Boolean)
            .join(' ') || undefined,
      });
      events.push(
        taskMove(t, 'waiting', `Waiting on ${named.map(titleOf).join(', ')}: ${w.what}`),
        agentRefresh(t.role),
      );
      await send(...events);
      poke();
    } else if (outcome.outcome === 'needs_decision') {
      // The agent's own decision flag: the Director sees its question, options and recommendation.
      const d = outcome.decision;
      events.push(taskMove(t, 'blocked', 'Needs a decision'), agentRefresh(t.role));
      await send(...events);
      const options = d.options.map((label, i) => ({
        id: `opt-${i + 1}`,
        label,
        recommended: label === d.recommended,
      }));
      const recommended = options.find((o) => o.recommended) ?? options[0]!;
      recommended.recommended = true;
      const escalationId = await raise(
        {
          type: 'decision',
          title: clip(d.question),
          context: `${roles.get(t.role)?.name ?? t.role}: ${d.summary}`,
          impact: `${t.title} and its dependents wait. Other work continues.`,
          options,
          defaultOptionId: recommended.id,
          evidence: [{ kind: 'log', label: 'Agent session', ref: `task:${t.taskId}` }],
          sourceTaskId: t.taskId,
          gate: null,
        },
        {
          kind: 'agent-decision',
          taskId: t.taskId,
          question: d.question,
          options: options.map((o) => ({ id: o.id, label: o.label })),
        },
      );
      taskEscalation.set(t.taskId, escalationId);
    } else {
      const access = outcome.outcome === 'access_denied';
      const unconnected = outcome.outcome === 'access_denied' && outcome.notConnected;
      events.push(
        taskMove(
          t,
          'blocked',
          unconnected ? 'Not connected' : access ? 'Access denied' : 'Escalated',
        ),
      );
      events.push(agentRefresh(t.role));
      await send(...events);
      const escalationId = await raise(
        unconnected
          ? {
              type: 'access',
              title: clip(`Not connected: ${t.title}`),
              context: `${roles.get(t.role)?.name ?? t.role} did not run: ${outcome.reason}`,
              impact: `${t.title} and the tasks that depend on it wait. Other work continues.`,
              options: [
                { id: 'retry', label: 'The tools are connected now; retry', recommended: true },
                {
                  id: 'accept',
                  label: 'Skip it: mark the task done without output',
                  recommended: false,
                },
              ],
              defaultOptionId: null,
              evidence: [{ kind: 'log', label: 'Task', ref: `task:${t.taskId}` }],
              sourceTaskId: t.taskId,
              gate: null,
            }
          : access
            ? {
                type: 'access',
                title: clip(`Access denied: ${t.title}`),
                context: `${roles.get(t.role)?.name ?? t.role} was refused by a target system. ${outcome.reason}`,
                impact: `${t.title} and the tasks that depend on it wait. Other work continues.`,
                options: [
                  { id: 'retry', label: 'I fixed access; re-verify and retry', recommended: true },
                ],
                defaultOptionId: null,
                evidence: [{ kind: 'log', label: 'Failed call', ref: `task:${t.taskId}` }],
                sourceTaskId: t.taskId,
                gate: null,
              }
            : {
                type: 'decision',
                title: clip(`${t.title}: needs a decision`),
                context: `The Lead rejected this output and retries did not fix it. ${outcome.reason}`,
                impact: `${t.title} and its dependents wait. Other work continues.`,
                options: [
                  { id: 'retry', label: 'Retry with the Lead feedback', recommended: true },
                  { id: 'accept', label: 'Accept the current output', recommended: false },
                ],
                defaultOptionId: 'retry',
                evidence: [{ kind: 'log', label: 'Rejections', ref: `task:${t.taskId}` }],
                sourceTaskId: t.taskId,
                gate: null,
              },
        { kind: 'blocked', taskId: t.taskId },
      );
      taskEscalation.set(t.taskId, escalationId);
    }
    poke();
  }

  async function account(result: AgentResult, events: NewEvent[]) {
    spent.tokens += result.tokens;
    spent.usd = Math.round((spent.usd + result.usd) * 100) / 100;
    const hours = Math.round(((Date.now() - startedAt) / 3_600_000) * 100) / 100;
    events.push({
      type: 'budget.updated',
      actor: SYSTEM,
      subject: { kind: 'project', id: projectId },
      severity: 'routine',
      data: { spent: { tokens: spent.tokens, usd: spent.usd, hours } },
    });
    const ratio = budgetRatio(hours);
    if (ratio >= 1 && !hardStopped) {
      hardStopped = true;
      budgetPaused = true;
      projectPaused = true;
      events.push(
        {
          type: 'project.status',
          actor: SYSTEM,
          subject: { kind: 'project', id: projectId },
          severity: 'warning',
          data: { status: 'paused' },
        },
        ...say(
          'text',
          'Budget exhausted',
          'The project reached its hard budget limit and is paused. Raise the budget in Settings or resume to continue.',
        ),
      );
      signalAll(pauseTask);
    } else if (ratio >= BUDGET_SOFT && !softWarned) {
      softWarned = true;
      budgetHold = true;
      track(
        raise(
          {
            type: 'budget',
            title: `Budget at ${Math.round(ratio * 100)}%`,
            context: `The project has used ${Math.round(ratio * 100)}% of its budget ($${spent.usd.toFixed(2)}, ${spent.tokens.toLocaleString('en-US')} tokens). New tasks wait until you acknowledge.`,
            impact: 'Running tasks finish; nothing new starts.',
            options: [
              { id: 'continue', label: 'Continue to the hard limit', recommended: true },
              { id: 'pause', label: 'Pause the project', recommended: false },
            ],
            defaultOptionId: null,
            evidence: [],
            sourceTaskId: null,
            gate: null,
          },
          { kind: 'budget' },
        ),
      );
    }
  }

  function signalAll(
    signal: typeof pauseTask | typeof resumeTask,
    predicate: (t: PlannedTask) => boolean = () => true,
  ) {
    const sent = new Set<unknown>();
    for (const [taskId, handle] of children) {
      const t = task(taskId);
      if (!t || !predicate(t) || sent.has(handle)) continue;
      sent.add(handle);
      void handle.signal(signal);
    }
  }

  /** The largest share of any budget used: tokens, dollars or hours since start. */
  function budgetRatio(hours = Math.round(((Date.now() - startedAt) / 3_600_000) * 100) / 100) {
    const { budgets } = policy;
    return Math.max(spent.tokens / budgets.tokens, spent.usd / budgets.usd, hours / budgets.hours);
  }

  async function setProjectPaused(paused: boolean) {
    projectPaused = paused;
    if (!paused) budgetPaused = false;
    await send({
      type: 'project.status',
      actor: DIRECTOR,
      subject: { kind: 'project', id: projectId },
      severity: 'notable',
      data: { status: paused ? 'paused' : 'running' },
    });
    if (paused) signalAll(pauseTask);
    else signalAll(resumeTask, (t) => !held(t));
    poke();
  }

  async function rerun(ids: string[], notes: string | null, why = 'Sent back by the Director') {
    const events: NewEvent[] = [];
    for (const id of rollbackOrder(plan, ids)) {
      const t = task(id);
      if (!t || stateOf(id) !== 'done') continue;
      await acts.rollbackTask({ projectId, task: t });
      events.push(taskMove(t, 'rolled_back', why), taskMove(t, 'ready', 'Queued for re-run'));
      instructions[id] = notes;
    }
    await send(...events);
  }

  /**
   * States a task can be run again from: it ran and isn't running now, or it is queued but not
   * started (a queued task whose phase has ended starts only once it is re-run).
   */
  const RERUNNABLE: TaskState[] = [
    'done',
    'blocked',
    'rejected',
    'waiting',
    'cancelled',
    'rolled_back',
    'ready',
  ];

  /**
   * The Director's "run it again", from any state but in flight: a finished task is rolled back
   * and queued; a stuck one (blocked, rejected, waiting, cancelled) has its card withdrawn and is
   * queued. It runs even if its phase has exited.
   */
  async function rerunOne(taskId: string, notes: string | null, by: string) {
    const t = task(taskId)!;
    const st = stateOf(taskId);
    if (st === 'done') await rerun([taskId], notes);
    else {
      // Every card still open about the task, including one raised a moment ago.
      taskEscalation.delete(taskId);
      for (const [id, e] of escalations)
        if (e.card.sourceTaskId === taskId && unresolved(e)) await supersede(id, by);
      waitingOn.delete(taskId);
      retryFromBlocked.delete(taskId);
      instructions[taskId] = notes;
      if (st !== 'ready') await send(taskMove(t, 'ready', `Run again: ${by}`));
    }
    reruns.add(taskId);
    await send(
      decision(
        `Re-run ${t.title}`,
        notes || 'No new instructions',
        `${by}; it was ${st}.`,
        'director',
        `rerun:${taskId}:${uuid4().slice(0, 8)}`,
        null,
      ),
    );
    poke();
  }

  // -------------------------------------------------------------------------------------------
  // Gates and phases
  // -------------------------------------------------------------------------------------------

  async function raiseGate(
    key: string,
    phase: number,
    coveredTasks: string[],
    checkpoint: PlannedTask | null,
  ) {
    const gate = gates.get(key) ?? { status: 'none', escalationId: null };
    gates.set(key, gate);
    gate.status = 'pending';
    const info = phaseInfo.get(phase)!;
    const artifact = phaseArtifact.get(phase) ?? {
      artifactId: `phase-${phase}-summary`,
      title: `${info.name} summary`,
      version: 1,
    };
    const final = !checkpoint && phase === lastDirectorGate;
    const doneCount = coveredTasks.filter((id) => stateOf(id) === 'done').length;
    const release = checkpoint?.gate === RELEASE_GATE;
    gate.escalationId = await raise(
      release
        ? {
            type: 'gate',
            title: clip(checkpoint!.title),
            context: `${checkpoint!.contract?.inputs ?? checkpoint!.title}. Release-affecting: it changes what the client or Page builder sees. Rollback: ${checkpoint!.contract?.rollback ?? 'not recorded'}`,
            impact: 'The release task runs when you approve; nothing is released before.',
            options: [
              { id: 'approve', label: 'Approve release', recommended: true },
              { id: 'send_back', label: 'Send back with notes', recommended: false },
            ],
            defaultOptionId: null,
            evidence: [],
            sourceTaskId: checkpoint!.taskId,
            gate: {
              phase,
              artifactId: artifact.artifactId,
              artifactVersion: artifact.version,
              requiresConfirmation: false,
            },
          }
        : {
            type: 'gate',
            title: clip(
              checkpoint
                ? `Review the pilot slice`
                : final
                  ? `Accept ${input.name}`
                  : `Approve ${artifact.title} v${artifact.version}`,
            ),
            context: `${doneCount} of ${coveredTasks.length} tasks done. Exit criteria: ${info.exitCriteria}`,
            impact: final
              ? 'Accepting closes the engagement and starts the handover.'
              : 'The next phases start when you approve.',
            options: [
              { id: 'approve', label: final ? 'Accept' : 'Approve', recommended: true },
              { id: 'send_back', label: 'Send back with notes', recommended: false },
            ],
            defaultOptionId: null,
            evidence: [
              {
                kind: 'artifact',
                label: `${artifact.title} v${artifact.version}`,
                ref: `artifact:${artifact.artifactId}`,
              },
            ],
            sourceTaskId: checkpoint?.taskId ?? null,
            gate: {
              phase,
              artifactId: artifact.artifactId,
              artifactVersion: artifact.version,
              requiresConfirmation: final,
            },
          },
      {
        kind: 'gate',
        key,
        phase,
        coveredTasks,
        checkpointTaskId: checkpoint?.taskId ?? null,
      },
    );
  }

  /** First gate approved: the Blueprint expands the plan's placeholders into real tasks. */
  async function adoptBlueprint() {
    const next = await acts.loadBlueprint(projectId);
    const newPlan = compilePlan(playbook, next, {
      enabledGates: policy.enabledGates,
      features: policy.features,
    });
    await applyPlan(newPlan, next, `blueprint-v${next.version}`);
    await send(...metricEvents());
  }

  async function enterPhase(n: number) {
    started.add(n);
    const info = phaseInfo.get(n)!;
    const active = playbook.roles.filter(
      (r) => r.tier === 'specialist' && Array.isArray(r.activePhases) && r.activePhases.includes(n),
    );
    const count = plan.tasks.filter((t) => t.phase === n).length;
    await send(
      {
        type: 'phase.entered',
        actor: CHIEF,
        subject: { kind: 'phase', id: String(n) },
        severity: 'notable',
        data: { phase: n },
      },
      ...active
        .filter((r) => agentStates.get(r.role) === 'inactive')
        .map((r) => agentRefresh(r.role)),
      ...say(
        'phase_brief_entry',
        `Phase ${n} brief: ${info.name}`,
        [
          `Active: ${active.map((r) => r.name).join(', ') || 'Chief of Staff'}.`,
          `${count} task${count === 1 ? '' : 's'} planned.`,
          `Exit: ${info.exitCriteria}`,
          ...(info.gate === 'director'
            ? ['This phase ends at a gate that needs your approval.']
            : []),
        ].join('\n'),
      ),
    );
  }

  async function exitPhase(n: number) {
    done.add(n);
    const info = phaseInfo.get(n)!;
    const tasks = plan.tasks.filter((t) => t.phase === n && t.kind !== 'checkpoint');
    const reworked = tasks.filter((t) => (attempts[t.taskId] ?? 0) > 1).length;
    const leaving = playbook.roles.filter(
      (r) => r.tier === 'specialist' && agentStates.get(r.role) === 'idle',
    );
    await send(
      {
        type: 'phase.exited',
        actor: CHIEF,
        subject: { kind: 'phase', id: String(n) },
        severity: 'notable',
        data: { phase: n },
      },
      ...leaving.map((r) => agentRefresh(r.role)),
      ...say(
        'phase_brief_exit',
        `Phase ${n} complete: ${info.name}`,
        [
          `${tasks.filter((t) => stateOf(t.taskId) === 'done').length} of ${tasks.length} tasks done.`,
          ...(reworked ? [`${reworked} needed Lead rework.`] : []),
        ].join('\n'),
      ),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Re-planning
  // -------------------------------------------------------------------------------------------

  async function applyPlan(newPlan: Plan, newBlueprint: Blueprint, cause: string) {
    const diff = diffPlans(plan, newPlan);
    const events: NewEvent[] = [];
    for (const t of diff.removed) {
      const s = stateOf(t.taskId);
      const esc = taskEscalation.get(t.taskId);
      if (esc) await supersede(esc, cause);
      if (children.has(t.taskId)) void children.get(t.taskId)!.signal(cancelTask, t.taskId);
      else if (s === 'done') {
        await acts.rollbackTask({ projectId, task: t });
        events.push(taskMove(t, 'rolled_back', 'Removed from scope'));
      } else if (s !== 'cancelled' && s !== 'rolled_back') {
        events.push(
          taskMove(
            t,
            'cancelled',
            t.kind === 'placeholder' ? 'Expanded by the Blueprint' : 'Removed from scope',
          ),
        );
      }
    }
    for (const c of diff.changed) {
      if (stateOf(c.after.taskId) === 'done' && c.fields.some((f) => f !== 'dependsOn')) {
        await acts.rollbackTask({ projectId, task: c.before });
        events.push(
          taskMove(c.after, 'rolled_back', 'Scope changed'),
          taskMove(c.after, 'ready', 'Queued for re-run'),
        );
      }
    }
    plan = newPlan;
    blueprint = newBlueprint;
    events.push(...diff.added.map(planned));
    await send(...events);
    poke();
  }

  async function onDirective(text: string) {
    await send(
      {
        type: 'director.message',
        actor: DIRECTOR,
        subject: { kind: 'message', id: uuid4() },
        severity: 'routine',
        data: { messageId: uuid4(), body: text },
      },
      {
        type: 'cos.presence',
        actor: CHIEF,
        subject: { kind: 'agent', id: CHIEF.id },
        severity: 'routine',
        data: { presence: 'thinking' },
      },
    );
    const reading = await acts.interpretDirective({
      projectId,
      text,
      blueprint,
      tasks: plan.tasks
        .filter((t) => t.kind === 'work')
        .map((t) => ({ taskId: t.taskId, title: t.title, state: stateOf(t.taskId) })),
    });
    if (reading.kind === 'status') {
      await send(...say('status', 'Status', statusLine(), { sections: statusSections() }));
      return;
    }
    if (reading.kind === 'rerun') {
      // Queued tasks became re-runnable later: a directive read before that replays as it ran.
      const queued = patched('rerun-queued-tasks');
      const can = reading.taskIds.filter(
        (id) =>
          task(id)?.kind === 'work' &&
          RERUNNABLE.includes(stateOf(id)) &&
          (stateOf(id) !== 'ready' || queued) &&
          !children.has(id),
      );
      const busy = reading.taskIds.filter((id) => task(id) && !can.includes(id));
      for (const id of can) await rerunOne(id, reading.notes.trim() || null, 'Asked of Cypher');
      await send(
        ...say(
          'directive_ack',
          'Directive',
          [
            can.length
              ? `Re-running ${can.map(titleOf).join(', ')}${reading.notes.trim() ? `, with your instructions` : ''}.`
              : `Nothing re-run.`,
            busy.length
              ? `${busy.map((id) => `${titleOf(id)} is ${stateOf(id)}`).join('; ')}: ask again once ${busy.length === 1 ? 'it stops' : 'they stop'}.`
              : '',
          ]
            .filter(Boolean)
            .join(' '),
        ),
      );
      return;
    }
    if (reading.kind === 'note' || !blueprint) {
      const interpretation = reading.kind === 'note' ? reading.interpretation : text;
      await send(
        ...say(
          'directive_ack',
          'Directive',
          `Understood: ${interpretation}. No change to the plan.`,
        ),
        decision(
          text,
          interpretation,
          'Director directive; no plan change.',
          'director',
          `directive:${uuid4().slice(0, 8)}`,
          null,
        ),
      );
      return;
    }
    const nextBlueprint: Blueprint = { ...reading.blueprint, version: blueprint.version + 1 };
    const newPlan = compilePlan(playbook, nextBlueprint, {
      enabledGates: policy.enabledGates,
      features: policy.features,
    });
    const impact: Impact = impactOf(
      diffPlans(plan, newPlan),
      states,
      diffBlueprints(blueprint, nextBlueprint),
    );
    const directiveId = `dir-${uuid4().slice(0, 8)}`;
    const d = { stopped: false, settled: false };
    directives.set(directiveId, d);
    const seconds = Math.round(policy.directiveWindowMs / 1000);
    await send(
      ...say(
        'directive_ack',
        'Directive',
        `Understood: ${reading.interpretation}. Impact: ${impact.summary} Proceeding in ${seconds} second${seconds === 1 ? '' : 's'} unless you stop me.`,
        {
          proceedsAt: new Date(Date.now() + policy.directiveWindowMs).toISOString(),
          directiveId,
        },
      ),
    );
    track(
      (async () => {
        const stopped = await condition(() => d.stopped, policy.directiveWindowMs);
        d.settled = true;
        if (stopped) {
          await send(...say('text', null, 'Stopped. Nothing changed.'));
          return;
        }
        // The team kept working during the window: measure the impact again as it applies now
        // (pages migrated meanwhile become rollbacks rather than cancellations).
        const applied = impactOf(
          diffPlans(plan, newPlan),
          states,
          diffBlueprints(blueprint!, nextBlueprint),
        );
        await applyPlan(newPlan, nextBlueprint, directiveId);
        await send(
          ...metricEvents(),
          decision(
            text,
            reading.interpretation,
            applied.summary,
            'director',
            `directive:${directiveId}`,
            null,
          ),
          ...say('text', null, `Applied: ${reading.interpretation}. ${applied.summary}`),
        );
      })(),
    );
  }

  // Canary dispatch: a forEach template's first item(s) run alone; the rest wait until each canary
  // is through, so a tool failure costs one card, not one per item.
  const canaryPassed = (id: string) => {
    const s = stateOf(id);
    if (s === 'done' || s === 'cancelled' || s === 'waiting') return true;
    // A decision about the item itself is content, not tools: it doesn't hold the batch.
    const esc = taskEscalation.get(id);
    return !!esc && escalations.get(esc)?.card.type === 'decision';
  };
  /** The canaries of a task's template, when it has some and this task isn't one of them. */
  const canariesOf = (t: PlannedTask): PlannedTask[] => {
    if (!t.collection) return [];
    const n = templates.get(t.templateId)?.canary ?? 1;
    if (n <= 0) return [];
    const canaries = plan.tasks
      .filter((x) => x.templateId === t.templateId && x.kind === 'work')
      .slice(0, n);
    return canaries.some((c) => c.taskId === t.taskId) ? [] : canaries;
  };
  /** Waits for its template's canary (side-effect free; dispatch also checks the patch). */
  const behindCanary = (t: PlannedTask) => canariesOf(t).some((c) => !canaryPassed(c.taskId));

  /** Titles for a status line: the first few, and how many more. */
  const some = (ids: string[], n = 3) =>
    `${ids.slice(0, n).map(titleOf).join('; ')}${ids.length > n ? `; and ${ids.length - n} more` : ''}`;

  function statusLine() {
    const current = [...started].filter((n) => !done.has(n)).sort((a, b) => a - b);
    if (!current.length)
      return done.size ? 'The project is complete.' : 'The project has not started a phase yet.';
    const phases = current
      .map(
        (n) => `Phase ${n} (${phaseInfo.get(n)!.name}) is ${phasePercent(plan, states, n)}% done.`,
      )
      .join(' ');
    const held = projectPaused
      ? 'The project is paused: nothing starts until you resume it.'
      : budgetHold
        ? 'New work is held at the budget limit until you answer the budget card.'
        : '';
    const running = [...children.keys()];
    const onYou = [...taskEscalation.keys()];
    const onTasks = [...waitingOn.keys()];
    const canaryWait = plan.tasks.filter(
      (t) => t.kind === 'work' && stateOf(t.taskId) === 'ready' && behindCanary(t),
    );
    // What the idle work waits for: unfinished prerequisites that nobody is working on.
    const active = new Set(current);
    const stuck = new Set<string>();
    for (const t of plan.tasks) {
      if (t.kind !== 'work' || !active.has(t.phase) || stateOf(t.taskId) !== 'planned') continue;
      for (const d of t.dependsOn) {
        const st = stateOf(d);
        if (st !== 'done' && st !== 'cancelled' && !children.has(d) && st !== 'ready') stuck.add(d);
      }
    }
    return [
      held,
      phases,
      running.length
        ? `Working now (${running.length}): ${some(running)}.`
        : 'Nobody is working right now.',
      onYou.length ? `Waiting on your answer (${onYou.length}): ${some(onYou)}.` : '',
      onTasks.length ? `Waiting on other tasks (${onTasks.length}): ${some(onTasks)}.` : '',
      !running.length && stuck.size ? `The rest waits on: ${some([...stuck])}.` : '',
      canaryWait.length
        ? `${canaryWait.length} more ${canaryWait.length === 1 ? 'item waits' : 'items wait'} for the first of their batch to get through.`
        : '',
    ]
      .filter(Boolean)
      .join(' ');
  }

  function statusSections(): MessageSection[] {
    const open = [...escalations.values()].filter((e) => e.status === 'open');
    const nextGate = playbook.manifest.phases.find(
      (p) => p.gate === 'director' && !done.has(p.number),
    );
    return [
      {
        heading: 'Blockers',
        lines: open
          .filter((e) => e.card.type === 'blocker' || e.card.type === 'access')
          .map((e) => e.card.title),
      },
      { heading: 'Waiting on you', lines: open.map((e) => `${e.card.type}: ${e.card.title}`) },
      {
        heading: 'Next gate',
        lines: nextGate ? [`Phase ${nextGate.number}: ${nextGate.name}`] : [],
      },
      {
        heading: 'Cost',
        lines: [`$${spent.usd.toFixed(2)} · ${spent.tokens.toLocaleString('en-US')} tokens`],
      },
    ];
  }

  // -------------------------------------------------------------------------------------------
  // Director commands (Temporal updates). Validators reject before anything is recorded.
  // -------------------------------------------------------------------------------------------

  setHandler(
    resolveEscalation,
    async ({ escalationId, optionId, notes }) => {
      await settle(escalationId, optionId, notes ?? null, 'director');
      return { accepted: true };
    },
    {
      validator: ({ escalationId, optionId, notes, confirmation }) => {
        const e = escalations.get(escalationId);
        if (!e) return reject('not_found', `No escalation "${escalationId}".`);
        if (!unresolved(e)) return reject('conflict', 'This escalation is already resolved.');
        if (!e.card.options.some((o) => o.id === optionId))
          return reject('invalid', `Option "${optionId}" is not on this card.`);
        if (e.card.gate && optionId === 'send_back' && !notes)
          return reject('invalid', 'Sending a gate back needs notes.');
        if (
          e.card.gate?.requiresConfirmation &&
          optionId === 'approve' &&
          confirmation !== input.name
        ) {
          return reject('invalid', `Type the project name ("${input.name}") to accept.`);
        }
      },
    },
  );

  setHandler(
    deferEscalation,
    async ({ escalationId, until }) => {
      const e = escalations.get(escalationId)!;
      e.status = 'deferred';
      e.deferredUntil = Date.parse(until);
      await send({
        type: 'escalation.updated',
        actor: DIRECTOR,
        subject: { kind: 'escalation', id: escalationId },
        severity: 'routine',
        data: { escalationId, status: 'deferred', deferredUntil: until, resolution: null },
      });
      return { accepted: true };
    },
    {
      validator: ({ escalationId, until }) => {
        const e = escalations.get(escalationId);
        if (!e) return reject('not_found', `No escalation "${escalationId}".`);
        if (!unresolved(e)) return reject('conflict', 'This escalation is already resolved.');
        if (e.card.type === 'gate')
          return reject('invalid', 'Gates cannot be deferred; approve or send back.');
        if (!(Date.parse(until) > Date.now()))
          return reject('invalid', 'Defer until a time in the future.');
      },
    },
  );

  setHandler(
    postMessage,
    async ({ body }) => {
      const text = body.trim();
      if (/^\/pause\b/.test(text)) await setProjectPaused(true);
      else if (/^\/resume\b/.test(text)) await setProjectPaused(false);
      else await onDirective(text);
      return { accepted: true };
    },
    { validator: ({ body }) => void (body.trim() || reject('invalid', 'The message is empty.')) },
  );

  setHandler(
    stopDirective,
    async ({ directiveId }) => {
      directives.get(directiveId)!.stopped = true;
      return { accepted: true };
    },
    {
      validator: ({ directiveId }) => {
        const d = directives.get(directiveId);
        if (!d) return reject('not_found', `No directive "${directiveId}".`);
        if (d.settled || d.stopped)
          return reject('conflict', 'This directive already applied or was stopped.');
      },
    },
  );

  const scopeRoles = (kind: ScopeKind, id: string): string[] => {
    if (kind === 'agent') return [id];
    const lead = playbook.roles.find((r) => r.tier === 'lead' && r.workstream === id)!;
    return [
      lead.role,
      ...playbook.roles.filter((r) => r.reportsTo === lead.role).map((r) => r.role),
    ];
  };

  const scopeLabel = (kind: ScopeKind, id: string): string => {
    switch (kind) {
      case 'project':
        return input.name;
      case 'workstream':
        return `${id.charAt(0).toUpperCase()}${id.slice(1)} workstream`;
      case 'agent':
        return roles.get(id)?.name ?? id;
      case 'phase':
        return `Phase ${id}: ${phaseInfo.get(Number(id))?.name ?? ''}`;
      case 'task':
        return task(id)?.title ?? id;
    }
  };

  /**
   * A task and everything downstream of it for the same Blueprint item: cancelling "Port Hero"
   * also cancels "Register Hero", but not "Validate components", which carries on without it.
   */
  const cancelSet = (taskId: string): string[] => {
    const root = task(taskId)!;
    const keys = new Set(root.itemKeys);
    const out = new Set([taskId]);
    const queue = [taskId];
    while (queue.length) {
      const id = queue.shift()!;
      for (const t of plan.tasks) {
        if (!out.has(t.taskId) && t.dependsOn.includes(id) && t.itemKeys.some((k) => keys.has(k))) {
          out.add(t.taskId);
          queue.push(t.taskId);
        }
      }
    }
    return [...out];
  };

  const SETTLED_STATES: ReadonlySet<TaskState> = new Set(['done', 'cancelled', 'rolled_back']);

  async function cancelTasks(ids: string[], reason: string) {
    const events: NewEvent[] = [];
    const touched = new Set<string>();
    for (const id of ids) {
      const t = task(id);
      if (!t || SETTLED_STATES.has(stateOf(id))) continue;
      const esc = taskEscalation.get(id);
      if (esc) {
        await supersede(esc, 'cancelled by the Director');
        taskEscalation.delete(id);
      }
      retryFromBlocked.delete(id);
      waitingOn.delete(id);
      touched.add(t.role);
      // A running task stops at its next step boundary and reports itself cancelled.
      if (children.has(id)) void children.get(id)!.signal(cancelTask, id);
      else events.push(taskMove(t, 'cancelled', reason));
    }
    events.push(...[...touched].map((r) => agentRefresh(r)));
    await send(...events, ...metricEvents());
    poke();
  }

  setHandler(
    control,
    async ({ verb, scope }) => {
      const label = scopeLabel(scope.kind, scope.id);
      if (verb === 'cancel') {
        const ids =
          scope.kind === 'task'
            ? cancelSet(scope.id)
            : scope.kind === 'phase'
              ? plan.tasks.filter((t) => t.phase === Number(scope.id)).map((t) => t.taskId)
              : plan.tasks.map((t) => t.taskId);
        if (scope.kind === 'phase') cancelledPhases.add(Number(scope.id));
        await send(
          decision(
            `Cancel ${label}`,
            'Cancelled',
            `${ids.length} task(s) cancelled by the Director.`,
            'director',
            `cancel:${scope.kind}:${scope.id}`,
            null,
          ),
        );
        await cancelTasks(ids, 'Cancelled by the Director');
        if (scope.kind === 'project') {
          for (const e of escalations.keys()) await supersede(e, 'project cancelled');
          await condition(() => children.size === 0);
          await send({
            type: 'project.status',
            actor: DIRECTOR,
            subject: { kind: 'project', id: projectId },
            severity: 'notable',
            data: { status: 'cancelled' },
          });
          completed = true;
          poke();
        }
        return { accepted: true };
      }

      const pause = verb === 'pause';
      await send({
        type: 'control.hold',
        actor: DIRECTOR,
        subject: { kind: 'project', id: projectId },
        severity: 'notable',
        data: { scope, held: pause, label },
      });
      if (scope.kind === 'project') {
        await setProjectPaused(pause);
        return { accepted: true };
      }
      if (scope.kind === 'phase') {
        const n = Number(scope.id);
        if (pause) pausedPhases.add(n);
        else pausedPhases.delete(n);
      } else if (scope.kind === 'task') {
        if (pause) pausedTasks.add(scope.id);
        else pausedTasks.delete(scope.id);
      } else {
        for (const r of scopeRoles(scope.kind, scope.id)) {
          if (pause) pausedRoles.add(r);
          else pausedRoles.delete(r);
        }
        await send(
          ...scopeRoles(scope.kind, scope.id).map((r) => ({ ...agentRefresh(r), actor: DIRECTOR })),
        );
      }
      const covered = (t: PlannedTask) =>
        scope.kind === 'phase'
          ? t.phase === Number(scope.id)
          : scope.kind === 'task'
            ? t.taskId === scope.id
            : scopeRoles(scope.kind, scope.id).includes(t.role);
      if (pause) signalAll(pauseTask, covered);
      else signalAll(resumeTask, (t) => covered(t) && !held(t));
      poke();
      return { accepted: true };
    },
    {
      validator: ({ verb, scope }) => {
        if (scope.kind === 'agent' && !roles.has(scope.id))
          return reject('not_found', `No agent "${scope.id}".`);
        if (
          scope.kind === 'workstream' &&
          !playbook.roles.some((r) => r.tier === 'lead' && r.workstream === scope.id)
        ) {
          return reject('not_found', `No workstream "${scope.id}".`);
        }
        if (scope.kind === 'phase' && !phaseInfo.has(Number(scope.id)))
          return reject('not_found', `No phase "${scope.id}".`);
        if (scope.kind === 'task' && !task(scope.id))
          return reject('not_found', `No task "${scope.id}".`);

        if (verb === 'cancel') {
          if (scope.kind === 'agent' || scope.kind === 'workstream') {
            return reject(
              'not_supported',
              `Cancel a task, a phase or the project; pause a ${scope.kind} instead.`,
            );
          }
          if (scope.kind === 'task' && SETTLED_STATES.has(stateOf(scope.id)))
            return reject('conflict', 'This task already finished.');
          if (scope.kind === 'phase' && done.has(Number(scope.id)))
            return reject('conflict', 'This phase already finished.');
          return;
        }
        if (scope.kind === 'project') {
          if (verb === 'pause' && projectPaused)
            return reject('conflict', 'The project is already paused.');
          if (verb === 'resume' && !projectPaused)
            return reject('conflict', 'The project is not paused.');
          return;
        }
        if (scope.kind === 'phase') {
          const n = Number(scope.id);
          if (verb === 'pause' && pausedPhases.has(n))
            return reject('conflict', 'This phase is already paused.');
          if (verb === 'resume' && !pausedPhases.has(n))
            return reject('conflict', 'This phase is not paused.');
        }
        if (scope.kind === 'task') {
          if (verb === 'pause' && !children.has(scope.id)) {
            return reject(
              'conflict',
              'Only a running task can be paused; pause its phase or workstream to hold queued work.',
            );
          }
          if (verb === 'pause' && pausedTasks.has(scope.id))
            return reject('conflict', 'This task is already paused.');
          if (verb === 'resume' && !pausedTasks.has(scope.id))
            return reject('conflict', 'This task is not paused.');
        }
      },
    },
  );

  setHandler(
    changeBudgets,
    async (budgets) => {
      const before = policy.budgets;
      policy.budgets = budgets;
      // The warnings re-arm against the new limits.
      const ratio = budgetRatio();
      if (ratio < 1) hardStopped = false;
      if (ratio < BUDGET_SOFT) {
        softWarned = false;
        // An open 80% card is answered by the new budget: new work dispatches again.
        budgetHold = false;
        for (const [id, e] of escalations)
          if (e.card.type === 'budget') await supersede(id, 'the Director changed the budgets');
      }
      await send(
        {
          type: 'project.updated',
          actor: DIRECTOR,
          subject: { kind: 'project', id: projectId },
          severity: 'notable',
          data: { budgets },
        },
        decision(
          'Change the project budgets',
          `$${budgets.usd.toLocaleString('en-US')}, ${budgets.tokens.toLocaleString('en-US')} tokens, ${budgets.hours} h`,
          `Was $${before.usd.toLocaleString('en-US')}, ${before.tokens.toLocaleString('en-US')} tokens, ${before.hours} h. Set by the Director.`,
          'director',
          'budgets',
          null,
        ),
      );
      if (budgetPaused && ratio < 1) await setProjectPaused(false);
      poke();
      return { accepted: true };
    },
    {
      validator: (b) => {
        if (!(b.tokens > 0 && b.usd > 0 && b.hours > 0))
          return reject('invalid', 'Budgets must be positive.');
      },
    },
  );

  setHandler(
    rerunTask,
    async ({ taskId, instructions: notes }) => {
      await rerunOne(taskId, notes.trim() || null, 'Sent back by the Director for a fresh attempt');
      return { accepted: true };
    },
    {
      validator: ({ taskId }) => {
        const t = task(taskId);
        if (!t || t.kind !== 'work') return reject('not_found', `No task "${taskId}".`);
        if (!RERUNNABLE.includes(stateOf(taskId)) || children.has(taskId))
          return reject(
            'conflict',
            `${t.title} is ${stateOf(taskId)} right now; re-run it once it stops.`,
          );
      },
    },
  );

  /** The path a task takes to done from where it stands, each step legal on the record. */
  const PATH_TO_DONE: Partial<Record<TaskState, TaskState[]>> = {
    planned: ['ready', 'running', 'validating', 'done'],
    ready: ['running', 'validating', 'done'],
    blocked: ['running', 'validating', 'done'],
    paused: ['running', 'validating', 'done'],
    rejected: ['running', 'validating', 'done'],
    waiting: ['running', 'validating', 'done'],
    rolled_back: ['ready', 'running', 'validating', 'done'],
  };
  setHandler(
    completeTasks,
    async ({ taskIds, note }) => {
      const why = note.trim();
      for (const id of [...new Set(taskIds)]) {
        const t = task(id)!;
        const path = PATH_TO_DONE[stateOf(id)] ?? [];
        const esc = taskEscalation.get(id);
        if (esc) {
          await supersede(esc, 'done outside the agents');
          taskEscalation.delete(id);
        }
        retryFromBlocked.delete(id);
        reruns.delete(id);
        waitingOn.delete(id);
        await send(
          ...path.map((to) =>
            taskMove(t, to, to === 'done' ? `Done outside the agents: ${why}` : null),
          ),
          agentRefresh(t.role),
        );
        states[id] = 'done';
      }
      await send(
        decision(
          `Record ${taskIds.length} task${taskIds.length === 1 ? '' : 's'} as done`,
          'Done outside the agents',
          `${why} (${taskIds.map(titleOf).join('; ')})`,
          'director',
          `tasks:${taskIds.join(',')}`.slice(0, 200),
          null,
        ),
      );
      poke();
      return { accepted: true };
    },
    {
      validator: ({ taskIds, note }) => {
        if (!taskIds.length || taskIds.length > 200)
          return reject('invalid', 'Name between 1 and 200 tasks.');
        if (!note.trim()) return reject('invalid', 'Say what was done and where.');
        for (const id of taskIds) {
          const t = task(id);
          if (!t || t.kind !== 'work') return reject('not_found', `No task "${id}".`);
          if (children.has(id) || !PATH_TO_DONE[stateOf(id)])
            return reject(
              'conflict',
              `${t.title} is ${stateOf(id)}; it can't be recorded as done.`,
            );
        }
      },
    },
  );

  setHandler(
    undoResolution,
    async ({ escalationId }) => {
      const e = escalations.get(escalationId)!;
      e.pending!.undone = true;
      e.pending = null;
      e.status = 'open';
      if (e.windowMs) e.deadlineAt = Date.now() + e.windowMs;
      await send(updated(escalationId, 'open', null));
      void watch(escalationId);
      return { accepted: true };
    },
    {
      validator: ({ escalationId }) => {
        const e = escalations.get(escalationId);
        if (!e) return reject('not_found', `No escalation "${escalationId}".`);
        if (!e.pending || e.pending.undone)
          return reject('conflict', 'This choice can no longer be undone.');
      },
    },
  );

  // -------------------------------------------------------------------------------------------
  // Main loop
  // -------------------------------------------------------------------------------------------

  const rosterEntries = roster(playbook);
  for (const r of rosterEntries)
    agentStates.set(r.agentId, r.tier === 'specialist' ? 'inactive' : 'idle');
  if (resume) restore(resume);
  else await announce();

  /** Takes over from the previous run: its state, and the deadlines of its open cards. */
  function restore(r: ProjectSnapshot) {
    Object.assign(states, r.states);
    Object.assign(attempts, r.attempts);
    Object.assign(instructions, r.instructions);
    Object.assign(waits, r.waits);
    Object.assign(sentBack, r.sentBack);
    for (const id of r.retryFromBlocked) retryFromBlocked.add(id);
    for (const id of r.reruns) reruns.add(id);
    for (const [id, w] of r.waitingOn) waitingOn.set(id, w);
    for (const [taskId, escId] of r.taskEscalation) taskEscalation.set(taskId, escId);
    for (const n of r.started) started.add(n);
    for (const n of r.done) done.add(n);
    for (const [key, g] of r.gates) gates.set(key, { ...g });
    for (const [role, st] of r.agentStates) agentStates.set(role, st);
    for (const role of r.pausedRoles) pausedRoles.add(role);
    for (const n of r.pausedPhases) pausedPhases.add(n);
    for (const id of r.pausedTasks) pausedTasks.add(id);
    for (const n of r.cancelledPhases) cancelledPhases.add(n);
    for (const [id, v] of r.artifactVersions) artifactVersions.set(id, v);
    for (const [n, a] of r.phaseArtifact) phaseArtifact.set(n, a);
    spent.tokens = r.spent.tokens;
    spent.usd = r.spent.usd;
    ({ projectPaused, budgetHold, softWarned, hardStopped, budgetPaused } = r.flags);
    childRuns = r.childRuns;
    for (const e of r.escalations) {
      escalations.set(e.card.escalationId, { ...e, pending: null });
      void watch(e.card.escalationId);
    }
  }

  /** Everything the next run needs, taken when nothing is in flight. */
  function snapshot(): ProjectSnapshot {
    return {
      startedAt,
      blueprint,
      plan,
      states: { ...states },
      attempts: { ...attempts },
      instructions: { ...instructions },
      retryFromBlocked: [...retryFromBlocked],
      reruns: [...reruns],
      waitingOn: [...waitingOn],
      waits: { ...waits },
      sentBack: { ...sentBack },
      taskEscalation: [...taskEscalation],
      started: [...started],
      done: [...done],
      gates: [...gates].map(([key, g]) => [key, { ...g }]),
      escalations: [...escalations.values()].filter(unresolved).map((e) => ({
        card: e.card,
        status: e.status,
        deadlineAt: e.deadlineAt,
        windowMs: e.windowMs,
        deferredUntil: e.deferredUntil,
        resolver: e.resolver,
      })),
      agentStates: [...agentStates],
      pausedRoles: [...pausedRoles],
      pausedPhases: [...pausedPhases],
      pausedTasks: [...pausedTasks],
      cancelledPhases: [...cancelledPhases],
      artifactVersions: [...artifactVersions],
      phaseArtifact: [...phaseArtifact],
      spent: { ...spent },
      flags: { projectPaused, budgetHold, softWarned, hardStopped, budgetPaused },
      childRuns,
      run: (resume?.run ?? 1) + 1,
    };
  }

  async function announce() {
    const created: NewEvent[] = input.registered
      ? []
      : [
          {
            type: 'project.created',
            actor: SYSTEM,
            subject: { kind: 'project', id: projectId },
            severity: 'notable',
            data: {
              name: input.name,
              client: input.client,
              playbook: { id: playbook.manifest.id, version: playbook.manifest.version },
              budgets: policy.budgets,
              phases: phaseDefs(playbook),
              roster: rosterEntries,
              site: { sourceUrl: input.site?.sourceUrl ?? null },
            },
          },
        ];
    await send(
      ...created,
      {
        type: 'project.status',
        actor: SYSTEM,
        subject: { kind: 'project', id: projectId },
        severity: 'notable',
        data: { status: 'running' },
      },
      ...plan.tasks.map(planned),
      ...rosterEntries
        .filter((r) => r.tier !== 'specialist')
        .map((r) => agent(r.agentId, 'idle', null, null)),
      ...say(
        'text',
        'Intake brief',
        `${input.name} for ${input.client} is set up on playbook ${playbook.manifest.id} ${playbook.manifest.version}. The plan has ${plan.phases.length} phases; the team starts with access verification.`,
      ),
    );
  }

  /** One pass of scheduling. Returns true when it changed something, so the caller loops again. */
  async function step(): Promise<boolean> {
    if (projectPaused) return false;
    let progressed = false;

    for (const n of startablePhases(plan, done, started)) {
      if (projectPaused) return progressed;
      await enterPhase(n);
      progressed = true;
    }
    const active = new Set([...started].filter((n) => !done.has(n)));

    // Checkpoints: complete on their own, or wait on their optional gate.
    for (const t of plan.tasks) {
      if (t.kind !== 'checkpoint' || !active.has(t.phase)) continue;
      const s = stateOf(t.taskId);
      if (
        (s !== 'planned' && s !== 'ready') ||
        !t.dependsOn.every((d) => stateOf(d) === 'done' || stateOf(d) === 'cancelled')
      )
        continue;
      if (!t.gate) {
        await send(...completeCheckpoint(t, 'Pilot slice complete'));
        progressed = true;
      } else if ((gates.get(t.taskId)?.status ?? 'none') === 'none') {
        await raiseGate(t.taskId, t.phase, t.dependsOn, t);
        progressed = true;
      }
    }

    // Parked tasks whose prerequisites finished go back in the queue.
    for (const [id, w] of [...waitingOn]) {
      if (!w.ids.every((d) => SETTLED_STATES.has(stateOf(d)))) continue;
      waitingOn.delete(id);
      const t = task(id);
      if (!t || stateOf(id) !== 'waiting') continue;
      instructions[id] = [
        w.prior,
        w.note && !w.ids.length
          ? w.note
          : `What you waited for (${w.what}) should exist now: ${w.ids.length ? `${w.ids.map(titleOf).join(', ')} finished` : 'the tasks you named had finished'}. Check it, and carry on from where you stopped.${w.note ? ` ${w.note}` : ''}`,
      ]
        .filter(Boolean)
        .join('\n\n');
      // Released after its phase ended, it still runs (only active phases' tasks start otherwise).
      if (patched('released-waits-run')) reruns.add(id);
      await send(taskMove(t, 'ready', 'What it waited on is finished'));
      progressed = true;
    }

    // Retries released by escalation answers.
    for (const id of [...retryFromBlocked]) {
      retryFromBlocked.delete(id);
      const t = task(id);
      if (t && stateOf(id) === 'blocked') {
        await dispatch([t], 'blocked');
        progressed = true;
      }
    }

    // New work, under the concurrency limit, unless a budget acknowledgement is pending.
    if (!budgetHold) {
      // Concurrency counts agent sessions; a batch of pages is one session.
      const inFlight = () => new Set(children.values()).size;
      const eligible = plan.tasks.filter((t) => {
        const st = stateOf(t.taskId);
        return (
          t.kind === 'work' &&
          (active.has(t.phase) || reruns.has(t.taskId)) &&
          (st === 'planned' || st === 'ready') &&
          !children.has(t.taskId) &&
          !held(t) &&
          t.dependsOn.every((d) => stateOf(d) === 'done' || stateOf(d) === 'cancelled') &&
          !(behindCanary(t) && patched('canary-dispatch'))
        );
      });
      const taken = new Set<string>();
      for (const t of eligible) {
        // A pause or budget hold can land while this pass awaits an activity; re-check each time.
        if (projectPaused || budgetHold || inFlight() >= policy.concurrency) break;
        if (taken.has(t.taskId) || held(t)) continue;
        const batch = eligible
          .filter((o) => !taken.has(o.taskId) && o.templateId === t.templateId && !held(o))
          .slice(0, Math.max(1, t.batchSize));
        for (const b of batch) taken.add(b.taskId);
        await dispatch(batch, 'ready');
        progressed = true;
      }
    }

    // Nobody working, nothing waiting on the Director, yet tasks wait on each other: no wait can
    // end, so release them all to finish what is theirs.
    if (
      waitingOn.size &&
      !children.size &&
      !projectPaused &&
      !budgetHold &&
      ![...escalations.values()].some((e) => e.status === 'open') &&
      patched('release-stalled-waits')
    ) {
      for (const [id, w] of [...waitingOn]) {
        waitingOn.delete(id);
        const t = task(id);
        if (!t || stateOf(id) !== 'waiting') continue;
        instructions[id] = [
          w.prior,
          `Nothing is working on what you waited for (${w.what}): the tasks that would make it can't start until this work moves. Finish what is yours now, don't wait on ${w.ids.length ? w.ids.map(titleOf).join(', ') : 'them'} again, and say in your summary what is left and for whom.`,
        ]
          .filter(Boolean)
          .join('\n\n');
        // Released after its phase ended, it still runs (only active phases' tasks start otherwise).
        if (patched('released-waits-run')) reruns.add(id);
        await send(taskMove(t, 'ready', 'Released: what it waited on could not move'));
        progressed = true;
      }
    }

    // Phase exits, after their gate where there is one.
    for (const n of [...active].sort((a, b) => a - b)) {
      if (!phaseComplete(plan, states, n)) continue;
      const info = phaseInfo.get(n)!;
      const key = `phase-${n}`;
      const gate = gates.get(key)?.status ?? 'none';
      if (info.gate === 'director' && gate !== 'approved' && !cancelledPhases.has(n)) {
        if (gate === 'none') {
          await raiseGate(
            key,
            n,
            plan.tasks.filter((t) => t.phase === n && t.kind === 'work').map((t) => t.taskId),
            null,
          );
          progressed = true;
        }
        continue;
      }
      await exitPhase(n);
      progressed = true;
    }

    if (done.size === plan.phases.length && !completed) {
      completed = true;
      await send(
        {
          type: 'project.status',
          actor: SYSTEM,
          subject: { kind: 'project', id: projectId },
          severity: 'notable',
          data: { status: 'completed' },
        },
        ...say(
          'text',
          'Project complete',
          'This project is complete. Open the handover pack in Workbench.',
        ),
      );
    }
    return progressed;
  }

  const continueAt = policy.continueAsNewAt ?? 4_000;
  /**
   * Past the history threshold, the run hands over to a fresh one so a restarted worker never
   * replays a long history. Patch-gated: runs started on earlier code replay as they ran.
   */
  const historyFull = () => {
    const info = workflowInfo();
    return (
      (info.continueAsNewSuggested || info.historyLength >= continueAt) &&
      patched('continue-as-new')
    );
  };
  /** Nothing in flight: no agent session, no undo or directive window. */
  const quiet = () =>
    busy === 0 &&
    children.size === 0 &&
    ![...escalations.values()].some((e) => e.pending) &&
    [...directives.values()].every((d) => d.settled);
  const continueAsNew = makeContinueAsNewFunc<typeof projectWorkflow>({
    workflowTaskTimeout: '60 seconds',
  });

  while (!completed) {
    if (historyFull()) {
      // Nothing new starts; the run waits for what is in flight, then hands over.
      await condition(() => quiet() || completed);
      await condition(allHandlersFinished);
      if (!completed && quiet())
        await continueAsNew({ ...input, policy, registered: true, resume: snapshot() });
      continue;
    }
    while (await step()) {
      /* keep scheduling until nothing changes */
    }
    if (completed) break;
    if (historyFull()) continue;
    await condition(() => wake);
    wake = false;
  }
  await condition(allHandlersFinished);
}

/** A card title: the first sentence, cut at a word under ~100 characters. */
function clip(s: string) {
  const first = s.split(/(?<=[.?!])\s/)[0]!.trim();
  if (first.length <= 100) return first;
  const cut = first.slice(0, 99);
  const at = cut.lastIndexOf(' ');
  return `${(at > 60 ? cut.slice(0, at) : cut).replace(/[,;:]$/, '')}…`;
}
