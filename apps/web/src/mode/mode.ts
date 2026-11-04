/*
 * Bliss or Everything, remembered per screen (design system §2, Dial guideline).
 *
 * Every screen has two faces. Bliss is the default for every new screen and every new user; the
 * Director's choice sticks to the screen it was made on, so Mission Control can live in Everything
 * while the Dashboard stays in Bliss. Choices live in localStorage for now; `GET/PUT
 * /me/preferences` takes over when the API has it (PLAN.md › Backend and contract changes).
 *
 * Settings, New project and the pages above any project are Everything only: a Bliss face would
 * hide what the person came to do, so the dial is hidden there and the mode is fixed.
 */
import { useSyncExternalStore } from 'react';
import { useApp, type ManagePage, type Surface } from '../state';

export type ModeName = 'bliss' | 'everything';

/** A screen the dial remembers a choice for. */
export type Screen = Surface | 'dashboard' | 'new' | `manage:${ManagePage}`;

const KEY = 'cypher.mode';

function load(): Partial<Record<Screen, ModeName>> {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object'
      ? (parsed as Partial<Record<Screen, ModeName>>)
      : {};
  } catch {
    return {};
  }
}

let choices = load();
const listeners = new Set<() => void>();

const store = {
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  get: () => choices,
  set(screen: Screen, mode: ModeName) {
    choices = { ...choices, [screen]: mode };
    try {
      localStorage.setItem(KEY, JSON.stringify(choices));
    } catch {
      // Private windows and blocked storage: the choice lasts for this visit.
    }
    listeners.forEach((fn) => fn());
  },
};

/** The screen on view: a project surface, or a page above any project. */
export function useScreen(): Screen {
  const { projectId, surface, view } = useApp();
  if (projectId) return surface;
  if (view === 'dashboard' || view === 'new') return view;
  return `manage:${view}`;
}

/** Screens with no Bliss face. */
export const isEverythingOnly = (s: Screen) =>
  s === 'settings' || s === 'new' || s.startsWith('manage:');

export interface ModeState {
  mode: ModeName;
  screen: Screen;
  /** True where the screen has one face and the dial is hidden. */
  fixed: boolean;
  setMode: (mode: ModeName) => void;
}

export function useMode(): ModeState {
  const screen = useScreen();
  const all = useSyncExternalStore(store.subscribe, store.get);
  const fixed = isEverythingOnly(screen);
  const stored = all[screen];
  return {
    // Anything but a known mode (an old or hand-edited value) reads as the default.
    mode: fixed ? 'everything' : stored === 'everything' ? 'everything' : 'bliss',
    screen,
    fixed,
    setMode: (mode) => {
      if (!fixed) store.set(screen, mode);
    },
  };
}
