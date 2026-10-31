import type { CheckStanding } from './types';

/**
 * One line for a card: how the automated checks stood on the attempt that ended in it, so the
 * reader (the Director, the Lead's triage, a rule) can tell a loop on passing work from a real
 * failure without opening the log.
 */
export function checksLine(checks: CheckStanding[] | undefined): string {
  if (!checks?.length) return '';
  const by = (status: CheckStanding['status']) =>
    checks.filter((c) => c.status === status).map((c) => c.id);
  const parts: string[] = [];
  const failed = by('fail');
  const passed = by('pass');
  const pending = by('pending');
  if (failed.length) parts.push(`failed: ${failed.join(', ')}`);
  if (passed.length) parts.push(`passed: ${passed.join(', ')}`);
  if (pending.length) parts.push(`pending: ${pending.join(', ')}`);
  return `Checks on the last attempt: ${parts.join('; ')}.`;
}
