import type { ActivityItem } from '@lw/contracts';

/** One CSV cell: quoted when it holds a comma, quote or line break; formulas neutralised. */
export function cell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // A spreadsheet runs a cell starting with = + - @ as a formula; text from agents must not.
  if (/^[=+\-@\t\r]/.test(s) && typeof v === 'string') s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const ACTIVITY_COLUMNS = [
  'seq',
  'time',
  'phase',
  'who',
  'role',
  'task',
  'tool',
  'server',
  'operation',
  'result',
  'code',
  'duration_ms',
  'tokens',
  'severity',
  'event',
  'summary',
  'note',
] as const;

/**
 * The activity log as CSV, oldest first: one row per event, with the full summary and note (the
 * Activity page shortens them). `who` names the agent ("Megan Lee, Layout Engineer") or the actor.
 */
export function activityCsv(
  items: ActivityItem[],
  agent: (agentId: string) => { persona?: string | null; name: string } | undefined,
): string {
  const rows = items.map((i) => {
    const a = i.agentId ? agent(i.agentId) : undefined;
    const who = a ? (a.persona ? `${a.persona}, ${a.name}` : a.name) : i.actorId;
    return [
      i.seq,
      i.ts,
      i.phase,
      who,
      i.agentId,
      i.taskId,
      i.toolLabel,
      i.toolServer,
      i.operation,
      i.outcome,
      i.resultCode,
      i.durationMs,
      i.tokens,
      i.severity,
      i.type,
      i.summary,
      i.note,
    ]
      .map(cell)
      .join(',');
  });
  return [ACTIVITY_COLUMNS.join(','), ...rows].join('\r\n') + '\r\n';
}
