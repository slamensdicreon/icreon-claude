/*
 * Switching Bliss and Everything plays a short scene (mode/ModeTransition.tsx): the screen blurs,
 * Cypher's eye wakes wide for Everything or settles for Bliss, and the screen changes behind the
 * blur. Without a mounted scene, under reduced motion, or with the tab hidden, the switch is
 * immediate.
 */
import { prefersReducedMotion } from '../ui/eye/geometry';
import type { ModeName } from './mode';

export interface ModeChange {
  to: ModeName;
  /** Changes the mode; the scene calls it once the screen is blurred. */
  apply: () => void;
}

let host: ((c: ModeChange) => boolean) | null = null;

/** The scene registers here; it returns false when it can't play (one already running). */
export function hostModeTransitions(fn: (c: ModeChange) => boolean) {
  host = fn;
  return () => {
    if (host === fn) host = null;
  };
}

export function changeMode(to: ModeName, apply: () => void) {
  if (!host || prefersReducedMotion() || document.hidden || !host({ to, apply })) apply();
}
