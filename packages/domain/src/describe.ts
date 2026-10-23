import type { ActivityItem, EscalationView, LwEvent } from '@lw/contracts';

export interface Lookups {
  agentName: (agentId: string) => string;
  taskTitle: (taskId: string) => string;
  toolLabel?: (server: string) => string;
  escalation?: (escalationId: string) => EscalationView | null;
  /** The display id of the decision just recorded ("D-07"). */
  decisionRef?: () => string | null;
}

const IDENTITY: Lookups = { agentName: (id) => id, taskTitle: (id) => id };

const TASK_VERB: Partial<Record<string, string>> = {
  running: 'started',
  validating: 'in validation',
  done: 'done',
  rejected: 'rejected by Lead review',
  blocked: 'blocked',
  waiting: 'waiting',
  paused: 'paused',
  cancelled: 'cancelled',
  rolled_back: 'rolled back',
};

/**
 * Events that are rows in the Activity log: every tool call, review, plan change, control,
 * decision, resolution and verification. Status changes and messages have their own surfaces.
 */
const LOG_TYPES = new Set<LwEvent['type']>([
  'step.recorded',
  'review.recorded',
  'plan.changed',
  'control.hold',
  'decision.recorded',
  'credential.verified',
  'preview.deployed',
]);

export function isLogEvent(e: LwEvent): boolean {
  if (LOG_TYPES.has(e.type)) return true;
  // Choices made on escalation cards (not raises, deferrals, or re-opens).
  return (
    e.type === 'escalation.updated' && (e.data.status === 'resolved' || e.data.status === 'expired')
  );
}

/** One-line, plain-word summary of an event. */
export function describe(e: LwEvent, lookups: Lookups = IDENTITY): string {
  const names = lookups.agentName;
  switch (e.type) {
    case 'project.created':
      return `Project created for ${e.data.client} on playbook ${e.data.playbook.id}@${e.data.playbook.version}`;
    case 'project.updated':
      if (e.data.buildRepo) return `Build repository ready: ${e.data.buildRepo.repo}`;
      if (e.data.hosting)
        return e.data.hosting.url
          ? `Head live at ${e.data.hosting.url}`
          : `Vercel project ready: ${e.data.hosting.project}`;
      return e.data.sourceUrl
        ? `Source site set to ${e.data.sourceUrl}`
        : 'Project settings updated';
    case 'project.status':
      return `Project ${e.data.status}`;
    case 'phase.entered':
      return `Phase ${e.data.phase} started`;
    case 'phase.exited':
      return `Phase ${e.data.phase} complete`;
    case 'task.planned':
      return `Planned: ${e.data.title}`;
    case 'task.scheduled':
      return `Scheduled: ${lookups.taskTitle(e.data.taskId)}`;
    case 'task.state':
      return `${lookups.taskTitle(e.data.taskId)}: ${TASK_VERB[e.data.to] ?? e.data.to}${e.data.reason ? ` (${e.data.reason})` : ''}`;
    case 'agent.state':
      return `${names(e.data.agentId)}: ${e.data.state}${e.data.now ? ` — ${e.data.now}` : ''}`;
    case 'agent.noted':
      return `${names(e.data.agentId)}: ${e.data.note}`;
    case 'step.recorded':
      return `${names(e.data.agentId)} · ${e.data.operation} → ${e.data.outcome ?? e.data.resultCode} · ${e.data.summary}`;
    case 'review.recorded':
      return `${names(e.data.reviewerId)} ${e.data.verdict === 'accept' ? 'accepted' : 'rejected'} ${e.data.subject}`;
    case 'plan.changed':
      return e.data.summary;
    case 'escalation.raised':
      return `${capitalize(e.data.type)}: ${e.data.title}`;
    case 'escalation.updated':
      return `Escalation ${e.data.escalationId} ${e.data.status}`;
    case 'decision.recorded':
      return `Decision: ${e.data.question} → ${e.data.answer}`;
    case 'cos.message':
      return e.data.title ?? 'Cypher message';
    case 'directive.settled':
      return e.data.summary;
    case 'director.message':
      return 'Director message';
    case 'cos.presence':
      return `Cypher ${e.data.presence}`;
    case 'artifact.versioned':
      return `${e.data.title} v${e.data.version}`;
    case 'metric.updated':
      return `${e.data.key}: ${e.data.value ?? 'not yet measured'}${e.data.total != null ? ` / ${e.data.total}` : ''}`;
    case 'budget.updated':
      return `Spend: $${e.data.spent.usd.toFixed(2)}, ${e.data.spent.tokens.toLocaleString('en-US')} tokens`;
    case 'control.hold':
      return `${e.data.held ? 'Paused' : 'Resumed'}: ${e.data.label}`;
    case 'page.updated':
      return `Page ${e.data.name ?? e.data.pageKey} updated`;
    case 'preview.deployed':
      return `${e.data.side === 'target' ? 'Target' : 'Source'}: ${e.data.label}`;
    case 'credential.registered':
      return `Credential registered: ${e.data.system}`;
    case 'credential.verified':
      return `${e.data.ok ? 'Verified' : 'Verification failed'}: ${e.data.detail}`;
    case 'settings.changed':
      return `Setting ${e.data.key} changed`;
    case 'conventions.recorded':
      return `Conventions recorded (${e.data.entries.length})`;
    case 'tool.health':
      return `${e.data.server} ${e.data.status}`;
  }
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Tool, operation and result columns for the rows that are not tool calls. */
function columns(
  e: LwEvent,
  lookups: Lookups,
): {
  tool: string | null;
  op: string | null;
  outcome: string | null;
  agentId: string | null;
  tokens?: number;
} {
  switch (e.type) {
    case 'step.recorded':
      return {
        tool: lookups.toolLabel?.(e.data.toolServer) ?? e.data.toolServer,
        op: e.data.operation,
        outcome: e.data.outcome ?? String(e.data.resultCode),
        agentId: e.data.agentId,
      };
    case 'review.recorded':
      return {
        tool: 'Review',
        op: `${e.data.verdict} ${e.data.subject}`,
        outcome: e.data.verdict === 'accept' ? 'ok' : 'reject',
        agentId: e.data.reviewerId,
        tokens: e.data.tokens,
      };
    case 'plan.changed':
      return {
        tool: 'Planner',
        op: e.data.summary,
        outcome: 'ok',
        agentId: e.actor.id,
        tokens: e.data.tokens,
      };
    case 'control.hold':
      return {
        tool: 'Control',
        op: `${e.data.held ? 'pause' : 'resume'} ${e.data.label}`,
        outcome: 'ok',
        agentId: null,
      };
    case 'decision.recorded':
      return {
        tool: 'Decision Log',
        op: `append ${e.data.ref ?? lookups.decisionRef?.() ?? ''} ${e.data.question}`.replace(
          /\s+/g,
          ' ',
        ),
        outcome: 'ok',
        agentId: e.actor.kind === 'agent' || e.actor.kind === 'chief_of_staff' ? e.actor.id : null,
      };
    case 'credential.verified':
      return {
        tool: 'Vault',
        op: `verify ${e.data.credentialId}`,
        outcome: e.data.ok ? 'verified' : 'failed',
        agentId: null,
      };
    case 'preview.deployed':
      return {
        tool: lookups.toolLabel?.('hosting') ?? 'Hosting',
        op: `deploy ${e.data.label}`,
        outcome: 'ready',
        agentId: e.actor.kind === 'agent' ? e.actor.id : null,
      };
    case 'escalation.updated': {
      const x = lookups.escalation?.(e.data.escalationId) ?? null;
      const optionId = e.data.resolution?.optionId ?? null;
      const index = x?.options.findIndex((o) => o.id === optionId) ?? -1;
      const key = index >= 0 ? (x!.options[index]!.key ?? String.fromCharCode(65 + index)) : null;
      if (x?.type === 'gate')
        return {
          tool: 'Gate',
          op: `${optionId === 'approve' ? 'approve' : 'send back'} ${x.title}`,
          outcome: 'ok',
          agentId: null,
        };
      return {
        tool: 'Escalation',
        op: `resolve ${e.data.escalationId}${key ? ` with option ${key}` : ''}${e.data.status === 'expired' ? ' (default)' : ''}`,
        outcome: 'ok',
        agentId: null,
      };
    }
    default:
      return { tool: null, op: null, outcome: null, agentId: null };
  }
}

export function toActivityItem(
  e: LwEvent,
  phaseOfTask: (taskId: string) => number | null,
  lookups: Lookups = IDENTITY,
): ActivityItem {
  const step = e.type === 'step.recorded' ? e.data : null;
  const taskId =
    step?.taskId ??
    (e.type === 'task.state' || e.type === 'task.planned' || e.type === 'task.scheduled'
      ? e.data.taskId
      : null) ??
    (e.type === 'agent.state' ? e.data.taskId : null) ??
    (e.type === 'review.recorded' ? e.data.taskId : null);
  const phase =
    e.type === 'phase.entered' || e.type === 'phase.exited'
      ? e.data.phase
      : taskId
        ? phaseOfTask(taskId)
        : null;
  const col = columns(e, lookups);
  return {
    seq: e.seq,
    ts: e.ts,
    type: e.type,
    severity: e.severity,
    phase,
    agentId: col.agentId ?? (e.type === 'agent.state' ? e.data.agentId : null),
    taskId,
    toolServer: step?.toolServer ?? null,
    operation: col.op,
    resultCode: step?.resultCode ?? null,
    durationMs: step?.durationMs ?? null,
    tokens: step?.tokens ?? col.tokens ?? null,
    summary: describe(e, lookups),
    actorId: e.actor.id,
    toolLabel: col.tool,
    outcome: col.outcome,
    note:
      step?.note ??
      (e.type === 'review.recorded' ? e.data.note : null) ??
      (e.type === 'credential.verified' && !e.data.ok ? e.data.detail : null),
  };
}
