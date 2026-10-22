/** Seeded PRNG (mulberry32) so a scenario produces the same durations and token counts every run. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => Math.floor(min + next() * (max - min + 1)),
  };
}
export type Rng = ReturnType<typeof rng>;

export class SimulationStopped extends Error {
  constructor() {
    super('Simulation stopped');
  }
}

/** setTimeout that rejects with SimulationStopped when the signal aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new SimulationStopped());
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new SimulationStopped());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** A latch that callers await while something is paused. */
export class Latch {
  private waiters: (() => void)[] = [];
  closed = false;

  close() {
    this.closed = true;
  }

  open() {
    this.closed = false;
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  wait(signal: AbortSignal): Promise<void> {
    if (!this.closed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new SimulationStopped());
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      });
    });
  }
}
