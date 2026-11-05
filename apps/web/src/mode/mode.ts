/*
 * Bliss or Everything: one choice for the whole app (design system §2, Dial guideline).
 *
 * Every screen has two faces. Bliss is the default for a new user; once the Director picks a mode it
 * holds on every section they go to until they switch again. (It was remembered per screen at
 * first, which made the mode change under them as they moved; a browser with those older choices
 * starts from the mode it used most.) The choice lives in localStorage first, so the dial answers at
 * once; `GET/PUT /me/preferences` keeps a copy per operator, under the key "app", so it follows the
 * Director to another device. On load the server's copy fills in when this browser has none; this
 * browser's own choice wins. Every change is saved here and sent there.
 *
 * Settings, New project and the pages above any project are Everything only: a Bliss face would
 * hide what the person came to do, so the dial is hidden there and the mode is fixed.
 */
import { useSyncExternalStore } from 'react';
import { API } from '../lib/api';
import { changeMode } from './transition';
import {
  isPortfolioPage,
  useApp,
  type ManagePage,
  type PortfolioPage,
  type Surface,
} from '../state';

export type ModeName = 'bliss' | 'everything';

/** A screen the dial remembers a choice for. */
export type Screen =
  Surface | 'dashboard' | 'new' | `portfolio:${PortfolioPage}` | `manage:${ManagePage}`;

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

/** The key the one choice is kept under, here and on the server. */
const APP = 'app' as Screen;

/** A browser with per-screen choices from before starts from the mode it used most. */
function migrate(c: Partial<Record<Screen, ModeName>>): Partial<Record<Screen, ModeName>> {
  if (c[APP]) return c;
  const picks = Object.values(c);
  if (!picks.length) return c;
  const everything = picks.filter((m) => m === 'everything').length;
  return { ...c, [APP]: everything > picks.length / 2 ? 'everything' : 'bliss' };
}

let choices = migrate(load());
const listeners = new Set<() => void>();

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(choices));
  } catch {
    // Private windows and blocked storage: the choice lasts for this visit.
  }
}

const isMode = (v: unknown): v is ModeName => v === 'bliss' || v === 'everything';

/*
 * The server's copy. Plain fetch, not lib/api: a failure here (signed out, offline, an API without
 * the route) must never redirect or warn; the browser's copy carries on alone.
 */
let pushTimer: ReturnType<typeof setTimeout> | null = null;
function push() {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void fetch(`${API}/me/preferences`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: choices }),
    }).catch(() => {});
  }, 800);
}

let pulled = false;
function pull() {
  if (pulled || typeof fetch !== 'function') return;
  pulled = true;
  void fetch(`${API}/me/preferences`, { credentials: 'include' })
    .then((r) => (r.ok ? (r.json() as Promise<{ mode?: Record<string, unknown> }>) : null))
    .then((body) => {
      if (!body || typeof body.mode !== 'object' || !body.mode) return;
      const server = Object.fromEntries(
        Object.entries(body.mode).filter(([, v]) => isMode(v)),
      ) as Partial<Record<Screen, ModeName>>;
      const merged = migrate({ ...server, ...choices });
      const added = Object.keys(merged).length !== Object.keys(choices).length;
      const behind = Object.keys(merged).some((k) => server[k as Screen] !== merged[k as Screen]);
      if (added) {
        choices = merged;
        save();
        listeners.forEach((fn) => fn());
      }
      // This browser knows screens the server doesn't: send it the whole map.
      if (behind) push();
    })
    .catch(() => {});
}

const store = {
  subscribe(fn: () => void) {
    listeners.add(fn);
    pull();
    return () => listeners.delete(fn);
  },
  get: () => choices,
  set(screen: Screen, mode: ModeName) {
    choices = { ...choices, [screen]: mode };
    save();
    listeners.forEach((fn) => fn());
    push();
  },
};

/** The screen on view: a project surface, or a page above any project. */
export function useScreen(): Screen {
  const { projectId, surface, view } = useApp();
  if (projectId) return surface;
  if (view === 'dashboard' || view === 'new') return view;
  if (isPortfolioPage(view)) return `portfolio:${view}`;
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
  // One choice everywhere; screens with one face show Everything without changing it.
  const stored = all[APP];
  return {
    // Anything but a known mode (an old or hand-edited value) reads as the default.
    mode: fixed ? 'everything' : stored === 'everything' ? 'everything' : 'bliss',
    screen,
    fixed,
    setMode: (next) => {
      if (fixed) return;
      const current = stored === 'everything' ? 'everything' : 'bliss';
      if (next === current) return;
      // The switch plays the eye's transition; the screen changes behind its blur.
      changeMode(next, () => store.set(APP, next));
    },
  };
}
