/*
 * A resource above any project, read on open and every few seconds while its page is on screen.
 * The portfolio's Team, Workbench, Activity and Scorecard read through it.
 */
import { useEffect, useState } from 'react';
import { get, messageOf } from './api';

export function usePoll<T>(path: string, ms = 10_000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      get<T>(path)
        .then((d) => {
          if (!live) return;
          setData(d);
          setError(null);
        })
        .catch((e: unknown) => live && setError(messageOf(e, 'This page could not be read.')));
    void load();
    const t = window.setInterval(load, ms);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, [path, ms]);
  return { data, error };
}
