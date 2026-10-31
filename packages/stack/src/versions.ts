import type { Activities } from '@lw/orchestrator';

/**
 * One set of activities over several versions of a playbook: each call goes to the version the
 * project was created on (its roles, prompts, grants and checks), or the current one when that
 * version isn't kept. Every activity names its project first, by id or in its request.
 */
export function byVersion(
  current: Activities,
  older: Map<string, Activities>,
  versionOf: (projectId: string) => string | null,
): Activities {
  if (!older.size) return current;
  const pick = (arg: unknown): Activities => {
    const projectId =
      typeof arg === 'string' ? arg : (arg as { projectId?: unknown } | null)?.projectId;
    const version = typeof projectId === 'string' ? versionOf(projectId) : null;
    return (version && older.get(version)) || current;
  };
  return Object.fromEntries(
    (Object.keys(current) as (keyof Activities)[]).map((key) => [
      key,
      (...args: unknown[]) =>
        (pick(args[0])[key] as (...a: unknown[]) => Promise<unknown>)(...args),
    ]),
  ) as unknown as Activities;
}
