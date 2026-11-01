import { expect, it } from 'vitest';
import { mapLimit } from '../src';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

it('keeps the items order whatever order the calls finish in, and never runs more than the limit', async () => {
  let running = 0;
  let most = 0;
  const out = await mapLimit([30, 5, 20, 1, 10, 2], 3, async (ms, i) => {
    running++;
    most = Math.max(most, running);
    await tick(ms);
    running--;
    return `${i}:${ms}`;
  });
  expect(out).toEqual(['0:30', '1:5', '2:20', '3:1', '4:10', '5:2']);
  expect(most).toBe(3);
});

it('fails with the earliest failing item, and starts nothing after a failure', async () => {
  const started: number[] = [];
  await expect(
    mapLimit([0, 1, 2, 3, 4, 5, 6, 7], 2, async (n) => {
      started.push(n);
      await tick(n === 1 ? 20 : 1);
      if (n === 1 || n === 2) throw new Error(`item ${n}`);
      return n;
    }),
  ).rejects.toThrow('item 1');
  expect(started.length).toBeLessThan(8);
});

it('handles no items', async () => {
  expect(await mapLimit([], 4, async () => 1)).toEqual([]);
});
