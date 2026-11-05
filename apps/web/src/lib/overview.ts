/*
 * The portfolio overview (GET /portfolio/overview): one shared copy for the Dashboard, the top bar
 * and the shell, refreshed every few seconds while something reads it and right after a command.
 */
import type { PortfolioOverview } from '@lw/contracts';
import { useEffect, useSyncExternalStore } from 'react';
import { get } from './api';

interface State {
  data: PortfolioOverview | null;
  error: string | null;
}

let state: State = { data: null, error: null };
const listeners = new Set<() => void>();
let readers = 0;
let timer: number | null = null;
let inflight: Promise<void> | null = null;

function emit(next: State) {
  state = next;
  listeners.forEach((fn) => fn());
}

export function refreshOverview(): Promise<void> {
  if (inflight) return inflight;
  inflight = get<PortfolioOverview>('/portfolio/overview')
    .then((data) => {
      // Unchanged data keeps its identity, so nothing re-renders for nothing.
      if (JSON.stringify(data) !== JSON.stringify(state.data)) emit({ data, error: null });
    })
    .catch((err: unknown) => {
      emit({
        ...state,
        error: err instanceof Error ? err.message : 'The overview could not be read.',
      });
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** The overview and its refresh; polls every 8 seconds while any component reads it. */
export function useOverview() {
  const s = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    readers += 1;
    if (readers === 1) {
      void refreshOverview();
      timer = window.setInterval(() => void refreshOverview(), 8000);
    }
    return () => {
      readers -= 1;
      if (readers === 0 && timer !== null) {
        window.clearInterval(timer);
        timer = null;
      }
    };
  }, []);
  return { ...s, refresh: refreshOverview };
}

const WORDS = [
  'no',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
];
/** Counts under thirteen are words (design system §4): "four projects", "61 agents". */
export const count = (n: number, one: string, many = `${one}s`) =>
  `${n < 13 ? WORDS[n] : n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
