import type { IntakeValue } from '@lw/contracts';

export type TargetValues = Record<string, IntakeValue>;

/** One text value of a target, for a pack's own use. */
export function text(target: TargetValues, key: string): string {
  const v = target[key];
  return Array.isArray(v) ? v.join(', ') : (v ?? '');
}

/** One list value of a target. */
export function list(target: TargetValues, key: string): string[] {
  const v = target[key];
  return Array.isArray(v) ? v : v ? [v] : [];
}
