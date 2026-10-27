import type { EscalationView } from '@lw/contracts';
import { cell } from './activity-csv';

export const ESCALATION_COLUMNS = [
  'escalation',
  'raised',
  'status',
  'type',
  'title',
  'from',
  'task',
  'task_title',
  'phase',
  'context',
  'impact',
  'options',
  'recommended',
  'default_at',
  'deferred_until',
  'resolution',
  'notes',
  'resolved_at',
] as const;

interface TaskInfo {
  title: string;
  phase: number;
  agentId: string;
}

/**
 * Cards for the Director as CSV, oldest first: what each asks, who raised it about which task,
 * the full context, and the options in the letters the card shows (A, B, C, D).
 */
export function escalationsCsv(
  cards: EscalationView[],
  task: (taskId: string) => TaskInfo | undefined,
  agent: (agentId: string) => { persona?: string | null; name: string } | undefined,
): string {
  const letter = (i: number) => String.fromCharCode(65 + i);
  const rows = [...cards]
    .sort((a, b) => a.raisedAt.localeCompare(b.raisedAt))
    .map((c) => {
      const t = c.sourceTaskId ? task(c.sourceTaskId) : undefined;
      const a = t ? agent(t.agentId) : undefined;
      const from = a ? (a.persona ? `${a.persona}, ${a.name}` : a.name) : '';
      const options = c.options.map((o, i) => `${letter(i)}: ${o.label}`).join(' | ');
      const rec = c.options.findIndex((o) => o.recommended);
      const chosen = c.resolution?.optionId
        ? c.options.findIndex((o) => o.id === c.resolution!.optionId)
        : -1;
      return [
        c.escalationId,
        c.raisedAt,
        c.status,
        c.typeLabel ?? c.type,
        c.title,
        from,
        c.sourceTaskId,
        t?.title,
        t?.phase,
        c.context,
        c.impact,
        options,
        rec >= 0 ? letter(rec) : '',
        c.defaultOptionId ? c.deadline : '',
        c.deferredUntil,
        chosen >= 0
          ? `${letter(chosen)} by ${c.resolution!.by}`
          : c.resolution
            ? `${c.status} (${c.resolution.by})`
            : '',
        c.resolution?.notes,
        c.resolvedAt,
      ]
        .map(cell)
        .join(',');
    });
  return [ESCALATION_COLUMNS.join(','), ...rows].join('\r\n') + '\r\n';
}
