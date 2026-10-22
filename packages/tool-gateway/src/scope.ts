import type { Bindings } from './types';

/**
 * Resource scopes are path patterns over the target's item tree, e.g.
 * `{sitePath}/Presentation/Available Renderings/**`. `**` matches any number of segments, `*`
 * any run of characters within one segment. Matching is case-insensitive, as Sitecore paths are.
 */

export class ScopeError extends Error {}

/** Canonical form of a path, or a ScopeError. `.` and `..` segments are refused, never resolved. */
export function normalizePath(path: string): string {
  if (typeof path !== 'string' || !path.startsWith('/'))
    throw new ScopeError(`not an absolute path: ${String(path)}`);
  if (/[\\\u0000-\u001f]/.test(path))
    throw new ScopeError('path contains a backslash or control character');
  const segments = path.split('/').filter(Boolean);
  if (segments.some((s) => s === '.' || s === '..'))
    throw new ScopeError('relative segments are not allowed');
  return '/' + segments.join('/');
}

export function bindPattern(pattern: string, bindings: Bindings): string {
  return pattern.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = bindings[key];
    if (value === undefined)
      throw new ScopeError(`scope placeholder {${key}} is not bound for this project`);
    return value;
  });
}

function segmentRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`, 'i');
}

export function matches(pattern: string, path: string): boolean {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  const memo = new Map<string, boolean>();
  const go = (i: number, j: number): boolean => {
    const key = `${i}:${j}`;
    if (memo.has(key)) return memo.get(key)!;
    let result: boolean;
    if (i === p.length) result = j === s.length;
    else if (p[i] === '**') result = go(i + 1, j) || (j < s.length && go(i, j + 1));
    else result = j < s.length && segmentRegex(p[i]!).test(s[j]!) && go(i + 1, j + 1);
    memo.set(key, result);
    return result;
  };
  return go(0, 0);
}

/** True when the path, normalized, falls inside at least one bound pattern. */
export function inScope(path: string, patterns: string[], bindings: Bindings): boolean {
  const normalized = normalizePath(path);
  return patterns.some((p) => matches(normalizePath(bindPattern(p, bindings)), normalized));
}

/** Reads `a.b.c` out of an arguments object; arrays yield every element. */
export function readArg(args: Record<string, unknown>, dotted: string): unknown[] {
  let values: unknown[] = [args];
  for (const key of dotted.split('.')) {
    values = values.flatMap((v) => {
      if (v === null || typeof v !== 'object') return [];
      const next = (v as Record<string, unknown>)[key];
      return Array.isArray(next) ? next : next === undefined ? [] : [next];
    });
  }
  return values;
}
