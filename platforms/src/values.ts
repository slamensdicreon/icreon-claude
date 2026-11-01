import type { IntakeValue } from '@lw/contracts';

export type TargetValues = Record<string, IntakeValue>;

/** One text value of a target, for a pack's own use. */
export function text(target: TargetValues, key: string): string {
  const v = target[key];
  return Array.isArray(v) ? v.join(', ') : (v ?? '');
}

/** A host given as a host or a URL ("cms.example.com" or "https://cms.example.com/"), as its host. */
export function hostOf(value: string): string {
  try {
    return new URL(/^https?:\/\//.test(value) ? value : `https://${value}`).host;
  } catch {
    return value;
  }
}

/** One list value of a target. */
export function list(target: TargetValues, key: string): string[] {
  const v = target[key];
  return Array.isArray(v) ? v : v ? [v] : [];
}
