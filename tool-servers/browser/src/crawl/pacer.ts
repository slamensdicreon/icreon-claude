/**
 * How fast a crawl reads one site: up to `max` requests at once, at least `minDelayMs` between
 * starts, and backing off when the site says to. A 429 or 503 halves how many run at once and
 * pauses everything (for Retry-After when the site gives one, else 5 s, doubling to a minute);
 * a run of successes brings it back up one at a time. A polite crawl the site doesn't throttle
 * twice, rather than a fixed speed it may or may not tolerate.
 */
export class Pacer {
  private limit: number;
  private running = 0;
  private waiting: (() => void)[] = [];
  private nextStart = 0;
  private pausedUntil = 0;
  private streak = 0;
  private backoffs = 0;

  constructor(
    private readonly max: number,
    private readonly minDelayMs = 0,
    private readonly now: () => number = Date.now,
  ) {
    this.limit = Math.max(1, max);
  }

  /** How many requests may run at once now. */
  get concurrency(): number {
    return this.limit;
  }

  /** Runs `fn` when the site's pace allows. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  /** The site throttled us (429, 503): slow down. */
  throttled(retryAfterMs: number | null): void {
    this.streak = 0;
    this.backoffs++;
    this.limit = Math.max(1, Math.floor(this.limit / 2));
    const pause = Math.min(
      120_000,
      retryAfterMs ?? Math.min(60_000, 5_000 * 2 ** Math.min(4, this.backoffs - 1)),
    );
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + pause);
  }

  /** A page read without complaint: after 20 in a row, one more at once. */
  succeeded(): void {
    if (++this.streak < 20) return;
    this.streak = 0;
    if (this.backoffs) this.backoffs--;
    if (this.limit < this.max) {
      this.limit++;
      this.waiting.shift()?.();
    }
  }

  private async acquire(): Promise<void> {
    while (this.running >= this.limit)
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.running++;
    for (;;) {
      const at = Math.max(this.nextStart, this.pausedUntil);
      const wait = at - this.now();
      if (wait <= 0) break;
      await new Promise((r) => setTimeout(r, wait));
    }
    this.nextStart = this.now() + this.minDelayMs;
  }
}
