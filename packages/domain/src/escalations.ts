import type { EscalationStatus, EscalationType } from '@lw/contracts';

/**
 * Queue order from the Control Center: Blocker, Access, Decision, Review (gates), Budget, Risk.
 * Access sits with Blockers because a tool the team cannot reach stops work the same way.
 */
const TYPE_RANK: Record<EscalationType, number> = {
  blocker: 0,
  access: 1,
  decision: 2,
  gate: 3,
  budget: 4,
  risk: 5,
};

export const UNRESOLVED: ReadonlySet<EscalationStatus> = new Set(['open', 'deferred']);

export interface Rankable {
  type: EscalationType;
  status: EscalationStatus;
  raisedAt: string;
}

/** Open before deferred, then by type rank, then newest first (what just arrived is on top). */
export function compareEscalations(a: Rankable, b: Rankable): number {
  const deferred = Number(a.status === 'deferred') - Number(b.status === 'deferred');
  if (deferred !== 0) return deferred;
  const rank = TYPE_RANK[a.type] - TYPE_RANK[b.type];
  if (rank !== 0) return rank;
  return b.raisedAt.localeCompare(a.raisedAt);
}
