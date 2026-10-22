import type { ActivityItem, LwEvent } from '@lw/contracts';

export interface Lookups {
  agentName: (agentId: string) => string;
  taskTitle: (taskId: string) => string;
}

const IDENTITY: Lookups = { agentName: (id) => id, taskTitle: (id) => id };

const TASK_VERB: Partial<Record<string, string>> = {
  running: 'started',
  validating: 'in validation',
  done: 'done',
  rejected: 'rejected by Lead review',
  blocked: 'blocked',
  paused: 'paused',
  cancelled: 'cancelled',
  rolled_back: 'rolled back',
};

/** One-line, plain-word summary of an event for the Activity log and "Latest from the team". */
export function describe(e: LwEvent, lookups: Lookups = IDENTITY): string {
  const names = lookups.agentName;
  switch (e.type) {
    case 'project.created':
      return `Project created for ${e.data.client} on playbook ${e.data.playbook.id}@${e.data.playbook.version}`;
    case 'project.status':
      return `Project ${e.data.status}`;
    case 'phase.entered':
      return `Phase ${e.data.phase} started`;
    case 'phase.exited':
      return `Phase ${e.data.phase} complete`;
    case 'task.planned':
      return `Planned: ${e.data.title}`;
    case 'task.state':
      return `${lookups.taskTitle(e.data.taskId)}: ${TASK_VERB[e.data.to] ?? e.data.to}${e.data.reason ? ` (${e.data.reason})` : ''}`;
    case 'agent.state':
      return `${names(e.data.agentId)}: ${e.data.state}${e.data.now ? ` — ${e.data.now}` : ''}`;
    case 'step.recorded':
      return `${names(e.data.agentId)} · ${e.data.toolServer}.${e.data.operation} → ${e.data.resultCode} · ${e.data.summary}`;
    case 'escalation.raised':
      return `${capitalize(e.data.type)}: ${e.data.title}`;
    case 'escalation.updated':
      return `Escalation ${e.data.escalationId} ${e.data.status}`;
    case 'decision.recorded':
      return `Decision: ${e.data.question} → ${e.data.answer}`;
    case 'cos.message':
      return e.data.title ?? 'Chief of Staff message';
    case 'director.message':
      return 'Director message';
    case 'cos.presence':
      return `Chief of Staff ${e.data.presence}`;
    case 'artifact.versioned':
      return `${e.data.title} v${e.data.version}`;
    case 'metric.updated':
      return `${e.data.key}: ${e.data.value ?? 'not yet measured'}${e.data.total != null ? ` / ${e.data.total}` : ''}`;
    case 'budget.updated':
      return `Spend: $${e.data.spent.usd.toFixed(2)}, ${e.data.spent.tokens.toLocaleString('en-US')} tokens`;
    case 'tool.health':
      return `${e.data.server} ${e.data.status}`;
  }
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function toActivityItem(
  e: LwEvent,
  phaseOfTask: (taskId: string) => number | null,
  lookups?: Lookups,
): ActivityItem {
  const step = e.type === 'step.recorded' ? e.data : null;
  const taskId =
    step?.taskId ??
    (e.type === 'task.state' || e.type === 'task.planned' ? e.data.taskId : null) ??
    (e.type === 'agent.state' ? e.data.taskId : null);
  const phase =
    e.type === 'phase.entered' || e.type === 'phase.exited'
      ? e.data.phase
      : taskId
        ? phaseOfTask(taskId)
        : null;
  return {
    seq: e.seq,
    ts: e.ts,
    type: e.type,
    severity: e.severity,
    phase,
    agentId: step?.agentId ?? (e.type === 'agent.state' ? e.data.agentId : null),
    taskId,
    toolServer: step?.toolServer ?? null,
    operation: step?.operation ?? null,
    resultCode: step?.resultCode ?? null,
    durationMs: step?.durationMs ?? null,
    tokens: step?.tokens ?? null,
    summary: describe(e, lookups),
  };
}
