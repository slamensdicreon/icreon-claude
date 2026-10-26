import { MockActivityEnvironment } from '@temporalio/testing';
import { describe, expect, it } from 'vitest';
import type { Activities } from '../src';
import { withHeartbeats } from '../src';

describe('withHeartbeats', () => {
  it('heartbeats while a long activity runs, and stops when it ends', async () => {
    const env = new MockActivityEnvironment();
    let beats = 0;
    env.on('heartbeat', () => beats++);
    const slow = {
      async runAgent(ms: number) {
        await new Promise((r) => setTimeout(r, ms));
        return 'done';
      },
    } as unknown as Activities;
    const wrapped = withHeartbeats(slow, 20) as unknown as {
      runAgent(ms: number): Promise<string>;
    };
    await expect(env.run(wrapped.runAgent, 130)).resolves.toBe('done');
    expect(beats).toBeGreaterThanOrEqual(4);
    const after = beats;
    await new Promise((r) => setTimeout(r, 60));
    expect(beats).toBe(after);
  });
});
