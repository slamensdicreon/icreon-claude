import type { IntegrationStore, Projections } from '@lw/events';
import type { OperatorNotice } from './operator';

const KEY = 'watchdog:worker';

interface Told {
  /** When the Director was told the worker had gone silent; null once told it is back. */
  downAt: string | null;
}

export interface WatchdogDeps {
  /** The worker's last heartbeat time (it writes one every 30 s), or null if it never has. */
  lastBeat: () => Promise<string | null>;
  projections: Projections;
  store: IntegrationStore;
  notify?: (n: OperatorNotice) => Promise<unknown>;
  now?: () => Date;
  /** Silent this long while a project runs: down (default 10 minutes). */
  staleMinutes?: number;
}

/**
 * Watches the watcher. The operator runs in the worker, so when the worker stops nothing in it
 * can say so. Called on a schedule from outside the worker (a cron on the API): when the worker
 * has been silent for a while and a live project is running, the Director is told once, and once
 * more when it is back. Nothing runs while it is down: no agent, no card, no operator.
 */
export async function watchWorker(deps: WatchdogDeps): Promise<{
  state: 'ok' | 'down' | 'idle';
  minutesSilent: number | null;
  told: 'down' | 'up' | null;
}> {
  const now = deps.now?.() ?? new Date();
  const stale = deps.staleMinutes ?? 10;
  const beat = await deps.lastBeat();
  const minutesSilent = beat ? Math.round((now.getTime() - Date.parse(beat)) / 60_000) : null;
  await deps.projections.catchUpAll();
  const running = deps.projections
    .all()
    .filter((s) => s.mode === 'live' && s.status === 'running')
    .map((s) => s.name);
  const prior = (await deps.store.get<Told>(KEY)) ?? { downAt: null };
  const silent = minutesSilent === null || minutesSilent >= stale;
  const send = async (n: OperatorNotice) => {
    await deps.notify?.(n);
  };

  if (silent && running.length) {
    if (prior.downAt) return { state: 'down', minutesSilent, told: null };
    await send({
      projectId: '',
      project: 'Launchworks',
      kind: 'down',
      title: 'The agent worker has stopped',
      body: `Launchworks: the agent worker ${beat ? `hasn't been seen for ${minutesSilent} minutes` : 'has never reported'}, while ${running.join(', ')} ${running.length === 1 ? 'is' : 'are'} running. Nothing moves while it is down: no agent works, no card is raised, and the Operator can't watch. Check the worker's deployment and logs on Vercel; the Dashboard's Diagnostics shows when it was last seen.`,
    });
    await deps.store.put(KEY, { downAt: now.toISOString() } satisfies Told);
    return { state: 'down', minutesSilent, told: 'down' };
  }
  if (!silent && prior.downAt) {
    await send({
      projectId: '',
      project: 'Launchworks',
      kind: 'up',
      title: 'The agent worker is back',
      body: `Launchworks: the agent worker is running again (last seen ${minutesSilent} minute${minutesSilent === 1 ? '' : 's'} ago), after it went silent at ${prior.downAt.slice(11, 16)} UTC. Projects carry on where they stopped; the Operator is watching again.`,
    });
    await deps.store.put(KEY, { downAt: null } satisfies Told);
    return { state: 'ok', minutesSilent, told: 'up' };
  }
  return { state: silent ? 'idle' : 'ok', minutesSilent, told: null };
}
