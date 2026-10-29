import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AgentState,
  Control,
  EscalationCard,
  LinkTarget,
  LwEvent,
  NewEvent,
  SettingKey,
  StatusCard,
  TaskState,
} from '@lw/contracts';
import {
  applyEvent,
  canTransition,
  clockTime,
  CommandError,
  createProjectState,
  phaseViews,
  projectSummary,
  upNext,
  type ProjectState,
} from '@lw/domain';
import type { EventStore } from '@lw/events';
import { phaseDefs, roster, type Playbook } from '@lw/playbook-sdk';
import { DemoClock } from './clock';
import type {
  BlueprintRowDef,
  DemoCall,
  DemoEscalation,
  DemoMessage,
  DemoScenario,
  Jump,
  When,
} from './types';

/** Where demo documents keep their images. */
export interface DemoBlobs {
  put(projectId: string, key: string, bytes: Uint8Array, contentType: string): Promise<string>;
}

export interface DemoOptions {
  projectId: string;
  /** Speed multiplier for live activity and escalation deadlines. */
  speed?: number;
  /** Fire the scenario's automatic escalations a few seconds after start. */
  auto?: boolean;
  /** How long a reversible choice can be undone (10 s in the product). */
  undoWindowMs?: number;
  /** How long a directive can be stopped (30 s in the product). */
  directiveWindowMs?: number;
  now?: () => number;
}

const FIXTURES = fileURLToPath(new URL('../../fixtures/', import.meta.url));

const CHIEF = 'chief-of-staff';
const actorFor = (id: string): NewEvent['actor'] =>
  id === 'director'
    ? { kind: 'director', id: 'director' }
    : id === CHIEF
      ? { kind: 'chief_of_staff', id: CHIEF }
      : id === 'tool-server' || id === 'system'
        ? { kind: 'system', id }
        : { kind: 'agent', id };

/** Extra display names the demo's tool servers use beyond the playbook's. */
const EXTRA_TOOLS: Record<string, string> = {
  'content-sdk-cli': 'Content SDK CLI',
  vault: 'Vault',
  'decision-log': 'Decision Log',
};

const ALL_TASK_STATES: TaskState[] = [
  'planned',
  'ready',
  'running',
  'validating',
  'done',
  'rejected',
  'blocked',
  'paused',
  'cancelled',
  'rolled_back',
  'waiting',
];

/** Shortest legal route through the task state machine. */
function route(from: TaskState, to: TaskState): TaskState[] {
  if (from === to) return [];
  const prev = new Map<TaskState, TaskState>();
  const queue: TaskState[] = [from];
  while (queue.length) {
    const s = queue.shift()!;
    for (const n of ALL_TASK_STATES) {
      if (prev.has(n) || n === from || !canTransition(s, n)) continue;
      prev.set(n, s);
      if (n === to) {
        const path: TaskState[] = [to];
        let p = s;
        while (p !== from) {
          path.unshift(p);
          p = prev.get(p)!;
        }
        return path;
      }
      queue.push(n);
    }
  }
  return [to];
}

export const parseMs = (s = '–'): number => {
  const t = s.replace(/\s+/g, '');
  const m = /^(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/.exec(t);
  if (/^\d+(\.\d+)?ms$/.test(t)) return Math.round(parseFloat(t));
  if (m && (m[1] || m[2])) return Math.round((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 1000);
  return 0;
};

export const parseTokens = (s = '–'): number => {
  const m = /^(\d+(?:\.\d+)?)([kM])?$/.exec(s.trim());
  if (!m) return 0;
  return Math.round(Number(m[1]) * (m[2] === 'M' ? 1e6 : m[2] === 'k' ? 1e3 : 1));
};

/** "wb:blueprint" → { artifact, blueprint }. */
export function jumpTarget(j: Jump): LinkTarget {
  const [a, b = ''] = j.split(':');
  switch (a) {
    case 'wb':
      return b === 'decisions' ? { kind: 'decision', ref: '' } : { kind: 'artifact', ref: b };
    case 'inspect':
      return { kind: 'agent', ref: b };
    case 'activity':
      return { kind: 'activity', ref: b };
    case 'preview':
      return { kind: 'preview', ref: b };
    case 'settings':
      return { kind: 'settings', ref: b };
    case 'ext':
      return { kind: 'external', ref: b || 'https://github.com' };
    default:
      return { kind: 'surface', ref: a! };
  }
}

const kebab = (s: string) =>
  s
    .replace(/\(.*?\)/g, '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/\s+/)
    .slice(0, 3)
    .join('-');

export const rowKey = (r: BlueprintRowDef) => r.key ?? kebab(r.target.split(/[,+:]/)[0]!);

interface LiveEscalation {
  def: DemoEscalation;
  card: EscalationCard;
  deadlineTimer: NodeJS.Timeout | null;
  deferTimer: NodeJS.Timeout | null;
  effect: { timer: NodeJS.Timeout; run: () => Promise<void> } | null;
}

/**
 * One of the prototype's demo projects, played through the real event log: history written at
 * scenario times, then live activity, escalations with their deadlines and effects, and the
 * Director's commands. Everything the Control Center shows comes from the events it writes.
 */
export class DemoProject {
  readonly projectId: string;
  readonly clock: DemoClock;
  readonly state: ProjectState;
  private readonly speed: number;
  private readonly now: () => number;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly live = new Map<string, LiveEscalation>();
  private readonly directives = new Map<string, NodeJS.Timeout>();
  private blueprintRows: BlueprintRowDef[] = [];
  private blueprintVersion = 0;
  private ticks = 0;
  private stopped = false;
  private paused = false;
  private readonly startedAt: number;

  constructor(
    private readonly store: EventStore,
    private readonly playbook: Playbook,
    private readonly blobs: DemoBlobs,
    readonly def: DemoScenario,
    private readonly opts: DemoOptions,
  ) {
    this.projectId = opts.projectId;
    this.now = opts.now ?? Date.now;
    this.speed = opts.speed ?? 1;
    this.clock = new DemoClock(def.timezone, def.present[0], def.present[1], this.now());
    this.state = createProjectState(this.projectId);
    this.startedAt = this.now();
  }

  // -------------------------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------------------------

  /** Appends in order (one at a time across timers) and keeps the local read model current. */
  append(events: NewEvent[]): Promise<LwEvent[]> {
    const run = this.chain.then(async () => {
      if (!events.length) return [];
      const stored = await this.store.append(this.projectId, events);
      for (const e of stored) applyEvent(this.state, e);
      return stored;
    });
    this.chain = run.catch(() => {});
    return run;
  }

  at(w: When): string {
    return this.clock.iso(w[0], w[1]);
  }

  /** A real instant `minutes` ago, but never before the scenario's present. */
  private ago(minutes: number): string {
    return new Date(Math.min(this.now(), this.clock.present) - minutes * 60_000).toISOString();
  }

  later(ms: number, fn: () => unknown): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.stopped) void Promise.resolve(fn()).catch(() => {});
    }, ms);
    this.timers.add(t);
  }

  private ev(
    type: NewEvent['type'],
    data: unknown,
    who: string,
    subject: NewEvent['subject'],
    severity: NewEvent['severity'] = 'routine',
    at?: string,
  ): NewEvent {
    return {
      type,
      data,
      actor: actorFor(who),
      subject,
      severity,
      ...(at ? { at } : {}),
    } as NewEvent;
  }

  // -------------------------------------------------------------------------------------------
  // Seeding
  // -------------------------------------------------------------------------------------------

  async seed(): Promise<void> {
    const d = this.def;
    const history: { t: number; e: NewEvent }[] = [];
    const push = (when: When | string, e: NewEvent) => {
      const t = typeof when === 'string' ? Date.parse(when) : this.clock.at(when[0], when[1]);
      history.push({ t, e: { ...e, at: new Date(t).toISOString() } });
    };
    const project = { kind: 'project', id: this.projectId } as const;
    const presentMinus = (min: number) => new Date(this.clock.present - min * 60_000).toISOString();

    const members = roster(this.playbook);
    push(
      d.started,
      this.ev(
        'project.created',
        {
          name: d.name,
          client: d.client,
          playbook: { id: this.playbook.manifest.id, version: this.playbook.manifest.version },
          budgets: d.budgets,
          phases: phaseDefs(this.playbook),
          roster: members,
          initials: d.initials,
          subtitle: d.subtitle,
          timezone: d.timezone,
          source: d.source,
          target: d.target,
          stats: d.stats,
          toolLabels: { ...this.playbook.manifest.defaults.toolLabels, ...EXTRA_TOOLS },
          mode: 'demo',
        },
        'system',
        project,
        'notable',
      ),
    );
    push(d.started, this.ev('project.status', { status: 'running' }, CHIEF, project));
    push(
      d.started,
      this.ev(
        'settings.changed',
        { key: 'gates.pilotReview', value: d.settings.pilotReview },
        'director',
        project,
      ),
    );
    push(
      d.started,
      this.ev(
        'settings.changed',
        { key: 'gates.publishReview', value: d.settings.publishReview },
        'director',
        project,
      ),
    );

    d.credentials.forEach((c, i) => {
      const credentialId = c.sys.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const expiresAt = c.expiresDays
        ? new Date(this.clock.present + c.expiresDays * 86_400_000).toISOString()
        : null;
      push(
        d.started,
        this.ev(
          'credential.registered',
          {
            credentialId,
            system: c.sys,
            scope: c.scope,
            reference: c.verified ? `vault://${this.projectId}/${credentialId}` : null,
            expiresAt,
          },
          'director',
          { kind: 'tool', id: credentialId },
        ),
      );
      if (c.verified)
        push(
          [c.verified[0], c.verified[1] + i / 3600],
          this.ev(
            'credential.verified',
            { credentialId, ok: true, detail: c.scope, expiresAt },
            'system',
            { kind: 'tool', id: credentialId },
          ),
        );
    });

    for (const p of d.phases) {
      push(
        p.entered,
        this.ev(
          'phase.entered',
          { phase: p.number },
          CHIEF,
          { kind: 'phase', id: String(p.number) },
          'notable',
        ),
      );
      if (p.exited)
        push(
          p.exited,
          this.ev(
            'phase.exited',
            { phase: p.number },
            CHIEF,
            { kind: 'phase', id: String(p.number) },
            'notable',
          ),
        );
    }

    // Tasks: planned at the start, scheduled, then moved through their history.
    const roles = new Map(members.map((m) => [m.agentId, m]));
    for (const t of d.tasks) {
      const subject = { kind: 'task', id: t.id } as const;
      push(
        d.started,
        this.ev(
          'task.planned',
          {
            taskId: t.id,
            phase: t.phase,
            workstream:
              t.workstream === undefined ? (roles.get(t.agent)?.workstream ?? null) : t.workstream,
            role: t.agent,
            title: t.title,
            dependsOn: t.deps ?? [],
            group: t.group ?? null,
            groupTitle: t.group ?? null,
            itemKeys: t.itemKeys ?? [],
            estimateHours: t.estimateHours ?? null,
            contract: t.contract ?? null,
          },
          'system',
          subject,
        ),
      );
      push(
        d.started,
        this.ev(
          'task.scheduled',
          { taskId: t.id, start: this.at(t.start), end: this.at(t.end) },
          CHIEF,
          subject,
        ),
      );
      const startT = Math.min(this.clock.at(t.start[0], t.start[1]), this.clock.present - 120_000);
      const endT = Math.min(this.clock.at(t.end[0], t.end[1]), this.clock.present - 60_000);
      const moves = (from: TaskState, to: TaskState, when: number) => {
        let s = from;
        for (const n of route(from, to)) {
          push(
            new Date(when).toISOString(),
            this.ev(
              'task.state',
              { taskId: t.id, from: s, to: n, attempt: 1, reason: null },
              t.agent,
              subject,
              n === 'done' ? 'notable' : 'routine',
            ),
          );
          s = n;
        }
      };
      if (t.state === 'done') {
        moves('planned', 'running', startT);
        moves('running', 'done', Math.max(endT, startT + 1000));
      } else if (t.state === 'running') moves('planned', 'running', startT);
      else if (t.state === 'waiting' || t.state === 'ready' || t.state === 'blocked')
        moves('planned', t.state, Math.min(startT, this.clock.present - 90_000));
    }

    // Agents: where each stands at the present, and what it does on this project.
    for (const m of members) {
      const a = d.agents[m.agentId] ?? {};
      if (a.note)
        push(
          d.started,
          this.ev('agent.noted', { agentId: m.agentId, note: a.note }, CHIEF, {
            kind: 'agent',
            id: m.agentId,
          }),
        );
      const { state, now, step } = this.agentLine(m.agentId, m.activePhases, a.state, a.now);
      push(
        presentMinus(1),
        this.ev(
          'agent.state',
          {
            agentId: m.agentId,
            state,
            now,
            taskId: d.tasks.find((t) => t.agent === m.agentId && t.state === 'running')?.id ?? null,
            step,
          },
          m.agentId,
          { kind: 'agent', id: m.agentId },
        ),
      );
    }

    // Tool calls, reviews and planner changes, with each agent's token total carried on its calls.
    const callTokens = new Map<string, number>();
    for (const c of d.calls)
      callTokens.set(c.agent, (callTokens.get(c.agent) ?? 0) + parseTokens(c.tok));
    const firstCall = new Map<string, DemoCall>();
    for (const c of [...d.calls].sort((x, y) => this.clock.at(...x.at) - this.clock.at(...y.at)))
      if (!firstCall.has(c.agent)) firstCall.set(c.agent, c);
    for (const c of d.calls) {
      const extra =
        firstCall.get(c.agent) === c
          ? Math.max(0, (d.agents[c.agent]?.tokens ?? 0) - (callTokens.get(c.agent) ?? 0))
          : 0;
      push(c.at, this.callEvent(c, extra));
    }

    for (const m of d.messages) push(m.at, this.message(m));

    for (const x of d.decisions)
      push(
        x.at,
        this.ev(
          'decision.recorded',
          {
            decisionId: randomUUID(),
            question: x.q,
            answer: x.a,
            rationale: '',
            decidedBy: x.by === 'Director' ? 'director' : 'chief_of_staff',
            scopeKey: x.scopeKey ?? x.ref.toLowerCase(),
            escalationId: null,
            ref: x.ref,
          },
          x.by === 'Director' ? 'director' : CHIEF,
          { kind: 'project', id: this.projectId },
          'notable',
        ),
      );

    // Blueprint: v1, the Gate 1 card and its approval, then v2.
    const bp = d.blueprint;
    this.blueprintRows = bp.v1;
    const v1 = await this.blueprintBlob(bp.v1, 1);
    push(
      bp.producedAt,
      this.artifactEvent(
        'blueprint',
        'blueprint',
        'Implementation Blueprint',
        'Blueprint',
        1,
        v1,
        'json',
        'solution-architect',
      ),
    );
    this.blueprintVersion = 1;
    if (bp.gateRaisedAt) {
      const gateId = 'E-01';
      push(
        bp.gateRaisedAt,
        this.ev(
          'escalation.raised',
          this.gateCard(gateId),
          CHIEF,
          { kind: 'escalation', id: gateId },
          'warning',
        ),
      );
      if (bp.approvedAt)
        push(
          bp.approvedAt,
          this.ev(
            'escalation.updated',
            {
              escalationId: gateId,
              status: 'resolved',
              resolution: { optionId: 'approve', notes: null, by: 'director' },
            },
            'director',
            { kind: 'escalation', id: gateId },
            'notable',
          ),
        );
    }
    if (bp.v2) {
      this.blueprintRows = bp.v2;
      const v2 = await this.blueprintBlob(bp.v2, 2);
      push(
        bp.v2At ?? bp.producedAt,
        this.artifactEvent(
          'blueprint',
          'blueprint',
          'Implementation Blueprint',
          'Blueprint',
          2,
          v2,
          'json',
          'solution-architect',
        ),
      );
      this.blueprintVersion = 2;
    }
    push(
      bp.approvedAt ?? bp.producedAt,
      this.ev(
        'conventions.recorded',
        { entries: d.conventions.map(([key, value]) => ({ key, value })) },
        'solution-architect',
        project,
      ),
    );

    for (const a of d.artifacts) {
      const doc = await this.withImageRefs(a.doc);
      if (doc.doc === 'lw.pull_request/1') {
        doc.openedAt = this.at(a.at);
        if (doc.state === 'merged') doc.mergedAt = this.at(a.at);
      }
      const ref = await this.blobs.put(
        this.projectId,
        `artifacts/${a.id}/v1.json`,
        new TextEncoder().encode(JSON.stringify(doc)),
        'application/json',
      );
      push(a.at, this.artifactEvent(a.id, a.kind, a.title, a.short, 1, ref, 'json', a.producer));
    }

    for (const p of d.pages)
      push(
        presentMinus(3),
        this.ev(
          'page.updated',
          {
            pageKey: p.key,
            name: p.name,
            path: p.path,
            template: p.template ?? null,
            layout: p.layout ?? null,
            pilot: p.pilot ?? false,
            migrated: p.migrated ?? false,
            parity: p.parity ?? null,
            visual: p.visual ?? null,
            shots: await this.shotsFor(p.key),
          },
          'visual-qa',
          { kind: 'artifact', id: `page:${p.key}` },
        ),
      );
    push(
      presentMinus(3),
      this.ev(
        'preview.deployed',
        { side: 'source', label: d.preview.source },
        'repo-analyst',
        project,
      ),
    );
    if (d.preview.targetDeployment)
      push(
        presentMinus(3),
        this.ev(
          'preview.deployed',
          { side: 'target', label: d.preview.target, deployment: d.preview.targetDeployment },
          'head-integrator',
          project,
        ),
      );

    for (const [key, [value, total]] of Object.entries(d.metrics))
      push(
        presentMinus(2),
        this.ev('metric.updated', { key, value, total, unit: 'count' }, CHIEF, {
          kind: 'metric',
          id: key,
        }),
      );

    const hours = (this.clock.present - this.clock.at(d.started[0], d.started[1])) / 3_600_000;
    push(
      presentMinus(1),
      this.ev(
        'budget.updated',
        { spent: { usd: d.spent.usd, tokens: d.spent.tokens, hours: Math.round(hours) } },
        CHIEF,
        project,
      ),
    );

    // Ties keep definition order: project.created stays first, a task's moves stay in order.
    history.sort((a, b) => a.t - b.t);
    for (let i = 0; i < history.length; i += 250)
      await this.append(history.slice(i, i + 250).map((h) => h.e));

    for (const [id, minutesAgo] of d.open) await this.raise(id, minutesAgo);
  }

  private agentLine(agentId: string, phases: number[], state?: string, now?: string) {
    const current = this.def.phases.filter((p) => !p.exited).map((p) => p.number);
    let s = state as AgentState | undefined;
    let line = now ?? null;
    if (!s) {
      if (agentId === CHIEF) s = 'active';
      else if (phases.some((p) => current.includes(p))) s = 'active';
      else if (Math.max(...phases) < Math.min(...current)) {
        s = 'done';
        line ??= `Done in phase ${Math.max(...phases)}`;
      } else {
        s = 'inactive';
        const next = phases.find((p) => p > Math.max(...current));
        line ??= next !== undefined ? `Not in this phase. Activates in phase ${next}` : null;
      }
    }
    const m = line ? /\s*\(step (\d+) of (\d+)\)\s*$/.exec(line) : null;
    return {
      state: s,
      now: m ? line!.slice(0, m.index) : line,
      step: m ? { n: Number(m[1]), of: Number(m[2]) } : null,
    };
  }

  private toolServer(label: string): string {
    const labels = { ...this.playbook.manifest.defaults.toolLabels, ...EXTRA_TOOLS };
    return (
      Object.entries(labels).find(([, l]) => l === label)?.[0] ??
      label.toLowerCase().replace(/\s+/g, '-')
    );
  }

  /** One Activity row as the event that produces it. */
  callEvent(c: DemoCall, extraTokens = 0): NewEvent {
    const severity = c.sev === 'bad' ? 'failure' : c.sev === 'warn' ? 'warning' : 'routine';
    if (c.tool === 'Review') {
      const verdict = /^reject/.test(c.op) ? 'reject' : 'accept';
      return this.ev(
        'review.recorded',
        {
          reviewerId: c.agent,
          agentId: c.agent,
          taskId: null,
          verdict,
          subject: c.op.replace(/^(accept|reject)\s+/, ''),
          note: c.note ?? null,
          tokens: parseTokens(c.tok) + extraTokens,
        },
        c.agent,
        { kind: 'agent', id: c.agent },
        verdict === 'reject' ? 'warning' : 'routine',
      );
    }
    if (c.tool === 'Planner')
      return this.ev(
        'plan.changed',
        { summary: c.op, tokens: parseTokens(c.tok) + extraTokens },
        c.agent,
        { kind: 'project', id: this.projectId },
        'notable',
      );
    const numeric = /^\d+$/.test(c.code);
    return this.ev(
      'step.recorded',
      {
        stepId: randomUUID(),
        agentId: c.agent,
        taskId: this.def.tasks.find((t) => t.agent === c.agent && t.state === 'running')?.id ?? '',
        toolServer: this.toolServer(c.tool),
        operation: c.op,
        resultCode: numeric ? Number(c.code) : severity === 'failure' ? 500 : 0,
        durationMs: parseMs(c.ms),
        tokens: parseTokens(c.tok) + extraTokens,
        summary: c.note ?? c.op,
        outcome: numeric ? null : c.code,
        note: c.note ?? null,
      },
      c.agent,
      { kind: 'step', id: randomUUID() },
      severity,
    );
  }

  private message(m: DemoMessage): NewEvent {
    const links = (m.links ?? []).map(([label, j]) => ({ label, target: jumpTarget(j) }));
    if (m.brief) {
      const i = m.brief.indexOf(': ');
      const rows: { label: string; value: string }[] = [];
      const bullets: string[] = [];
      for (const l of m.lines ?? []) {
        const r = /^([A-Z][a-z]+): (.*)$/.exec(l);
        if (r) rows.push({ label: r[1]!, value: r[2]! });
        else bullets.push(l);
      }
      return this.ev(
        'cos.message',
        {
          messageId: randomUUID(),
          kind: 'brief',
          label: i > 0 ? m.brief.slice(0, i) : 'Brief',
          title: i > 0 ? m.brief.slice(i + 2) : m.brief,
          body: '',
          rows,
          bullets,
          note: m.note ?? null,
          links,
        },
        CHIEF,
        { kind: 'message', id: randomUUID() },
        'notable',
      );
    }
    return this.ev(
      'cos.message',
      { messageId: randomUUID(), kind: 'text', body: m.text ?? '', links },
      CHIEF,
      { kind: 'message', id: randomUUID() },
    );
  }

  private artifactEvent(
    artifactId: string,
    kind: string,
    title: string,
    shortTitle: string,
    version: number,
    ref: string,
    format: 'json' | 'markdown',
    producer: string,
  ): NewEvent {
    return this.ev(
      'artifact.versioned',
      { artifactId, kind, title, shortTitle, version, ref, format },
      producer,
      { kind: 'artifact', id: artifactId },
      'notable',
    );
  }

  /** The Blueprint as the plan compiler reads it, mapping detail in attrs. */
  blueprintDoc(rows: BlueprintRowDef[], version: number) {
    return {
      version,
      collections: {
        components: rows.map((r) => ({
          key: rowKey(r),
          name: r.target,
          status: r.status === 'dropped' ? 'drop' : r.status === 'merged' ? 'merge' : 'keep',
          pilot: r.pilot ?? false,
          attrs: {
            source: r.src,
            fields: r.fields,
            params: r.params,
            placeholders: r.ph,
            variants: r.variants,
            ...(r.was ? { was: r.was } : {}),
          },
        })),
      },
    };
  }

  private blueprintBlob(rows: BlueprintRowDef[], version: number) {
    return this.blobs.put(
      this.projectId,
      `artifacts/blueprint/v${version}.json`,
      new TextEncoder().encode(JSON.stringify(this.blueprintDoc(rows, version))),
      'application/json',
    );
  }

  /** Writes the next Blueprint version with `change` applied to the current rows. */
  async reviseBlueprint(
    change: (rows: BlueprintRowDef[]) => BlueprintRowDef[],
    producer = 'solution-architect',
  ) {
    this.blueprintRows = change(this.blueprintRows.map((r) => ({ ...r })));
    const version = ++this.blueprintVersion;
    const ref = await this.blueprintBlob(this.blueprintRows, version);
    await this.append([
      this.artifactEvent(
        'blueprint',
        'blueprint',
        'Implementation Blueprint',
        'Blueprint',
        version,
        ref,
        'json',
        producer,
      ),
    ]);
    return version;
  }

  private gateCard(id: string): EscalationCard {
    return {
      escalationId: id,
      category: null,
      triage: null,
      type: 'gate',
      typeLabel: 'Gate 1',
      title: 'Approve Blueprint v1',
      context: 'Blueprint v1 maps the source to renderings, templates and data items.',
      impact: 'Foundation starts when you approve. Nothing is created on the tenant before then.',
      options: [
        { id: 'approve', label: 'Approve', recommended: true, key: null },
        { id: 'send_back', label: 'Send back with notes', recommended: false, key: null },
      ],
      defaultOptionId: null,
      deadline: null,
      evidence: [{ kind: 'artifact', ref: 'blueprint', label: 'Blueprint v1' }],
      sourceTaskId: null,
      waitNote: 'Waits for you. Foundation starts when you approve.',
      reversible: false,
      gate: { phase: 2, artifactId: 'blueprint', artifactVersion: 1, requiresConfirmation: false },
    };
  }

  /** Swaps `image:hero` references in documents for stored blob references. */
  private async withImageRefs<T>(doc: T): Promise<T> {
    const json = JSON.stringify(doc);
    const names = [...new Set([...json.matchAll(/"image:([a-z0-9-]+)"/g)].map((m) => m[1]!))];
    let out = json;
    for (const n of names)
      out = out.replaceAll(`"image:${n}"`, JSON.stringify(await this.image(n)));
    return JSON.parse(out) as T;
  }

  private readonly images = new Map<string, string>();
  async image(name: string): Promise<string> {
    const cached = this.images.get(name);
    if (cached) return cached;
    const dir = join(FIXTURES, this.def.fixtures);
    const file = [`${name}.jpg`, `${name}.png`, `${name}.svg`];
    for (const f of file) {
      try {
        const bytes = await readFile(join(dir, f));
        const type = { '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml' }[
          extname(f)
        ]!;
        const ref = await this.blobs.put(
          this.projectId,
          `assets/${f}`,
          new Uint8Array(bytes),
          type,
        );
        this.images.set(name, ref);
        return ref;
      } catch {
        /* next extension */
      }
    }
    throw new Error(`No fixture image ${name} in ${dir}`);
  }

  /** Site preview screenshots, when the fixtures have them (`shots/<page>-<side>-<bp>.jpg`). */
  private async shotsFor(pageKey: string) {
    const out: { source: Record<string, string>; target: Record<string, string> } = {
      source: {},
      target: {},
    };
    const dir = join(FIXTURES, this.def.fixtures, 'shots');
    for (const side of ['source', 'target'] as const)
      for (const bp of ['desktop', 'tablet', 'phone'])
        try {
          const name = `${pageKey.replace(/[^a-z0-9-]/gi, '') || 'home'}-${side}-${bp}.jpg`;
          const bytes = await readFile(join(dir, name));
          out[side][bp] = await this.blobs.put(
            this.projectId,
            `shots/${name}`,
            new Uint8Array(bytes),
            'image/jpeg',
          );
        } catch {
          /* not captured */
        }
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // Live
  // -------------------------------------------------------------------------------------------

  start(): void {
    const tick = () => {
      if (this.stopped) return;
      this.ticks++;
      void this.onTick().catch(() => {});
    };
    const interval = setInterval(tick, Math.max(50, 1000 / this.speed));
    this.timers.add(interval as unknown as NodeJS.Timeout);
    if (this.opts.auto !== false)
      for (const [seconds, key] of this.def.auto)
        this.later((seconds * 1000) / this.speed, () => this.runScenario(key).catch(() => {}));
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    for (const x of this.live.values()) {
      for (const t of [x.deadlineTimer, x.deferTimer, x.effect?.timer]) if (t) clearTimeout(t);
    }
    for (const t of this.directives.values()) clearTimeout(t);
  }

  private async onTick() {
    if (this.paused || this.state.status !== 'running') return;
    const events: NewEvent[] = [];
    if (this.ticks % 6 === 0) {
      const ops = this.def.live.ops;
      const [agent, tool, op, code, ms, tok] = ops[(this.ticks / 6) % ops.length]!;
      events.push(this.callEvent({ at: [0, 0], agent, tool, op, code, ms, tok }));
      for (const [id, lines] of Object.entries(this.def.live.nowLines)) {
        const a = this.state.agents[id];
        if (!a || a.state !== 'active') continue;
        const line = this.agentLine(
          id,
          a.activePhases,
          'active',
          lines[(this.ticks / 6) % lines.length],
        );
        events.push(
          this.ev('agent.state', { agentId: id, ...line, taskId: a.taskId }, id, {
            kind: 'agent',
            id,
          }),
        );
      }
    }
    if (this.ticks % 60 === 0) {
      const s = this.state.spent;
      events.push(
        this.ev(
          'budget.updated',
          { spent: { usd: s.usd + 1, tokens: s.tokens + 4000, hours: s.hours } },
          CHIEF,
          { kind: 'project', id: this.projectId },
        ),
      );
    }
    if (this.ticks % 600 === 0) {
      const m = this.state.metrics.components_registered;
      const registrar = this.state.agents['rendering-registrar'];
      if (
        m.value !== null &&
        m.total !== null &&
        m.value < m.total &&
        registrar?.state === 'active'
      ) {
        events.push(
          this.ev(
            'metric.updated',
            { key: 'components_registered', value: m.value + 1, total: m.total, unit: 'count' },
            'rendering-registrar',
            { kind: 'metric', id: 'components_registered' },
          ),
        );
        const qa = this.state.metrics.qa_pass;
        if (qa.value !== null)
          events.push(
            this.ev(
              'metric.updated',
              { key: 'qa_pass', value: qa.value, total: m.value + 1, unit: 'count' },
              'structural-validator',
              { kind: 'metric', id: 'qa_pass' },
            ),
          );
      }
    }
    await this.append(events);
  }

  // -------------------------------------------------------------------------------------------
  // Helpers for scenarios
  // -------------------------------------------------------------------------------------------

  async say(text: string, extra: Record<string, unknown> = {}) {
    await this.append([
      this.ev(
        'cos.message',
        { messageId: randomUUID(), kind: 'text', body: text, ...extra },
        CHIEF,
        { kind: 'message', id: randomUUID() },
      ),
      this.ev('cos.presence', { presence: 'listening' }, CHIEF, {
        kind: 'project',
        id: this.projectId,
      }),
    ]);
  }

  /** Cypher "thinks" for a moment, then acts. */
  think(ms: number, fn: () => Promise<unknown>) {
    void this.append([
      this.ev('cos.presence', { presence: 'thinking' }, CHIEF, {
        kind: 'project',
        id: this.projectId,
      }),
    ]);
    this.later(ms / Math.max(1, this.speed / 4), fn);
  }

  async log(c: Omit<DemoCall, 'at'>) {
    await this.append([this.callEvent({ ...c, at: [0, 0] })]);
  }

  async setAgent(agentId: string, patch: { state?: AgentState; now?: string | null }) {
    const a = this.state.agents[agentId];
    if (!a) return;
    const line = this.agentLine(
      agentId,
      a.activePhases,
      patch.state ?? a.state,
      patch.now ?? a.now ?? undefined,
    );
    await this.append([
      this.ev('agent.state', { agentId, ...line, taskId: a.taskId }, agentId, {
        kind: 'agent',
        id: agentId,
      }),
    ]);
  }

  async moveTask(taskId: string, to: TaskState, reason: string | null = null) {
    const t = this.state.tasks[taskId];
    if (!t) return;
    let from = t.state;
    const events: NewEvent[] = [];
    for (const n of route(from, to)) {
      events.push(
        this.ev(
          'task.state',
          { taskId, from, to: n, attempt: Math.max(1, t.attempt), reason },
          t.agentId,
          { kind: 'task', id: taskId },
        ),
      );
      from = n;
    }
    await this.append(events);
  }

  nextDecisionRef() {
    return `D-${String(this.state.decisions.length + 1).padStart(2, '0')}`;
  }

  async decide(
    q: string,
    a: string,
    by: 'director' | 'default' | 'chief_of_staff',
    scopeKey: string,
  ) {
    const ref = this.nextDecisionRef();
    await this.append([
      this.ev(
        'decision.recorded',
        {
          decisionId: randomUUID(),
          question: q,
          answer: a,
          rationale: '',
          decidedBy: by,
          scopeKey,
          escalationId: null,
          ref,
        },
        by === 'director' ? 'director' : CHIEF,
        { kind: 'project', id: this.projectId },
        'notable',
      ),
    ]);
    return ref;
  }

  async enterPhase(n: number) {
    await this.append([
      this.ev('phase.entered', { phase: n }, CHIEF, { kind: 'phase', id: String(n) }, 'notable'),
    ]);
  }

  async exitPhase(n: number) {
    await this.append([
      this.ev('phase.exited', { phase: n }, CHIEF, { kind: 'phase', id: String(n) }, 'notable'),
    ]);
  }

  /** Raises one of the scenario's escalations (no-op if it is already on screen). */
  async raise(id: string, minutesAgo = 0): Promise<boolean> {
    if (this.live.has(id) || this.state.escalations[id]) return false;
    const make = this.def.escalations[id];
    if (!make) throw new CommandError(404, 'unknown_scenario', `No escalation ${id} in this demo.`);
    const def = make();
    const options =
      def.type === 'gate'
        ? [
            { id: 'approve', label: 'Approve', recommended: true, key: null },
            { id: 'send_back', label: 'Send back with notes', recommended: false, key: null },
          ]
        : (def.options ?? []).map((o, i) => {
            const key = String.fromCharCode(65 + i);
            return { id: key, label: o.label, recommended: o.rec ?? false, key };
          });
    const deadlineMs =
      def.deadlineMinutes && def.defaultIdx !== undefined
        ? (def.deadlineMinutes * 60_000) / this.speed
        : null;
    const card: EscalationCard = {
      escalationId: id,
      category: null,
      triage: null,
      type: def.type,
      typeLabel: def.typeLabel ?? null,
      title: def.title,
      context: def.context,
      impact: def.impact,
      options,
      defaultOptionId: def.defaultIdx !== undefined ? options[def.defaultIdx]!.id : null,
      deadline: deadlineMs
        ? new Date(this.now() + deadlineMs - minutesAgo * 60_000).toISOString()
        : null,
      evidence: (def.evidence ?? []).map((e) => ({ label: e.label, ...jumpTarget(e.go) })),
      sourceTaskId: null,
      waitNote: def.waitNote ?? null,
      reversible: def.reversible ?? def.type !== 'gate',
      gate: def.gate
        ? { ...def.gate, artifactVersion: def.gate.version, requiresConfirmation: false }
        : null,
    };
    const x: LiveEscalation = { def, card, deadlineTimer: null, deferTimer: null, effect: null };
    this.live.set(id, x);
    await this.append([
      {
        ...this.ev(
          'escalation.raised',
          card,
          CHIEF,
          { kind: 'escalation', id },
          def.type === 'risk' ? 'notable' : 'warning',
        ),
        ...(minutesAgo ? { at: this.ago(minutesAgo) } : {}),
      },
    ]);
    if (card.deadline) this.armDeadline(x, Date.parse(card.deadline) - this.now());
    return true;
  }

  private armDeadline(x: LiveEscalation, ms: number) {
    if (x.deadlineTimer) clearTimeout(x.deadlineTimer);
    x.deadlineTimer = setTimeout(() => void this.expire(x).catch(() => {}), Math.max(0, ms));
  }

  private async expire(x: LiveEscalation) {
    const e = this.state.escalations[x.card.escalationId];
    if (!e || e.status !== 'open' || this.stopped) return;
    const optionId = x.card.defaultOptionId!;
    await this.settle(x, optionId, 'default', 'expired');
  }

  /** Records a choice; reversible ones take effect after the 10-second undo window. */
  private async settle(
    x: LiveEscalation,
    optionId: string,
    by: 'director' | 'default',
    status: 'resolved' | 'expired',
    notes: string | null = null,
  ) {
    if (x.deadlineTimer) clearTimeout(x.deadlineTimer);
    const reversible = x.card.reversible || status === 'expired';
    const window = this.opts.undoWindowMs ?? 10_000;
    const undoUntil = reversible ? new Date(this.now() + window).toISOString() : null;
    await this.append([
      this.ev(
        'escalation.updated',
        {
          escalationId: x.card.escalationId,
          status,
          resolution: { optionId, notes, by },
          undoUntil,
        },
        by === 'director' ? 'director' : CHIEF,
        { kind: 'escalation', id: x.card.escalationId },
        'notable',
      ),
    ]);
    const index = x.card.options.findIndex((o) => o.id === optionId);
    const run = async () => {
      x.effect = null;
      await x.def.onResolve?.(this, index, by);
    };
    if (reversible) {
      x.effect = { timer: setTimeout(() => void run().catch(() => {}), window), run };
    } else await run();
  }

  // -------------------------------------------------------------------------------------------
  // Director commands (ProjectCommands)
  // -------------------------------------------------------------------------------------------

  private liveOrFail(escalationId: string): LiveEscalation {
    const x = this.live.get(escalationId);
    if (!x) throw new CommandError(404, 'unknown_escalation', `No escalation ${escalationId}.`);
    return x;
  }

  async resolve(escalationId: string, optionId: string, notes: string | null = null) {
    const x = this.liveOrFail(escalationId);
    const e = this.state.escalations[escalationId]!;
    if (e.status !== 'open' && e.status !== 'deferred')
      throw new CommandError(409, 'already_resolved', 'That escalation is already settled.');
    if (x.card.type === 'gate') {
      if (optionId === 'send_back') {
        if (!notes)
          throw new CommandError(422, 'notes_required', 'Say what should change before approval.');
        await this.settle(x, 'send_back', 'director', 'resolved', notes);
        if (x.def.onSendBack) await x.def.onSendBack(this, notes);
        else await this.defaultSendBack(notes);
        return;
      }
      if (optionId !== 'approve')
        throw new CommandError(422, 'invalid_option', 'Approve or send back.');
      await this.settle(x, 'approve', 'director', 'resolved');
      if (x.def.onApprove) await x.def.onApprove(this);
      else await this.defaultApprove(x);
      return;
    }
    if (!x.card.options.some((o) => o.id === optionId))
      throw new CommandError(422, 'invalid_option', `No option ${optionId} on this card.`);
    await this.settle(x, optionId, 'director', 'resolved');
  }

  private async defaultApprove(x: LiveEscalation) {
    await this.decide(x.card.title, 'Approved', 'director', `gate:${x.card.escalationId}`);
    this.think(900, () =>
      this.say(`${x.card.title} approved and logged. Work carries on without a checkpoint hold.`),
    );
  }

  private async defaultSendBack(notes: string) {
    this.think(1200, () =>
      this.say(
        `Noted: “${notes}”. The work holds at its next checkpoint while the Lead re-plans against your notes.`,
      ),
    );
  }

  async defer(escalationId: string, until: Date) {
    const x = this.liveOrFail(escalationId);
    const e = this.state.escalations[escalationId]!;
    if (e.status !== 'open')
      throw new CommandError(409, 'not_open', 'Only an open escalation can be deferred.');
    const ms = Math.max(0, until.getTime() - this.now());
    if (x.deadlineTimer && x.card.deadline) {
      x.card.deadline = new Date(Date.parse(x.card.deadline) + ms).toISOString();
      this.armDeadline(x, Date.parse(x.card.deadline) - this.now());
    }
    await this.append([
      this.ev(
        'escalation.updated',
        { escalationId, status: 'deferred', deferredUntil: until.toISOString() },
        'director',
        { kind: 'escalation', id: escalationId },
      ),
    ]);
    x.deferTimer = setTimeout(() => void this.resume(escalationId).catch(() => {}), ms);
  }

  async resume(escalationId: string) {
    const x = this.liveOrFail(escalationId);
    if (this.state.escalations[escalationId]?.status !== 'deferred') return;
    if (x.deferTimer) clearTimeout(x.deferTimer);
    await this.append([
      this.ev('escalation.updated', { escalationId, status: 'open' }, 'director', {
        kind: 'escalation',
        id: escalationId,
      }),
    ]);
  }

  async undo(escalationId: string) {
    const x = this.liveOrFail(escalationId);
    const e = this.state.escalations[escalationId]!;
    if (!e.undoUntil || Date.parse(e.undoUntil) < this.now() || !x.effect)
      throw new CommandError(
        409,
        'undo_expired',
        'The undo window has closed. Ask Cypher to reverse it instead.',
      );
    clearTimeout(x.effect.timer);
    x.effect = null;
    const deadline = x.card.defaultOptionId
      ? new Date(this.now() + (10 * 60_000) / this.speed).toISOString()
      : null;
    await this.append([
      this.ev('escalation.updated', { escalationId, status: 'open' }, 'director', {
        kind: 'escalation',
        id: escalationId,
      }),
    ]);
    if (deadline) {
      x.card.deadline = deadline;
      this.armDeadline(x, Date.parse(deadline) - this.now());
    }
    await x.def.onUndo?.(this);
    await this.say(
      'Undone. The question is open again. Proceeding in 10 minutes unless you choose.',
    );
  }

  statusCard(): StatusCard {
    const s = this.state;
    const sum = projectSummary(s);
    const phase = phaseViews(s).find((p) => p.status === 'current');
    const stat = s.statCards[0];
    const metric = stat ? s.metrics[stat.metric] : null;
    const qa = s.statCards.find((c) => c.metric === 'qa_pass');
    const qm = qa ? s.metrics.qa_pass : null;
    const gate = phaseViews(s).find((p) => p.gate === 'director' && p.status !== 'done');
    const m = Math.round(
      (this.now() - this.clock.at(this.def.started[0], this.def.started[1])) / 60_000,
    );
    const days = Math.floor(m / 1440);
    const hrs = Math.floor((m % 1440) / 60);
    return {
      phase: phase ? `Phase ${phase.number}, ${phase.shortName}` : 'Not started',
      percent: phase?.percent ?? 0,
      blockers: Object.values(s.escalations)
        .filter((x) => x.status === 'open' && (x.type === 'blocker' || x.type === 'access'))
        .map((x) => x.title),
      waiting: sum.waitingCount,
      headline: {
        label: stat?.label ?? 'Progress',
        value:
          metric && metric.value !== null
            ? `${metric.value} of ${metric.total}`
            : 'Not yet measured',
        sub: qm && qm.value !== null ? `${qa!.label} ${qm.value} of ${qm.total}` : null,
      },
      nextGate: gate ? `${gate.shortName}, phase ${gate.number}` : 'None',
      cost: `$${Math.round(s.spent.usd)} of $${s.budgets.usd.toLocaleString('en-US')}`,
      elapsed: days ? `Day ${days + 1}, ${hrs}h in` : `${hrs}h ${String(m % 60).padStart(2, '0')}m`,
    };
  }

  async postMessage(body: string, about?: string) {
    const t = body.trim();
    await this.append([
      this.ev(
        'director.message',
        { messageId: randomUUID(), body: t, about: about ?? null },
        'director',
        { kind: 'message', id: randomUUID() },
      ),
    ]);
    const low = t.toLowerCase().replace(/^\//, '');
    const reply = (kind: string, extra: Record<string, unknown>) =>
      this.append([
        this.ev('cos.message', { messageId: randomUUID(), kind, body: '', ...extra }, CHIEF, {
          kind: 'message',
          id: randomUUID(),
        }),
        this.ev('cos.presence', { presence: 'listening' }, CHIEF, {
          kind: 'project',
          id: this.projectId,
        }),
      ]);

    if (about) {
      const x = this.state.escalations[about];
      if (x) {
        const rec = x.options.find((o) => o.recommended);
        return this.think(1000, () =>
          this.say(
            `On “${x.title}”: ${x.context}${rec && x.type !== 'gate' ? ` I recommend ${rec.key ?? ''}: ${rec.label.charAt(0).toLowerCase()}${rec.label.slice(1)}.` : ''}${x.deadline ? ` Without a choice it proceeds at ${clockTime(Date.parse(x.deadline), this.state.timezone)}.` : ''}`,
            { links: x.evidence.slice(0, 2).map(({ label, ...target }) => ({ label, target })) },
          ),
        );
      }
    }
    if (/needs me|need me|waiting on me|blocking|blocked/.test(low))
      return this.think(800, () =>
        reply('needs', {
          needs: Object.values(this.state.escalations)
            .filter((x) => x.status === 'open')
            .map((x) => ({ escalationId: x.escalationId, type: x.type, title: x.title })),
        }),
      );
    if (/what is next|what's next|up next|next up/.test(low))
      return this.think(800, () => reply('next', { upNext: upNext(this.state, this.now()) }));
    if (/^status|^how.*(going|standing)|where are we/.test(low))
      return this.think(900, () => reply('status', { status: this.statusCard() }));
    if (/pause project|pause everything|stop everything/.test(low))
      return this.think(600, () =>
        this.control({ verb: 'pause', scope: { kind: 'project', id: this.projectId } }),
      );
    if (/resume project|resume everything/.test(low))
      return this.think(600, () =>
        this.control({ verb: 'resume', scope: { kind: 'project', id: this.projectId } }),
      );
    if (/^(pause|resume)\b/.test(low)) {
      const verb = low.startsWith('pause') ? 'pause' : 'resume';
      const name =
        low
          .replace(/^(pause|resume)\s*/, '')
          .trim()
          .split(' ')[0] ?? '';
      const a = name
        ? Object.values(this.state.agents).find(
            (x) =>
              x.name.toLowerCase().includes(name) ||
              (x.persona ?? '').toLowerCase().split(' ')[0] === name,
          )
        : undefined;
      return this.think(800, () =>
        a
          ? this.control({ verb, scope: { kind: 'agent', id: a.agentId } })
          : this.say(
              verb === 'pause'
                ? 'Which agent? Name one, or say “pause project” for everything.'
                : 'Nothing by that name is paused right now.',
            ),
      );
    }
    if (/^approve/.test(low)) {
      const g = Object.values(this.state.escalations).find(
        (x) => x.status === 'open' && x.type === 'gate',
      );
      return this.think(700, () =>
        g
          ? this.resolve(g.escalationId, 'approve')
          : this.say('Nothing is waiting for approval right now.'),
      );
    }
    const scope = /^(skip|drop|remove)\s+/i.exec(t);
    const directiveId = `dir-${randomUUID().slice(0, 8)}`;
    const directiveWindow = this.opts.directiveWindowMs ?? 30_000;
    const proceedsAt = new Date(this.now() + directiveWindow).toISOString();
    const text = scope
      ? `Understood: remove “${t.slice(scope[0].length)}” from scope. Impact: 1 rendering and its data items leave the Blueprint. The current batch is unaffected.`
      : `Understood: “${t}”. Impact: no change to the current phase. I will fold it into the plan and log it as a directive.`;
    this.think(1100, async () => {
      await reply('directive_ack', { body: text, directiveId, proceedsAt });
      const timer = setTimeout(() => {
        this.directives.delete(directiveId);
        void (async () => {
          let summary = 'Logged as a directive and applied to the plan.';
          if (scope) {
            const ref = await this.decide('Scope change', t, 'director', 'blueprint:scope');
            const v = await this.reviseBlueprint((rows) => rows);
            summary = `Done. Logged as ${ref}; Blueprint v${v} recorded the change.`;
          }
          await this.append([
            this.ev('directive.settled', { directiveId, outcome: 'applied', summary }, CHIEF, {
              kind: 'message',
              id: directiveId,
            }),
          ]);
        })().catch(() => {});
      }, directiveWindow);
      this.directives.set(directiveId, timer);
    });
  }

  async stopDirective(directiveId: string) {
    const timer = this.directives.get(directiveId);
    if (!timer)
      throw new CommandError(409, 'window_closed', 'That directive has already been applied.');
    clearTimeout(timer);
    this.directives.delete(directiveId);
    await this.append([
      this.ev(
        'directive.settled',
        { directiveId, outcome: 'stopped', summary: 'Stopped. Nothing changed.' },
        'director',
        { kind: 'message', id: directiveId },
      ),
    ]);
  }

  async control(cmd: Control) {
    const { verb, scope } = cmd;
    if (scope.kind === 'agent') {
      const a = this.state.agents[scope.id];
      if (!a) throw new CommandError(404, 'unknown_agent', `No agent ${scope.id}.`);
      const who = a.persona ?? a.name;
      if (verb === 'pause') {
        if (a.state === 'paused')
          throw new CommandError(409, 'already_paused', `${who} is already paused.`);
        const queued = Object.values(this.state.tasks).filter(
          (t) => t.agentId === a.agentId && t.state !== 'done',
        ).length;
        this.pausedLines.set(a.agentId, { state: a.state, now: a.now });
        await this.append([
          this.ev(
            'control.hold',
            { scope, held: true, label: `${who}, ${a.name}` },
            'director',
            { kind: 'agent', id: a.agentId },
            'notable',
          ),
          this.ev(
            'agent.state',
            {
              agentId: a.agentId,
              state: 'paused',
              now: 'Paused by the Director',
              taskId: a.taskId,
            },
            a.agentId,
            { kind: 'agent', id: a.agentId },
          ),
        ]);
        return this.say(
          `Paused ${who}, ${a.name}. ${queued} queued task${queued === 1 ? ' holds' : 's hold'}; nothing else is affected. Resume from the inspector or say “resume ${who.split(' ')[0]}”.`,
        );
      }
      if (verb === 'resume') {
        if (a.state !== 'paused')
          throw new CommandError(409, 'not_paused', `${who} is not paused.`);
        const prior = this.pausedLines.get(a.agentId) ?? {
          state: 'active' as AgentState,
          now: null,
        };
        this.pausedLines.delete(a.agentId);
        await this.append([
          this.ev(
            'control.hold',
            { scope, held: false, label: `${who}, ${a.name}` },
            'director',
            { kind: 'agent', id: a.agentId },
            'notable',
          ),
          this.ev(
            'agent.state',
            { agentId: a.agentId, state: prior.state, now: prior.now, taskId: a.taskId },
            a.agentId,
            { kind: 'agent', id: a.agentId },
          ),
        ]);
        return this.say(`Resumed ${who}, ${a.name}.`);
      }
    }
    if (scope.kind === 'project') {
      const running = Object.values(this.state.tasks).filter((t) => t.state === 'running').length;
      if (verb === 'pause') {
        if (this.paused)
          throw new CommandError(409, 'already_paused', 'The project is already paused.');
        this.paused = true;
        await this.append([
          this.ev(
            'control.hold',
            { scope, held: true, label: 'project' },
            'director',
            { kind: 'project', id: this.projectId },
            'notable',
          ),
          this.ev(
            'project.status',
            { status: 'paused' },
            'director',
            { kind: 'project', id: this.projectId },
            'notable',
          ),
        ]);
        return this.say(
          `Project paused. ${running} running task${running === 1 ? '' : 's'} hold at their next checkpoint. Nothing is rolled back. Say “resume project” when ready.`,
        );
      }
      if (verb === 'resume') {
        if (!this.paused) throw new CommandError(409, 'not_paused', 'The project is not paused.');
        this.paused = false;
        await this.append([
          this.ev(
            'control.hold',
            { scope, held: false, label: 'project' },
            'director',
            { kind: 'project', id: this.projectId },
            'notable',
          ),
          this.ev(
            'project.status',
            { status: 'running' },
            'director',
            { kind: 'project', id: this.projectId },
            'notable',
          ),
        ]);
        return this.say(`Project resumed. All ${running} tasks continue from their checkpoints.`);
      }
    }
    if (scope.kind === 'task' && verb === 'cancel') {
      await this.moveTask(scope.id, 'cancelled', 'Cancelled by the Director');
      return this.say(
        `Cancelled “${this.state.tasks[scope.id]?.title ?? scope.id}”. Its dependents are re-planned.`,
      );
    }
    throw new CommandError(422, 'not_supported', `The demo does not ${verb} a ${scope.kind}.`);
  }

  private readonly pausedLines = new Map<string, { state: AgentState; now: string | null }>();

  async rerunTask(taskId: string, instructions: string) {
    const t = this.state.tasks[taskId];
    if (!t) throw new CommandError(404, 'unknown_task', `No task ${taskId}.`);
    if (t.state === 'planned')
      throw new CommandError(
        409,
        'not_started',
        'That task has not run yet. Add the instructions as a directive instead.',
      );
    const a = this.state.agents[t.agentId];
    if (t.state === 'done') {
      await this.moveTask(taskId, 'rolled_back', 'Re-run requested');
      await this.moveTask(taskId, 'ready', 'Re-run with instructions');
      this.later(3000 / this.speed, async () => {
        await this.moveTask(taskId, 'running');
        await this.setAgent(t.agentId, {
          state: 'active',
          now: `Re-running ${t.title} with your instructions`,
        });
      });
    }
    await this.say(
      `Re-running “${t.title}” with your instructions: “${instructions}”. ${a?.persona ?? a?.name ?? 'The agent'} picks it up next; its dependents wait for the new result.`,
    );
  }

  async rollbackTask(taskId: string) {
    const t = this.state.tasks[taskId];
    if (!t) throw new CommandError(404, 'unknown_task', `No task ${taskId}.`);
    if (t.state !== 'done')
      throw new CommandError(409, 'not_done', 'Only a completed task can be rolled back.');
    await this.log({
      agent: t.agentId,
      tool: 'Authoring API',
      op: `rollback: delete items created by ${t.title}`,
      code: '200',
      ms: '1.4 s',
      tok: '–',
    });
    await this.log({
      agent: t.agentId,
      tool: 'GitHub',
      op: `revert serialization commit for ${t.title}`,
      code: '201',
      ms: '0.9 s',
      tok: '–',
    });
    await this.moveTask(taskId, 'rolled_back', 'Rolled back by the Director');
    await this.say(
      `Rolled back “${t.title}”: its items are deleted and its serialization commit is reverted. It is back in the plan.`,
    );
  }

  async rollbackPhase(phase: number) {
    const done = Object.values(this.state.tasks).filter(
      (t) => t.phase === phase && t.state === 'done',
    );
    for (const t of [...done].reverse())
      await this.moveTask(t.taskId, 'rolled_back', `Phase ${phase} rolled back`);
    await this.log({
      agent: CHIEF,
      tool: 'Planner',
      op: `roll back phase ${phase}: ${done.length} tasks undone`,
      code: 'ok',
    });
    await this.say(
      `Phase ${phase} rolled back: ${done.length} completed task${done.length === 1 ? ' is' : 's are'} undone, newest first. The phase restarts from its first task.`,
    );
  }

  async archive() {
    await this.append([
      this.ev(
        'project.status',
        { status: 'archived' },
        'director',
        { kind: 'project', id: this.projectId },
        'notable',
      ),
    ]);
    this.stop();
  }

  async changeSetting(key: SettingKey, value: unknown) {
    await this.append([
      this.ev(
        'settings.changed',
        { key, value },
        'director',
        { kind: 'project', id: this.projectId },
        'notable',
      ),
    ]);
    const labels: Partial<Record<SettingKey, string>> = {
      'gates.pilotReview': 'Review after the pilot slice',
      'gates.publishReview': 'Review before publishing to production',
    };
    if (labels[key]) await this.say(`${labels[key]} is ${value ? 'on' : 'off'}.`);
  }

  async verifyCredential(credentialId: string) {
    const c = this.state.credentials[credentialId];
    if (!c) throw new CommandError(404, 'unknown_credential', `No credential ${credentialId}.`);
    this.later(1200 / Math.max(1, this.speed / 4), () =>
      this.append([
        this.ev(
          'credential.verified',
          c.provided
            ? { credentialId, ok: true, detail: c.scope }
            : {
                credentialId,
                ok: false,
                detail: 'Not provided. Ask the client for it, then add it to the vault.',
              },
          'system',
          { kind: 'tool', id: credentialId },
          c.provided ? 'routine' : 'warning',
        ),
      ]),
    );
  }

  scenarios() {
    return scenarioList(this.def);
  }

  async runScenario(key: string) {
    if (key === 'digest') return this.digest();
    const s = this.def.scenarios.find((x) => x.key === key);
    if (!s) throw new CommandError(404, 'unknown_scenario', `No scenario ${key} in this demo.`);
    await s.run(this);
  }

  async digest() {
    const s = this.state;
    const phase = phaseViews(s).find((p) => p.status === 'current');
    const esc = Object.values(s.escalations);
    await this.append([
      this.message({
        at: [0, 0],
        brief: `Daily digest: ${new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: s.timezone }).format(this.now())}`,
        lines: [
          `Escalations: ${esc.length} raised, ${esc.filter((x) => x.status === 'resolved' || x.status === 'expired').length} resolved.`,
          `Current phase: ${phase?.shortName ?? '–'}, ${phase?.percent ?? 0}% done.`,
          `Cost consumed: $${Math.round(s.spent.usd)} of $${s.budgets.usd.toLocaleString('en-US')}.`,
          `Waiting on you: ${esc.filter((x) => x.status === 'open').length}.`,
        ],
      }),
    ]);
  }
}

/** The scenarios a demo project can raise on demand, as the Demo menu lists them. */
export function scenarioList(def: DemoScenario): { key: string; label: string }[] {
  return [
    ...def.scenarios.map(({ key, label }) => ({ key, label })),
    { key: 'digest', label: 'Post the daily digest' },
  ];
}
