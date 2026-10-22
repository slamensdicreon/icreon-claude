import { randomUUID } from 'node:crypto';
import type {
  AgentState,
  Control,
  CosMessageKind,
  EscalationCard,
  MessageSection,
  MetricKey,
  NewEvent,
  Severity,
  TaskState,
  Workstream,
} from '@lw/contracts';
import { assertTransition } from '@lw/domain';
import type { EventStore } from '@lw/events';
import { phaseDefs, roster, type Playbook } from '@lw/playbook-sdk';
import { Latch, rng, sleep, SimulationStopped, type Rng } from './runtime';

export interface SimulationOptions {
  projectId: string;
  name: string;
  client: string;
  /** Speed multiplier. 1 ≈ a full engagement in about ten minutes; tests use 10_000+. */
  speed?: number;
  seed?: number;
  /** Auto-answer gates and default-less escalations (tests, unattended demos). */
  autopilot?: boolean;
  /** Real-time length of the directive stop window, before speed scaling. Spec: 30 s. */
  directiveWindowSec?: number;
}

/** A command the simulator cannot act on, surfaced to the API as a 4xx with a plain message. */
export class CommandError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type EscalationInput = Omit<
  EscalationCard,
  'escalationId' | 'deadline' | 'evidence' | 'gate' | 'options'
> & {
  options: { id: string; label: string; recommended?: boolean }[];
  deadlineSimSeconds?: number;
  evidence?: EscalationCard['evidence'];
  gate?: EscalationCard['gate'];
};

interface PendingEscalation {
  card: EscalationCard;
  resolve: (optionId: string) => void;
  timer: NodeJS.Timeout | null;
}

/**
 * Plays a scripted engagement through the real event store, and reacts to Director commands the
 * way the orchestrator will: escalations resolve or expire to their default, gates wait, pauses hold
 * work at the next step boundary, directives get an acknowledgement with a stop window.
 */
export class Simulation {
  readonly projectId: string;
  readonly opts: Required<SimulationOptions>;
  readonly rand: Rng;
  private readonly abort = new AbortController();
  private readonly projectLatch = new Latch();
  private readonly agentLatches = new Map<string, Latch>();
  private readonly pending = new Map<string, PendingEscalation>();
  private readonly directives = new Map<string, NodeJS.Timeout>();
  private readonly tasks = new Map<string, { state: TaskState; attempt: number; phase: number }>();
  private readonly agentNow = new Map<
    string,
    { state: AgentState; now: string | null; taskId: string | null }
  >();
  private spent = { tokens: 0, usd: 0, hours: 0 };
  private startedAt = Date.now();
  private finished = false;

  constructor(
    private readonly store: EventStore,
    readonly playbook: Playbook,
    opts: SimulationOptions,
  ) {
    this.projectId = opts.projectId;
    this.opts = {
      speed: 1,
      seed: 1,
      autopilot: false,
      directiveWindowSec: 30,
      ...opts,
    };
    this.rand = rng(this.opts.seed);
    for (const r of roster(playbook)) this.agentLatches.set(r.agentId, new Latch());
  }

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  get done(): boolean {
    return this.finished;
  }

  stop(): void {
    this.abort.abort();
    for (const p of this.pending.values()) if (p.timer) clearTimeout(p.timer);
    for (const t of this.directives.values()) clearTimeout(t);
  }

  /** Runs a scenario to completion (or until stopped). */
  async run(scenario: (sim: Simulation) => Promise<void>): Promise<void> {
    try {
      await scenario(this);
      this.finished = true;
    } catch (e) {
      if (!(e instanceof SimulationStopped)) throw e;
    }
  }

  // -------------------------------------------------------------------------
  // Primitives used by scenarios
  // -------------------------------------------------------------------------

  async emit(...events: NewEvent[]): Promise<number> {
    const stored = await this.store.append(this.projectId, events);
    return stored.at(-1)?.seq ?? (await this.store.head(this.projectId));
  }

  /** Waits `simSeconds` of simulated time, scaled by speed. Holds while the project is paused. */
  async wait(simSeconds: number): Promise<void> {
    await this.projectLatch.wait(this.signal);
    await sleep((simSeconds * 1000) / this.opts.speed, this.signal);
    await this.projectLatch.wait(this.signal);
  }

  async createProject(budgets?: { tokens: number; usd: number; hours: number }) {
    const { manifest } = this.playbook;
    this.startedAt = Date.now();
    await this.emit(
      {
        type: 'project.created',
        actor: system(),
        subject: { kind: 'project', id: this.projectId },
        severity: 'notable',
        data: {
          name: this.opts.name,
          client: this.opts.client,
          playbook: { id: manifest.id, version: manifest.version },
          budgets: budgets ?? manifest.defaults.budgets,
          phases: phaseDefs(this.playbook),
          roster: roster(this.playbook),
        },
      },
      this.projectStatus('running'),
    );
  }

  projectStatus(status: 'running' | 'paused' | 'completed' | 'cancelled'): NewEvent {
    return {
      type: 'project.status',
      actor: system(),
      subject: { kind: 'project', id: this.projectId },
      severity: 'notable',
      data: { status },
    };
  }

  async phase(kind: 'entered' | 'exited', phase: number) {
    await this.emit({
      type: kind === 'entered' ? 'phase.entered' : 'phase.exited',
      actor: { kind: 'chief_of_staff', id: 'chief-of-staff' },
      subject: { kind: 'phase', id: String(phase) },
      severity: 'notable',
      data: { phase },
    });
  }

  async planTasks(
    phase: number,
    tasks: {
      taskId: string;
      role: string;
      title: string;
      workstream: Workstream | null;
      dependsOn?: string[];
    }[],
  ) {
    for (const t of tasks) this.tasks.set(t.taskId, { state: 'planned', attempt: 0, phase });
    await this.emit(
      ...tasks.map((t): NewEvent => ({
        type: 'task.planned',
        actor: system(),
        subject: { kind: 'task', id: t.taskId },
        severity: 'routine',
        data: { ...t, phase, dependsOn: t.dependsOn ?? [] },
      })),
    );
  }

  async move(taskId: string, to: TaskState, reason: string | null = null) {
    const t = this.tasks.get(taskId);
    if (!t) throw new Error(`Unknown task ${taskId}`);
    assertTransition(taskId, t.state, to);
    const from = t.state;
    if (to === 'running' && (from === 'ready' || from === 'rejected')) t.attempt += 1;
    t.state = to;
    await this.emit({
      type: 'task.state',
      actor: system(),
      subject: { kind: 'task', id: taskId },
      severity:
        to === 'rejected' || to === 'blocked' ? 'warning' : to === 'done' ? 'notable' : 'routine',
      data: { taskId, from, to, attempt: t.attempt, reason },
    });
  }

  async agent(
    agentId: string,
    state: AgentState,
    now: string | null = null,
    taskId: string | null = null,
  ) {
    this.agentNow.set(agentId, { state, now, taskId });
    const latch = this.agentLatches.get(agentId);
    // A paused agent stays shown as paused until resumed; remember the state for resume.
    if (latch?.closed) return;
    await this.emit({
      type: 'agent.state',
      actor: { kind: 'agent', id: agentId },
      subject: { kind: 'agent', id: agentId },
      severity: state === 'blocked' || state === 'failed' ? 'warning' : 'routine',
      data: { agentId, state, now, taskId },
    });
  }

  /** One tool call. Holds while the agent (or project) is paused. */
  async step(
    agentId: string,
    taskId: string,
    toolServer: string,
    operation: string,
    summary: string,
    opts: { code?: number; severity?: Severity; simSeconds?: number } = {},
  ) {
    await this.agentLatches.get(agentId)?.wait(this.signal);
    await this.wait(opts.simSeconds ?? this.rand.int(1, 3));
    await this.agentLatches.get(agentId)?.wait(this.signal);
    const tokens =
      toolServer === 'model' ? this.rand.int(4_000, 30_000) : this.rand.int(300, 2_500);
    const code = opts.code ?? 200;
    await this.emit({
      type: 'step.recorded',
      actor: { kind: 'agent', id: agentId },
      subject: { kind: 'step', id: randomUUID() },
      severity: opts.severity ?? (code >= 400 ? 'failure' : 'routine'),
      data: {
        stepId: randomUUID(),
        agentId,
        taskId,
        toolServer,
        operation,
        resultCode: code,
        durationMs: this.rand.int(120, 4_000),
        tokens,
        summary,
      },
    });
    await this.spend(tokens);
  }

  private async spend(tokens: number) {
    // Blended rate across roles; the real ledger prices each call by model.
    this.spent = {
      tokens: this.spent.tokens + tokens,
      usd: round2(this.spent.usd + (tokens / 1_000_000) * 6),
      hours: round2(((Date.now() - this.startedAt) / 3_600_000) * this.opts.speed * 6),
    };
    if (this.rand.next() < 0.25) {
      await this.emit({
        type: 'budget.updated',
        actor: system(),
        subject: { kind: 'project', id: this.projectId },
        severity: 'routine',
        data: { spent: this.spent },
      });
    }
  }

  async metric(key: MetricKey, value: number | null, total: number | null = null) {
    await this.emit({
      type: 'metric.updated',
      actor: system(),
      subject: { kind: 'metric', id: key },
      severity: 'routine',
      data: {
        key,
        value,
        total,
        unit: key === 'qa_pass' || key === 'parity' ? 'percent' : 'count',
      },
    });
  }

  async artifact(
    artifactId: string,
    kind: Extract<NewEvent, { type: 'artifact.versioned' }>['data']['kind'],
    title: string,
    version: number,
    producer: string,
  ) {
    await this.emit({
      type: 'artifact.versioned',
      actor: { kind: 'agent', id: producer },
      subject: { kind: 'artifact', id: artifactId },
      severity: 'notable',
      data: { artifactId, kind, title, version },
    });
  }

  async say(
    kind: CosMessageKind,
    title: string | null,
    body: string,
    sections: MessageSection[] = [],
    extra: { proceedsAt?: string; directiveId?: string } = {},
  ) {
    await this.emit(
      {
        type: 'cos.presence',
        actor: { kind: 'chief_of_staff', id: 'chief-of-staff' },
        subject: { kind: 'agent', id: 'chief-of-staff' },
        severity: 'routine',
        data: { presence: 'briefing' },
      },
      {
        type: 'cos.message',
        actor: { kind: 'chief_of_staff', id: 'chief-of-staff' },
        subject: { kind: 'message', id: randomUUID() },
        severity: 'routine',
        data: {
          messageId: randomUUID(),
          kind,
          title,
          body,
          sections,
          proceedsAt: extra.proceedsAt ?? null,
          directiveId: extra.directiveId ?? null,
        },
      },
      {
        type: 'cos.presence',
        actor: { kind: 'chief_of_staff', id: 'chief-of-staff' },
        subject: { kind: 'agent', id: 'chief-of-staff' },
        severity: 'routine',
        data: { presence: 'listening' },
      },
    );
  }

  async toolHealth(server: string, status: 'ok' | 'degraded' | 'unreachable') {
    await this.emit({
      type: 'tool.health',
      actor: system(),
      subject: { kind: 'tool', id: server },
      severity: status === 'ok' ? 'routine' : 'warning',
      data: { server, status, since: new Date().toISOString() },
    });
  }

  /**
   * Raises an escalation and waits for its answer. With a default option and deadline, the default
   * applies at the deadline ("Expired to default"). Gates and Blockers have no default and wait.
   */
  escalate(card: EscalationInput): Promise<string> {
    const outcome = this.raise(card);
    // Scenarios may start an escalation and await it later; if the simulation stops in between,
    // the rejection must not surface as unhandled. Callers that await it still receive it.
    outcome.catch(() => {});
    return outcome;
  }

  private async raise(card: EscalationInput): Promise<string> {
    const escalationId = `esc-${randomUUID().slice(0, 8)}`;
    const deadlineMs =
      card.defaultOptionId && card.deadlineSimSeconds
        ? (card.deadlineSimSeconds * 1000) / this.opts.speed
        : null;
    const full: EscalationCard = {
      escalationId,
      type: card.type,
      title: card.title,
      context: card.context,
      impact: card.impact,
      options: card.options.map((o) => ({ ...o, recommended: o.recommended ?? false })),
      defaultOptionId: card.defaultOptionId,
      deadline: deadlineMs ? new Date(Date.now() + deadlineMs).toISOString() : null,
      evidence: card.evidence ?? [],
      sourceTaskId: card.sourceTaskId,
      gate: card.gate ?? null,
    };
    const answer = new Promise<string>((resolve) => {
      const p: PendingEscalation = { card: full, resolve, timer: null };
      this.pending.set(escalationId, p);
      if (deadlineMs) p.timer = setTimeout(() => void this.expire(escalationId), deadlineMs);
      if (this.opts.autopilot && !deadlineMs) {
        const rec = full.options.find((o) => o.recommended) ?? full.options[0]!;
        p.timer = setTimeout(
          () =>
            void this.resolve(
              escalationId,
              rec.id,
              'director',
              null,
              full.gate ? this.opts.name : undefined,
            ).catch(() => {}),
          3000 / this.opts.speed,
        );
      }
    });
    await this.emit({
      type: 'escalation.raised',
      actor: { kind: 'chief_of_staff', id: 'chief-of-staff' },
      subject: { kind: 'escalation', id: escalationId },
      severity: card.type === 'risk' ? 'notable' : 'warning',
      data: full,
    });
    const abort = new Promise<never>((_, reject) =>
      this.signal.addEventListener('abort', () => reject(new SimulationStopped()), { once: true }),
    );
    return Promise.race([answer, abort]);
  }

  private async expire(escalationId: string) {
    const p = this.pending.get(escalationId);
    if (!p || !p.card.defaultOptionId) return;
    this.pending.delete(escalationId);
    await this.emit(
      {
        type: 'escalation.updated',
        actor: { kind: 'chief_of_staff', id: 'chief-of-staff' },
        subject: { kind: 'escalation', id: escalationId },
        severity: 'notable',
        data: {
          escalationId,
          status: 'expired',
          deferredUntil: null,
          resolution: {
            optionId: p.card.defaultOptionId,
            notes: null,
            by: 'default',
            supersededBy: null,
          },
        },
      },
      this.decision(p.card, p.card.defaultOptionId, 'default', null),
    );
    p.resolve(p.card.defaultOptionId);
  }

  private decision(
    card: EscalationCard,
    optionId: string,
    decidedBy: 'director' | 'default',
    notes: string | null,
  ): NewEvent {
    const option = card.options.find((o) => o.id === optionId);
    return {
      type: 'decision.recorded',
      actor: decidedBy === 'director' ? { kind: 'director', id: 'director' } : system(),
      subject: { kind: 'escalation', id: card.escalationId },
      severity: 'notable',
      data: {
        decisionId: randomUUID(),
        question: card.title,
        answer: option?.label ?? optionId,
        rationale:
          notes ??
          (decidedBy === 'default'
            ? 'Deadline passed; recommended default applied.'
            : 'Director choice.'),
        decidedBy,
        scopeKey: `${card.type}:${slug(card.title)}`,
        escalationId: card.escalationId,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Director commands (called by the API)
  // -------------------------------------------------------------------------

  async resolve(
    escalationId: string,
    optionId: string,
    by: 'director' = 'director',
    notes: string | null = null,
    confirmation?: string,
  ): Promise<number> {
    const p = this.pending.get(escalationId);
    if (!p)
      throw new CommandError(
        409,
        'not_open',
        'This escalation is already resolved or does not exist.',
      );
    if (!p.card.options.some((o) => o.id === optionId)) {
      throw new CommandError(422, 'unknown_option', `Option "${optionId}" is not on this card.`);
    }
    if (
      p.card.gate?.requiresConfirmation &&
      optionId === 'approve' &&
      confirmation !== this.opts.name
    ) {
      throw new CommandError(
        422,
        'confirmation_required',
        `Type the project name ("${this.opts.name}") to approve the Acceptance gate.`,
      );
    }
    if (p.timer) clearTimeout(p.timer);
    this.pending.delete(escalationId);
    const seq = await this.emit(
      {
        type: 'escalation.updated',
        actor: { kind: 'director', id: 'director' },
        subject: { kind: 'escalation', id: escalationId },
        severity: 'notable',
        data: {
          escalationId,
          status: 'resolved',
          deferredUntil: null,
          resolution: { optionId, notes, by, supersededBy: null },
        },
      },
      this.decision(p.card, optionId, by, notes),
    );
    p.resolve(optionId);
    return seq;
  }

  async defer(escalationId: string, until: Date): Promise<number> {
    const p = this.pending.get(escalationId);
    if (!p)
      throw new CommandError(
        409,
        'not_open',
        'This escalation is already resolved or does not exist.',
      );
    if (p.card.type === 'gate')
      throw new CommandError(
        422,
        'gate_not_deferrable',
        'Gates cannot be deferred; approve or send back.',
      );
    const delay = until.getTime() - Date.now();
    if (delay <= 0) throw new CommandError(422, 'past', 'Defer until a time in the future.');
    if (p.timer) clearTimeout(p.timer);
    // Re-open at `until`; the default deadline restarts from there with the original window.
    const window = p.card.deadline
      ? Date.parse(p.card.deadline) - Date.parse(new Date().toISOString())
      : null;
    p.timer = setTimeout(async () => {
      p.card = {
        ...p.card,
        deadline: window ? new Date(Date.now() + Math.max(window, 0)).toISOString() : null,
      };
      await this.emit({
        type: 'escalation.updated',
        actor: system(),
        subject: { kind: 'escalation', id: escalationId },
        severity: 'warning',
        data: { escalationId, status: 'open', deferredUntil: null, resolution: null },
      });
      if (window) p.timer = setTimeout(() => void this.expire(escalationId), Math.max(window, 0));
    }, delay);
    return this.emit({
      type: 'escalation.updated',
      actor: { kind: 'director', id: 'director' },
      subject: { kind: 'escalation', id: escalationId },
      severity: 'routine',
      data: {
        escalationId,
        status: 'deferred',
        deferredUntil: until.toISOString(),
        resolution: null,
      },
    });
  }

  async postMessage(body: string): Promise<number> {
    let seq = await this.emit(
      {
        type: 'director.message',
        actor: { kind: 'director', id: 'director' },
        subject: { kind: 'message', id: randomUUID() },
        severity: 'routine',
        data: { messageId: randomUUID(), body },
      },
      {
        type: 'cos.presence',
        actor: { kind: 'chief_of_staff', id: 'chief-of-staff' },
        subject: { kind: 'agent', id: 'chief-of-staff' },
        severity: 'routine',
        data: { presence: 'thinking' },
      },
    );
    const text = body.trim();
    if (/^\/?status\b/i.test(text) || /^(what|where).*(status|are we)/i.test(text)) {
      await this.say('status', 'Status', 'Structured status below.', this.statusSections());
      return this.store.head(this.projectId);
    }
    if (text.startsWith('/pause'))
      return this.control({ verb: 'pause', scope: { kind: 'project', id: this.projectId } });
    if (text.startsWith('/resume'))
      return this.control({ verb: 'resume', scope: { kind: 'project', id: this.projectId } });

    // Anything else is a directive: acknowledge with interpreted change, impact, and a stop window.
    const directiveId = `dir-${randomUUID().slice(0, 8)}`;
    const windowMs = (this.opts.directiveWindowSec * 1000) / Math.max(1, this.opts.speed / 10);
    const proceedsAt = new Date(Date.now() + windowMs).toISOString();
    await this.say(
      'directive_ack',
      'Directive',
      `Understood: ${text}. Impact: the simulator does not re-plan, so no tasks change. Proceeding in ${Math.round(windowMs / 1000)} seconds unless you stop me.`,
      [],
      { proceedsAt, directiveId },
    );
    this.directives.set(
      directiveId,
      setTimeout(() => {
        this.directives.delete(directiveId);
        void this.say('text', null, `Applied: ${text}.`).catch(() => {});
      }, windowMs),
    );
    seq = await this.store.head(this.projectId);
    return seq;
  }

  async stopDirective(directiveId: string): Promise<number> {
    const t = this.directives.get(directiveId);
    if (!t)
      throw new CommandError(409, 'not_pending', 'This directive already applied or was stopped.');
    clearTimeout(t);
    this.directives.delete(directiveId);
    await this.say('text', null, 'Stopped. Nothing changed.');
    return this.store.head(this.projectId);
  }

  async control({ verb, scope }: Control): Promise<number> {
    if (verb === 'cancel')
      throw new CommandError(422, 'not_supported', 'Cancel is not supported by the simulator.');
    const agents = this.agentsInScope(scope);
    if (scope.kind === 'project') {
      if (verb === 'pause') {
        if (this.projectLatch.closed)
          throw new CommandError(409, 'already_paused', 'The project is already paused.');
        this.projectLatch.close();
        return this.emit(this.projectStatus('paused'));
      }
      if (!this.projectLatch.closed)
        throw new CommandError(409, 'not_paused', 'The project is not paused.');
      this.projectLatch.open();
      return this.emit(this.projectStatus('running'));
    }
    let seq = await this.store.head(this.projectId);
    for (const agentId of agents) {
      const latch = this.agentLatches.get(agentId)!;
      if (verb === 'pause' && !latch.closed) {
        seq = await this.emit({
          type: 'agent.state',
          actor: { kind: 'director', id: 'director' },
          subject: { kind: 'agent', id: agentId },
          severity: 'notable',
          data: {
            agentId,
            state: 'waiting',
            now: 'Waiting: paused by the Director',
            taskId: this.agentNow.get(agentId)?.taskId ?? null,
          },
        });
        latch.close();
      } else if (verb === 'resume' && latch.closed) {
        latch.open();
        const last = this.agentNow.get(agentId);
        seq = await this.emit({
          type: 'agent.state',
          actor: { kind: 'director', id: 'director' },
          subject: { kind: 'agent', id: agentId },
          severity: 'notable',
          data: {
            agentId,
            state: last?.state ?? 'idle',
            now: last?.now ?? null,
            taskId: last?.taskId ?? null,
          },
        });
      }
    }
    return seq;
  }

  private agentsInScope(scope: Control['scope']): string[] {
    const all = roster(this.playbook);
    switch (scope.kind) {
      case 'project':
        return [];
      case 'agent':
        if (!all.some((a) => a.agentId === scope.id))
          throw new CommandError(404, 'unknown_agent', `No agent "${scope.id}" in this project.`);
        return [scope.id];
      case 'workstream': {
        const lead = all.find((a) => a.tier === 'lead' && a.workstream === scope.id);
        if (!lead)
          throw new CommandError(404, 'unknown_workstream', `No workstream "${scope.id}".`);
        return [
          lead.agentId,
          ...all.filter((a) => a.reportsTo === lead.agentId).map((a) => a.agentId),
        ];
      }
      default:
        throw new CommandError(
          422,
          'not_supported',
          `Pausing a ${scope.kind} is not supported by the simulator yet.`,
        );
    }
  }

  private statusSections(): MessageSection[] {
    const open = [...this.pending.values()];
    return [
      {
        heading: 'Blockers',
        lines: open.filter((p) => p.card.type === 'blocker').map((p) => p.card.title),
      },
      { heading: 'Waiting on you', lines: open.map((p) => `${p.card.type}: ${p.card.title}`) },
      {
        heading: 'Cost',
        lines: [
          `$${this.spent.usd.toFixed(2)} · ${this.spent.tokens.toLocaleString('en-US')} tokens`,
        ],
      },
    ];
  }
}

function system() {
  return { kind: 'system' as const, id: 'orchestrator' };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function slug(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}
