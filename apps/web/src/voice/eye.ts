/*
 * The eye's state, derived and never set by hand (design system §3, Eye guideline):
 * needs a word when anything is waiting on the Director, watching when any task is running,
 * resting otherwise. A new item that is the Director's makes it blink once.
 *
 * Inside a project it reads the Mission Control snapshot; above any project, the project list.
 */
import { useEffect, useRef, useState } from 'react';
import { useApp, useMission } from '../state';

export type EyeState = 'resting' | 'watching' | 'needs-a-word';

/** How each state is said, for the eye's accessible name and the word beside it. */
export const EYE_WORDS: Record<EyeState, string> = {
  resting: 'Nothing needs you',
  watching: 'Watching',
  'needs-a-word': 'Needs a word',
};

export interface Eye {
  state: EyeState;
  /** What is the Director's right now. */
  yours: number;
  /** True for the length of one blink after a new item arrives. */
  blink: boolean;
}

export function useEyeState(): Eye {
  const { projectId, projects } = useApp();
  const mc = useMission().data;

  let yours: number;
  let working: boolean;
  let ids: string[];
  if (projectId) {
    const open = mc?.waitingOnYou.filter((x) => x.status === 'open') ?? [];
    yours = open.length;
    working = mc?.phases.some((p) => p.tasksRunning > 0) ?? false;
    ids = open.map((x) => x.escalationId);
  } else {
    yours = projects.reduce((n, p) => n + p.waitingCount, 0);
    working = projects.some((p) => p.status === 'running');
    // The list carries counts, not ids: a count that grows is a new item.
    ids = projects.flatMap((p) => Array.from({ length: p.waitingCount }, (_, i) => `${p.id}:${i}`));
  }
  const state: EyeState = yours > 0 ? 'needs-a-word' : working ? 'watching' : 'resting';

  // Blink when an id appears that wasn't there before, but not on the first load or a switch.
  const seen = useRef<{ scope: string | null; ids: Set<string> } | null>(null);
  const [blink, setBlink] = useState(false);
  const key = ids.join('|');
  useEffect(() => {
    const scope = projectId;
    const prev = seen.current;
    seen.current = { scope, ids: new Set(ids) };
    if (!prev || prev.scope !== scope || (projectId && !mc)) return;
    if (!ids.some((id) => !prev.ids.has(id))) return;
    setBlink(true);
    const t = window.setTimeout(() => setBlink(false), 320);
    return () => window.clearTimeout(t);
    // ids is derived from key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, projectId]);

  return { state, yours, blink };
}
