import type { ToolResult } from './types';

/** Results of completed calls, by idempotency key. Production: a Postgres table. */
export interface IdempotencyStore {
  get(key: string): Promise<ToolResult | undefined>;
  put(key: string, result: ToolResult): Promise<void>;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly results = new Map<string, ToolResult>();
  async get(key: string) {
    return this.results.get(key);
  }
  async put(key: string, result: ToolResult) {
    this.results.set(key, result);
  }
}

/** Waits until a call against `key` may proceed. Production: Redis, shared by every worker. */
export interface RateLimiter {
  acquire(key: string): Promise<void>;
}

/** Token bucket per key: `capacity` calls in a burst, refilled at `perSecond`. */
export class TokenBucketLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly capacity: number,
    private readonly perSecond: number,
    private readonly now: () => number = Date.now,
  ) {}

  async acquire(key: string): Promise<void> {
    for (;;) {
      const t = this.now();
      const b = this.buckets.get(key) ?? { tokens: this.capacity, at: t };
      b.tokens = Math.min(this.capacity, b.tokens + ((t - b.at) / 1000) * this.perSecond);
      b.at = t;
      this.buckets.set(key, b);
      if (b.tokens >= 1) {
        b.tokens -= 1;
        return;
      }
      await new Promise((r) => setTimeout(r, Math.ceil(((1 - b.tokens) / this.perSecond) * 1000)));
    }
  }
}

/** Mints short-lived, server-scoped credentials. Production: Secrets Manager + per-run tokens. */
export interface CredentialProvider {
  tokenFor(projectId: string, server: string): Promise<string>;
}

/** Whether a task recorded how to undo its effects before doing anything destructive. */
export interface RollbackRegistry {
  hasRecipe(projectId: string, taskId: string): Promise<boolean>;
}
