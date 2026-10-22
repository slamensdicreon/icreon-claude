import type { LwEvent, PolicyRow, SettingsSnapshot, SinceSummary } from '@lw/contracts';
import { phaseViews, type ProjectState } from './projector';

/** The optional reviews a Director can switch on, by setting key. */
export const OPTIONAL_GATES = [
  { key: 'gates.pilotReview', label: 'Review after the pilot slice', default: true },
  { key: 'gates.publishReview', label: 'Review before publishing to production', default: false },
] as const;

export function optionalGateEnabled(
  s: ProjectState,
  key: (typeof OPTIONAL_GATES)[number]['key'],
): boolean {
  const v = s.settings[key];
  return typeof v === 'boolean' ? v : OPTIONAL_GATES.find((g) => g.key === key)!.default;
}

export function settingsView(s: ProjectState, policyDefaults: PolicyRow[]): SettingsSnapshot {
  const phases = phaseViews(s);
  const overrides = (s.settings.escalationPolicy ?? {}) as Record<string, Partial<PolicyRow>>;
  const directorGates = phases
    .filter((p) => p.gate === 'director')
    .map((p, i) => {
      const approvedAt = s.gateApprovals[p.number] ?? null;
      const waiting = Object.values(s.escalations).some(
        (x) => x.type === 'gate' && x.gate?.phase === p.number && x.status === 'open',
      );
      return {
        key: `gate-${i + 1}`,
        label: p.gateLabel ?? `Gate ${i + 1}: ${p.shortName}`,
        kind: 'director' as const,
        state: approvedAt
          ? ('approved' as const)
          : waiting
            ? ('waiting' as const)
            : ('future' as const),
        phase: p.number,
        at: approvedAt,
        enabled: null,
      };
    });
  const optional = OPTIONAL_GATES.map((g) => ({
    key: g.key,
    label: g.label,
    kind: 'optional' as const,
    state: null,
    phase: null,
    at: null,
    enabled: optionalGateEnabled(s, g.key),
  }));

  // Conventions lock when the first Director gate (the Blueprint) is approved.
  const firstGate = phases.find((p) => p.gate === 'director');
  const lockedAt = firstGate ? (s.gateApprovals[firstGate.number] ?? null) : null;

  const current = phases.filter((p) => p.status === 'current').at(-1) ?? null;
  const done = current
    ? Object.values(s.tasks).filter((t) => t.phase === current.number && t.state === 'done')
    : [];

  return {
    seq: s.seq,
    timezone: s.timezone,
    credentials: Object.values(s.credentials),
    budgets: s.budgets,
    spent: s.spent,
    gates: [...directorGates, ...optional],
    escalationPolicy: policyDefaults.map((row) => ({ ...row, ...overrides[row.type] })),
    conventions: { entries: s.conventions, lockedAt },
    rollback: current
      ? {
          phase: current.number,
          name: current.shortName,
          detail: done.length
            ? `Undoes the ${done.length} completed ${done.length === 1 ? 'task' : 'tasks'} of phase ${current.number}, newest first, each by its rollback recipe.`
            : `Nothing in phase ${current.number} has been completed yet; the phase restarts from its first task.`,
        }
      : null,
  };
}

/** What changed between two points in the log, for "Since you were away". */
export function sinceSummary(
  s: ProjectState,
  events: LwEvent[],
  fromSeq: number,
  now = Date.now(),
): SinceSummary {
  const after = events.filter((e) => e.seq > fromSeq);
  const first = after[0];
  const startSpend = (() => {
    // The spend as of fromSeq: the last budget update at or before it.
    const before = events.filter((e) => e.seq <= fromSeq && e.type === 'budget.updated');
    const last = before.at(-1);
    return last && last.type === 'budget.updated' ? last.data.spent.usd : null;
  })();
  const phase = phaseViews(s).find((p) => p.status === 'current') ?? null;
  return {
    fromSeq,
    toSeq: s.seq,
    minutes: first ? Math.max(0, Math.round((now - Date.parse(first.ts)) / 60_000)) : 0,
    raised: after.filter((e) => e.type === 'escalation.raised').length,
    resolved: after.filter(
      (e) =>
        e.type === 'escalation.updated' &&
        (e.data.status === 'resolved' || e.data.status === 'expired'),
    ).length,
    phase: phase ? { name: phase.shortName, percent: phase.percent ?? 0 } : null,
    usd: startSpend === null ? 0 : Math.max(0, Math.round((s.spent.usd - startSpend) * 100) / 100),
    events: after.length,
  };
}
