import type { EscalationStatus, EscalationType } from '@lw/contracts';

/**
 * Queue order from the design spec (§5 dock anatomy): Blocker, Decision, Access, Budget, Risk.
 * Gate approvals sit right after Blockers: they hold the whole engagement.
 */
const TYPE_RANK: Record<EscalationType, number> = {
  blocker: 0,
  gate: 1,
  decision: 2,
  access: 3,
  budget: 4,
  risk: 5,
};

export const UNRESOLVED: ReadonlySet<EscalationStatus> = new Set(['open', 'deferred']);

export interface Rankable {
  type: EscalationType;
  status: EscalationStatus;
  raisedAt: string;
}

/** Open before deferred, then by type rank, then oldest first (age is what makes it urgent). */
export function compareEscalations(a: Rankable, b: Rankable): number {
  const deferred = Number(a.status === 'deferred') - Number(b.status === 'deferred');
  if (deferred !== 0) return deferred;
  const rank = TYPE_RANK[a.type] - TYPE_RANK[b.type];
  if (rank !== 0) return rank;
  return a.raisedAt.localeCompare(b.raisedAt);
}
